import type { GoogleDocsAPI } from '../api/GoogleDocsAPI';
import type { DocumentElement } from '../api/GoogleDocsAPI';

// ─── Suggestion detection ─────────────────────────────────────────────────────

/**
 * Walk all paragraph elements in the document body and count text runs that
 * have non-empty suggestedInsertionIds or suggestedDeletionIds arrays.
 * Each such text run represents one pending suggestion.
 */
function countSuggestions(content: DocumentElement[]): number {
  let count = 0;

  for (const element of content) {
    if (!element.paragraph) continue;
    for (const pe of element.paragraph.elements) {
      const tr = pe.textRun as (typeof pe.textRun & {
        suggestedInsertionIds?: string[];
        suggestedDeletionIds?: string[];
      }) | undefined;

      if (!tr) continue;
      if (tr.suggestedInsertionIds && tr.suggestedInsertionIds.length > 0) count++;
      else if (tr.suggestedDeletionIds && tr.suggestedDeletionIds.length > 0) count++;
    }
  }

  return count;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Detect open comments and pending suggestions in a Google Doc.
 *
 * - Comments: calls `api.listComments(docId)` — counts entries where the
 *   comment is neither resolved nor deleted.
 * - Suggestions: calls `api.getDocument(docId)` — walks paragraph elements
 *   and counts text runs with non-empty suggestedInsertionIds or
 *   suggestedDeletionIds.
 *
 * Both calls are made in parallel for efficiency.
 */
export async function detectConflicts(
  api: GoogleDocsAPI,
  docId: string,
): Promise<{ comments: number; suggestions: number }> {
  const [commentList, doc] = await Promise.all([
    api.listComments(docId),
    api.getDocument(docId),
  ]);

  const comments = commentList.filter(
    (c) => !c.resolved && !c.deleted,
  ).length;

  const suggestions = countSuggestions(doc.body.content);

  return { comments, suggestions };
}
