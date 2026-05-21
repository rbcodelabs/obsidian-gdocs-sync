import { describe, it, expect } from 'vitest';
import { gdocsToMarkdown } from '../../src/converter/GDocsToMarkdown';
import type { GoogleDocument } from '../../src/api/GoogleDocsAPI';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function para(
  text: string,
  style: string = 'NORMAL_TEXT',
  textStyle: Record<string, unknown> = {},
): GoogleDocument['body']['content'][number] {
  return {
    paragraph: {
      paragraphStyle: { namedStyleType: style },
      elements: [{ textRun: { content: text + '\n', textStyle } }],
    },
  };
}

function listPara(
  text: string,
  listId: string,
  nestingLevel = 0,
): GoogleDocument['body']['content'][number] {
  return {
    paragraph: {
      elements: [{ textRun: { content: text + '\n', textStyle: {} } }],
      bullet: { listId, nestingLevel },
    },
  };
}

function checkboxPara(
  text: string,
  listId: string,
  checked: boolean,
  useCheckboxState = false,
): GoogleDocument['body']['content'][number] {
  return {
    paragraph: {
      paragraphStyle: useCheckboxState
        ? { checkboxState: checked ? 'CHECKED' : 'UNCHECKED' }
        : undefined,
      elements: [{
        textRun: {
          content: text + '\n',
          textStyle: checked ? { strikethrough: true } : {},
        },
      }],
      bullet: { listId, nestingLevel: 0 },
    },
  };
}

// Checkbox list definition: no glyphSymbol, no ordered glyphType
const checkboxList = { listProperties: { nestingLevels: [{}] } };

function monoPara(text: string): GoogleDocument['body']['content'][number] {
  return {
    paragraph: {
      elements: [{
        textRun: {
          content: text + '\n',
          textStyle: { weightedFontFamily: { fontFamily: 'Courier New' } },
        },
      }],
    },
  };
}

function doc(content: GoogleDocument['body']['content'], lists?: GoogleDocument['lists']): GoogleDocument {
  return {
    documentId: 'test',
    title: 'Test',
    revisionId: '1',
    body: { content },
    lists,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('gdocsToMarkdown', () => {

  describe('headings', () => {
    it('converts HEADING_1 through HEADING_6', () => {
      for (let i = 1; i <= 6; i++) {
        const style = `HEADING_${i}`;
        const result = gdocsToMarkdown(doc([para('Hello', style)]));
        expect(result).toBe(`${'#'.repeat(i)} Hello`);
      }
    });

    it('converts TITLE as H1 and SUBTITLE as H2', () => {
      expect(gdocsToMarkdown(doc([para('My Title', 'TITLE')]))).toBe('# My Title');
      expect(gdocsToMarkdown(doc([para('My Sub', 'SUBTITLE')]))).toBe('## My Sub');
    });
  });

  describe('inline styles', () => {
    it('renders bold text', () => {
      const d = doc([{
        paragraph: {
          elements: [{ textRun: { content: 'bold text\n', textStyle: { bold: true } } }],
        },
      }]);
      expect(gdocsToMarkdown(d)).toBe('**bold text**');
    });

    it('renders italic text', () => {
      const d = doc([{
        paragraph: {
          elements: [{ textRun: { content: 'italic\n', textStyle: { italic: true } } }],
        },
      }]);
      expect(gdocsToMarkdown(d)).toBe('*italic*');
    });

    it('renders bold+italic text', () => {
      const d = doc([{
        paragraph: {
          elements: [{ textRun: { content: 'both\n', textStyle: { bold: true, italic: true } } }],
        },
      }]);
      expect(gdocsToMarkdown(d)).toBe('***both***');
    });

    it('renders strikethrough', () => {
      const d = doc([{
        paragraph: {
          elements: [{ textRun: { content: 'struck\n', textStyle: { strikethrough: true } } }],
        },
      }]);
      expect(gdocsToMarkdown(d)).toBe('~~struck~~');
    });

    it('renders inline code via monospace font', () => {
      const d = doc([{
        paragraph: {
          elements: [
            { textRun: { content: 'use ', textStyle: {} } },
            { textRun: { content: 'myFunc()', textStyle: { weightedFontFamily: { fontFamily: 'Courier New' } } } },
            { textRun: { content: ' here\n', textStyle: {} } },
          ],
        },
      }]);
      expect(gdocsToMarkdown(d)).toBe('use `myFunc()` here');
    });

    it('renders links', () => {
      const d = doc([{
        paragraph: {
          elements: [{ textRun: { content: 'click here\n', textStyle: { link: { url: 'https://example.com' } } } }],
        },
      }]);
      expect(gdocsToMarkdown(d)).toBe('[click here](https://example.com)');
    });
  });

  describe('code blocks', () => {
    it('wraps consecutive monospace paragraphs in a fenced code block', () => {
      const result = gdocsToMarkdown(doc([
        monoPara('const x = 1;'),
        monoPara('const y = 2;'),
      ]));
      expect(result).toBe('```\nconst x = 1;\nconst y = 2;\n```');
    });

    it('closes code block before a normal paragraph', () => {
      const result = gdocsToMarkdown(doc([
        monoPara('code here'),
        para('normal text'),
      ]));
      expect(result).toContain('```\ncode here\n```');
      expect(result).toContain('normal text');
    });
  });

  describe('lists', () => {
    it('renders unordered lists with - prefix', () => {
      const result = gdocsToMarkdown(doc(
        [listPara('Alpha', 'list1'), listPara('Beta', 'list1')],
        { list1: { listProperties: { nestingLevels: [{ glyphSymbol: '•' }] } } },
      ));
      expect(result).toBe('- Alpha\n- Beta');
    });

    it('renders ordered lists with 1. prefix', () => {
      const result = gdocsToMarkdown(doc(
        [listPara('First', 'list1'), listPara('Second', 'list1')],
        { list1: { listProperties: { nestingLevels: [{ glyphType: 'DECIMAL' }] } } },
      ));
      expect(result).toBe('1. First\n1. Second');
    });

    it('renders unchecked task list items as - [ ]', () => {
      const result = gdocsToMarkdown(doc(
        [checkboxPara('Buy milk', 'cb1', false)],
        { cb1: checkboxList },
      ));
      expect(result).toBe('- [ ] Buy milk');
    });

    it('renders checked task list items as - [x] via strikethrough', () => {
      const result = gdocsToMarkdown(doc(
        [checkboxPara('Done thing', 'cb1', true)],
        { cb1: checkboxList },
      ));
      expect(result).toBe('- [x] Done thing');
    });

    it('renders checked task list items as - [x] via checkboxState', () => {
      const result = gdocsToMarkdown(doc(
        [checkboxPara('Done thing', 'cb1', true, true)],
        { cb1: checkboxList },
      ));
      expect(result).toBe('- [x] Done thing');
    });

    it('does not emit ~~strikethrough~~ for checked items', () => {
      const result = gdocsToMarkdown(doc(
        [checkboxPara('Packed', 'cb1', true)],
        { cb1: checkboxList },
      ));
      expect(result).not.toContain('~~');
      expect(result).toBe('- [x] Packed');
    });

    it('renders a mixed checked/unchecked list', () => {
      const result = gdocsToMarkdown(doc(
        [
          checkboxPara('tent', 'cb1', true),
          checkboxPara('sleeping bag', 'cb1', false),
          checkboxPara('lantern', 'cb1', true),
        ],
        { cb1: checkboxList },
      ));
      expect(result).toBe('- [x] tent\n- [ ] sleeping bag\n- [x] lantern');
    });

    it('does not treat checkbox lists as regular bullets', () => {
      const result = gdocsToMarkdown(doc(
        [checkboxPara('item', 'cb1', false)],
        { cb1: checkboxList },
      ));
      expect(result).not.toMatch(/^- item/);
    });

    it('indents nested list items', () => {
      const result = gdocsToMarkdown(doc(
        [
          listPara('Parent', 'list1', 0),
          listPara('Child', 'list1', 1),
        ],
        { list1: { listProperties: { nestingLevels: [{ glyphSymbol: '•' }, { glyphSymbol: '◦' }] } } },
      ));
      expect(result).toBe('- Parent\n  - Child');
    });
  });

  describe('document structure', () => {
    it('skips the structural empty first paragraph', () => {
      const result = gdocsToMarkdown(doc([
        para(''),
        para('Real content'),
      ]));
      expect(result).toBe('Real content');
    });

    it('separates paragraphs with blank lines', () => {
      const result = gdocsToMarkdown(doc([
        para('First'),
        para('Second'),
      ]));
      expect(result).toBe('First\n\nSecond');
    });

    it('returns empty string for a document with no content', () => {
      expect(gdocsToMarkdown(doc([]))).toBe('');
    });

    it('trims leading and trailing blank lines', () => {
      const result = gdocsToMarkdown(doc([
        para(''),
        para(''),
        para('Content'),
        para(''),
      ]));
      expect(result).toBe('Content');
    });
  });
});
