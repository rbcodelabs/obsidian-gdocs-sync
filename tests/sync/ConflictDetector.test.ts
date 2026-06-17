import { describe, it, expect, vi } from 'vitest';
import { detectConflicts } from '../../src/sync/ConflictDetector';

// ─── Mock GoogleDocsAPI ───────────────────────────────────────────────────────

/**
 * Build a minimal mock of GoogleDocsAPI with controllable return values
 * for getDocument and listComments.
 */
function makeApi({
  comments = [] as Array<{ resolved: boolean; deleted: boolean }>,
  documentElements = [] as Array<object>,
} = {}) {
  return {
    listComments: vi.fn().mockResolvedValue(comments),
    getDocument: vi.fn().mockResolvedValue({
      documentId: 'doc123',
      title: 'Test',
      revisionId: 'rev1',
      body: { content: documentElements },
    }),
  };
}

// ─── Helper to build document elements with suggestions ───────────────────────

function paragraphWithSuggestedInsertion(id: string) {
  return {
    paragraph: {
      elements: [
        {
          textRun: {
            content: 'suggested text',
            suggestedInsertionIds: [id],
          },
        },
      ],
    },
  };
}

function paragraphWithSuggestedDeletion(id: string) {
  return {
    paragraph: {
      elements: [
        {
          textRun: {
            content: 'deleted text',
            suggestedDeletionIds: [id],
          },
        },
      ],
    },
  };
}

function normalParagraph() {
  return {
    paragraph: {
      elements: [
        {
          textRun: {
            content: 'normal text',
          },
        },
      ],
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('detectConflicts — no comments, no suggestions', () => {
  it('returns { comments: 0, suggestions: 0 } when everything is clean', async () => {
    const api = makeApi({
      comments: [],
      documentElements: [normalParagraph()],
    });

    const result = await detectConflicts(api as never, 'doc123');

    expect(result).toEqual({ comments: 0, suggestions: 0 });
    expect(api.listComments).toHaveBeenCalledWith('doc123');
    expect(api.getDocument).toHaveBeenCalledWith('doc123');
  });
});

describe('detectConflicts — comments only', () => {
  it('counts only unresolved, non-deleted comments', async () => {
    const api = makeApi({
      comments: [
        { resolved: false, deleted: false }, // active — count this
        { resolved: true, deleted: false },  // resolved — skip
        { resolved: false, deleted: true },  // deleted — skip
        { resolved: false, deleted: false }, // active — count this
      ],
      documentElements: [],
    });

    const result = await detectConflicts(api as never, 'doc123');

    expect(result.comments).toBe(2);
    expect(result.suggestions).toBe(0);
  });

  it('returns 0 when all comments are resolved', async () => {
    const api = makeApi({
      comments: [
        { resolved: true, deleted: false },
        { resolved: true, deleted: false },
      ],
    });

    const result = await detectConflicts(api as never, 'doc123');
    expect(result.comments).toBe(0);
  });

  it('returns 0 when all comments are deleted', async () => {
    const api = makeApi({
      comments: [
        { resolved: false, deleted: true },
      ],
    });

    const result = await detectConflicts(api as never, 'doc123');
    expect(result.comments).toBe(0);
  });
});

describe('detectConflicts — suggestions only', () => {
  it('counts paragraphs with suggestedInsertionIds', async () => {
    const api = makeApi({
      comments: [],
      documentElements: [
        paragraphWithSuggestedInsertion('ins1'),
        normalParagraph(),
        paragraphWithSuggestedInsertion('ins2'),
      ],
    });

    const result = await detectConflicts(api as never, 'doc123');

    expect(result.comments).toBe(0);
    expect(result.suggestions).toBe(2);
  });

  it('counts paragraphs with suggestedDeletionIds', async () => {
    const api = makeApi({
      comments: [],
      documentElements: [
        paragraphWithSuggestedDeletion('del1'),
        normalParagraph(),
      ],
    });

    const result = await detectConflicts(api as never, 'doc123');

    expect(result.suggestions).toBe(1);
  });

  it('counts each element that has a suggestion (not deduplicated by textRun)', async () => {
    // Two separate paragraphs each with one suggestion element
    const api = makeApi({
      comments: [],
      documentElements: [
        paragraphWithSuggestedInsertion('ins1'),
        paragraphWithSuggestedDeletion('del1'),
      ],
    });

    const result = await detectConflicts(api as never, 'doc123');
    expect(result.suggestions).toBe(2);
  });
});

describe('detectConflicts — comments and suggestions', () => {
  it('returns both counts when both are present', async () => {
    const api = makeApi({
      comments: [
        { resolved: false, deleted: false },
        { resolved: false, deleted: false },
      ],
      documentElements: [
        paragraphWithSuggestedInsertion('ins1'),
        normalParagraph(),
      ],
    });

    const result = await detectConflicts(api as never, 'doc123');

    expect(result.comments).toBe(2);
    expect(result.suggestions).toBe(1);
  });
});

describe('detectConflicts — edge cases', () => {
  it('handles empty document body gracefully', async () => {
    const api = makeApi({ comments: [], documentElements: [] });
    const result = await detectConflicts(api as never, 'doc123');
    expect(result).toEqual({ comments: 0, suggestions: 0 });
  });

  it('ignores non-paragraph elements (sectionBreak, table, etc.)', async () => {
    const api = makeApi({
      comments: [],
      documentElements: [
        { sectionBreak: {} },
        { table: {} },
        normalParagraph(),
      ],
    });

    const result = await detectConflicts(api as never, 'doc123');
    expect(result).toEqual({ comments: 0, suggestions: 0 });
  });

  it('ignores textRuns with empty suggestedInsertionIds arrays', async () => {
    const api = makeApi({
      comments: [],
      documentElements: [
        {
          paragraph: {
            elements: [
              {
                textRun: {
                  content: 'text',
                  suggestedInsertionIds: [],  // empty — not a suggestion
                },
              },
            ],
          },
        },
      ],
    });

    const result = await detectConflicts(api as never, 'doc123');
    expect(result.suggestions).toBe(0);
  });
});
