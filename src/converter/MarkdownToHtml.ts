import { marked } from 'marked';
import type { App } from 'obsidian';

// ─── MIME type lookup ─────────────────────────────────────────────────────────

const EXT_TO_MIME: Record<string, string> = {
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  gif:  'image/gif',
  webp: 'image/webp',
  svg:  'image/svg+xml',
  bmp:  'image/bmp',
};

function mimeForExtension(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return EXT_TO_MIME[ext] ?? 'application/octet-stream';
}

// ─── URL helpers ──────────────────────────────────────────────────────────────

function isExternalUrl(src: string): boolean {
  return src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:');
}

/**
 * Resolve an image reference to a vault path.
 * If the src has no folder component, prepend noteFolder.
 */
function resolveVaultPath(src: string, noteFolder: string): string {
  // Already has a folder separator — treat as vault-relative
  if (src.includes('/')) return src;
  // Bare filename — resolve relative to noteFolder
  if (noteFolder) return `${noteFolder}/${src}`;
  return src;
}

// ─── Binary → base64 ─────────────────────────────────────────────────────────

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ─── Pre-processing: wikilink images → standard Markdown images ───────────────

/**
 * Rewrite Obsidian wikilink images (`![[filename.png]]`) to standard Markdown
 * image syntax (`![filename.png](filename.png)`) before passing to marked.
 * The src becomes the filename (with optional path), which the image resolver
 * will then handle through the same path as standard images.
 */
function expandWikilinkImages(markdown: string): string {
  return markdown.replace(/!\[\[([^\]]+)\]\]/g, (_match, inner: string) => {
    // inner may be "image.png" or "assets/image.png"
    const filename = inner.trim();
    return `![${filename}](${filename})`;
  });
}

// ─── Image resolution ─────────────────────────────────────────────────────────

/**
 * Given an image src and the vault App, attempt to read the file as binary and
 * return a base64 data URI. Returns null if the file is not found in the vault.
 */
async function resolveLocalImage(
  src: string,
  app: App,
  noteFolder: string,
): Promise<string | null> {
  const vaultPath = resolveVaultPath(src, noteFolder);
  const file = app.vault.getFileByPath(vaultPath);
  if (!file) return null;

  const buffer = await app.vault.readBinary(file as never);
  const b64 = arrayBufferToBase64(buffer);
  const mime = mimeForExtension(vaultPath);
  return `data:${mime};base64,${b64}`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Convert a Markdown string to HTML, embedding local vault images as base64
 * data URIs. External image URLs are passed through unchanged.
 *
 * @param markdown  The Markdown content to convert.
 * @param app       The Obsidian App object (used to read local image files).
 * @param noteFolder  The vault-relative folder of the current note (used to
 *                    resolve relative image paths).
 */
export async function markdownToHtml(
  markdown: string,
  app: App,
  noteFolder: string,
): Promise<string> {
  // Step 1: rewrite Obsidian wikilink images to standard Markdown image syntax
  const expanded = expandWikilinkImages(markdown);

  // Step 2: collect all image references and resolve local ones to base64
  //         before running through marked, so the renderer sees the final srcs.
  const imageMap = new Map<string, string>(); // original src → resolved src

  const imgPattern = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;

  while ((match = imgPattern.exec(expanded)) !== null) {
    const src = match[2];
    if (isExternalUrl(src)) continue; // pass through
    if (imageMap.has(src)) continue;  // already resolved

    const dataUri = await resolveLocalImage(src, app, noteFolder);
    if (dataUri) imageMap.set(src, dataUri);
    // If not found, leave as-is (markdown will keep the relative path)
  }

  // Step 3: rewrite the expanded markdown so local srcs become data URIs
  const rewritten = expanded.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, src) => {
    const resolved = imageMap.get(src);
    return resolved ? `![${alt}](${resolved})` : `![${alt}](${src})`;
  });

  // Step 4: parse with marked (GFM enabled by default in marked v5+)
  const html = await marked.parse(rewritten, {
    gfm: true,
    breaks: false,
  });

  return html;
}
