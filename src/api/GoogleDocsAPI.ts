import { TokenStore } from '../auth/TokenStore';

// ─── Google Docs / Drive type definitions ────────────────────────────────────

export type TextStyle = {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  link?: { url: string };
  weightedFontFamily?: { fontFamily: string };
};

export type ParagraphElement = {
  startIndex?: number;
  endIndex?: number;
  textRun?: { content: string; textStyle?: TextStyle };
  inlineObjectElement?: object;
};

export type Paragraph = {
  elements: ParagraphElement[];
  paragraphStyle?: { namedStyleType?: string };
  bullet?: { listId: string; nestingLevel?: number };
};

export type DocumentElement = {
  startIndex?: number;
  endIndex?: number;
  paragraph?: Paragraph;
  table?: object;
  sectionBreak?: object;
  tableOfContents?: object;
};

// List type info — needed to detect ordered vs unordered lists in GDocsToMarkdown
export type ListNestingLevel = {
  glyphType?: string;    // 'DECIMAL' | 'ALPHA' | 'ROMAN' | 'UPPER_ALPHA' | 'UPPER_ROMAN' | 'ZERO_DECIMAL'
  glyphSymbol?: string;  // e.g. '•', '○' — present for bullet lists
  glyphFormat?: string;  // e.g. '%0.'
};

export type DocumentList = {
  listProperties: {
    nestingLevels: ListNestingLevel[];
  };
};

export type GoogleDocument = {
  documentId: string;
  title: string;
  body: { content: DocumentElement[] };
  revisionId: string;
  lists?: Record<string, DocumentList>;
};

// ─── Drive API types ─────────────────────────────────────────────────────────

export type DriveFile = {
  id: string;
  name: string;
  modifiedTime: string;
  relativePath: string; // vault-relative path within the import root, e.g. "Taxes/2024.md"
};

type DriveItem = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
};

// ─── API client ──────────────────────────────────────────────────────────────

const DOCS_BASE = 'https://docs.googleapis.com/v1/documents';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';

export class GoogleDocsAPI {
  constructor(private tokenStore: TokenStore) {}

  private async authHeaders(): Promise<HeadersInit> {
    const token = await this.tokenStore.getValidAccessToken();
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  private async request<T>(
    url: string,
    options: RequestInit = {},
  ): Promise<T> {
    const headers = await this.authHeaders();
    const response = await fetch(url, {
      ...options,
      headers: { ...headers, ...(options.headers ?? {}) },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Google API error ${response.status} ${response.statusText}: ${body}`,
      );
    }

    // 204 No Content — nothing to parse
    if (response.status === 204) return undefined as unknown as T;

    return response.json() as Promise<T>;
  }

  /**
   * Fetch the full document body for a given Doc ID.
   */
  async getDocument(docId: string): Promise<GoogleDocument> {
    return this.request<GoogleDocument>(`${DOCS_BASE}/${docId}`);
  }

  /**
   * Create a new Google Doc with the given title.
   * Returns the new document ID and its canonical URL.
   */
  async createDocument(
    title: string,
  ): Promise<{ documentId: string; documentUrl: string }> {
    const doc = await this.request<GoogleDocument>(DOCS_BASE, {
      method: 'POST',
      body: JSON.stringify({ title }),
    });

    return {
      documentId: doc.documentId,
      documentUrl: `https://docs.google.com/document/d/${doc.documentId}/edit`,
    };
  }

  /**
   * Apply a list of batchUpdate requests to a document.
   * @see https://developers.google.com/docs/api/reference/rest/v1/documents/batchUpdate
   */
  async batchUpdate(docId: string, requests: object[]): Promise<void> {
    await this.request<unknown>(`${DOCS_BASE}/${docId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests }),
    });
  }

  /**
   * Returns the document's revisionId from the Docs API.
   * Changes on every edit — used to detect remote changes without downloading
   * the full document body. Uses the documents scope (not Drive API) so it
   * works with the drive.file scope we request.
   */
  async getDocumentRevision(docId: string): Promise<string> {
    const data = await this.request<{ revisionId: string }>(
      `${DOCS_BASE}/${docId}?fields=revisionId`,
    );
    return data.revisionId;
  }

  /**
   * Extract a Drive folder ID from a folder URL or return the raw ID as-is.
   * Handles both:
   *   https://drive.google.com/drive/folders/<id>
   *   https://drive.google.com/drive/u/0/folders/<id>
   */
  static parseFolderId(urlOrId: string): string {
    const match = urlOrId.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : urlOrId.trim();
  }

  /**
   * Fetch the name of a Drive folder by its ID.
   * Requires drive.readonly scope.
   */
  async getFolderName(folderId: string): Promise<string> {
    const data = await this.request<{ name: string }>(
      `${DRIVE_BASE}/files/${folderId}?fields=name`,
    );
    return data.name;
  }

  /**
   * Recursively list all Google Docs inside a Drive folder and its subfolders.
   * Returns a flat array where each entry includes a relativePath mirroring the
   * Drive subfolder structure, e.g. "Taxes/2024 Return" for a doc two levels deep.
   * Requires drive.metadata.readonly scope.
   */
  async listDocsInFolder(folderId: string, pathPrefix = ''): Promise<DriveFile[]> {
    const query = encodeURIComponent(
      `'${folderId}' in parents and trashed=false`,
    );
    const fields = 'files(id,name,mimeType,modifiedTime)';
    const url = `${DRIVE_BASE}/files?q=${query}&fields=${fields}&orderBy=name&pageSize=200`;

    const data = await this.request<{ files: DriveItem[] }>(url);
    const items = data.files ?? [];

    const docs: DriveFile[] = [];

    for (const item of items) {
      if (item.mimeType === 'application/vnd.google-apps.document') {
        docs.push({
          id: item.id,
          name: item.name,
          modifiedTime: item.modifiedTime,
          relativePath: pathPrefix ? `${pathPrefix}/${item.name}` : item.name,
        });
      } else if (item.mimeType === 'application/vnd.google-apps.folder') {
        // Recurse into subfolders, building up the relative path
        const subPath = pathPrefix ? `${pathPrefix}/${item.name}` : item.name;
        const subDocs = await this.listDocsInFolder(item.id, subPath);
        docs.push(...subDocs);
      }
    }

    return docs;
  }

  /**
   * Replaces all body content in a document.
   *
   * Strategy: insert a newline at index 1 to ensure there is at least one
   * character, then delete everything from index 1 to the end of the current
   * body. This is the canonical pattern for clearing a Google Doc via the
   * Docs API since you cannot delete the very last newline (the body always
   * ends with a structural newline that cannot be removed).
   */
  async clearDocument(docId: string): Promise<void> {
    // First fetch current end index so we know what to delete
    const doc = await this.getDocument(docId);
    const content = doc.body.content;

    // Find the last endIndex in the document body
    let endIndex = 1;
    for (const element of content) {
      if (element.endIndex !== undefined && element.endIndex > endIndex) {
        endIndex = element.endIndex;
      }
    }

    // A new doc has one structural paragraph: sectionBreak (0→1) + newline paragraph (1→2).
    // We delete from startIndex 1 to endIndex - 1. If that range is empty (i.e.
    // endIndex - 1 <= 1, meaning endIndex <= 2), there is nothing to delete.
    if (endIndex <= 2) return;

    await this.batchUpdate(docId, [
      {
        deleteContentRange: {
          range: {
            startIndex: 1,
            // The last character (endIndex - 1) is the structural newline —
            // we must not delete it, so we delete up to endIndex - 1.
            endIndex: endIndex - 1,
          },
        },
      },
    ]);
  }
}
