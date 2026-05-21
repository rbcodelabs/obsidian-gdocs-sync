import { describe, it, expect } from 'vitest';
import { markdownToGDocsRequests } from '../../src/converter/MarkdownToGDocs';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function insertTexts(requests: object[]): string[] {
  return requests
    .filter((r: any) => r.insertText)
    .map((r: any) => r.insertText.text);
}

function hasStyle(requests: object[], field: string): boolean {
  return requests.some((r: any) => {
    const ts = r.updateTextStyle?.textStyle;
    if (!ts) return false;
    return field in ts;
  });
}

function hasParagraphStyle(requests: object[], style: string): boolean {
  return requests.some((r: any) =>
    r.updateParagraphStyle?.paragraphStyle?.namedStyleType === style,
  );
}

function hasBullet(requests: object[], ordered: boolean): boolean {
  return requests.some((r: any) => {
    const bp = r.createParagraphBullets?.bulletPreset ?? '';
    return ordered ? bp.startsWith('NUMBERED') : bp.startsWith('BULLET');
  });
}

/** Return the insertText index values in order. */
function insertIndices(requests: object[]): number[] {
  return requests
    .filter((r: any) => r.insertText)
    .map((r: any) => r.insertText.location.index as number);
}

/** Return all createParagraphBullets range end-indices. */
function bulletRangeEnds(requests: object[]): number[] {
  return requests
    .filter((r: any) => r.createParagraphBullets)
    .map((r: any) => r.createParagraphBullets.range.endIndex as number);
}

/** Return true if any updateParagraphStyle sets indentStart for the given nesting level. */
function hasIndentAtLevel(requests: object[], nestingLevel: number): boolean {
  const expectedMagnitude = 36 * nestingLevel;
  return requests.some((r: any) => {
    const ps = r.updateParagraphStyle?.paragraphStyle;
    return ps?.indentStart?.magnitude === expectedMagnitude;
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('markdownToGDocsRequests', () => {

  describe('headings', () => {
    it('produces HEADING_1 through HEADING_6 paragraph styles', () => {
      for (let i = 1; i <= 6; i++) {
        const reqs = markdownToGDocsRequests(`${'#'.repeat(i)} Heading`);
        expect(hasParagraphStyle(reqs, `HEADING_${i}`)).toBe(true);
      }
    });

    it('inserts the heading text without the # prefix', () => {
      const reqs = markdownToGDocsRequests('## Section Title');
      const texts = insertTexts(reqs);
      expect(texts.some(t => t.includes('Section Title'))).toBe(true);
      expect(texts.some(t => t.includes('#'))).toBe(false);
    });
  });

  describe('inline styles', () => {
    it('applies bold for **text**', () => {
      const reqs = markdownToGDocsRequests('Hello **world**');
      expect(hasStyle(reqs, 'bold')).toBe(true);
    });

    it('applies italic for *text*', () => {
      const reqs = markdownToGDocsRequests('Hello *world*');
      expect(hasStyle(reqs, 'italic')).toBe(true);
    });

    it('applies both bold and italic for ***text***', () => {
      const reqs = markdownToGDocsRequests('***important***');
      const styleReq = reqs.find((r: any) => r.updateTextStyle?.textStyle?.bold) as any;
      expect(styleReq?.updateTextStyle?.textStyle?.italic).toBe(true);
    });

    it('applies strikethrough for ~~text~~', () => {
      const reqs = markdownToGDocsRequests('~~deleted~~');
      expect(hasStyle(reqs, 'strikethrough')).toBe(true);
    });

    it('applies Courier New font for `code`', () => {
      const reqs = markdownToGDocsRequests('use `myFunc()` here');
      expect(hasStyle(reqs, 'weightedFontFamily')).toBe(true);
    });

    it('applies link for [label](url)', () => {
      const reqs = markdownToGDocsRequests('[click](https://example.com)');
      expect(hasStyle(reqs, 'link')).toBe(true);
    });
  });

  describe('code blocks', () => {
    it('does not insert fence lines into the doc', () => {
      const reqs = markdownToGDocsRequests('```\nconst x = 1;\n```');
      const texts = insertTexts(reqs);
      expect(texts.some(t => t.includes('```'))).toBe(false);
    });

    it('inserts code lines with monospace font', () => {
      const reqs = markdownToGDocsRequests('```\nconst x = 1;\n```');
      const texts = insertTexts(reqs);
      expect(texts.some(t => t.includes('const x = 1;'))).toBe(true);
      expect(hasStyle(reqs, 'weightedFontFamily')).toBe(true);
    });

    it('handles tilde fences (~~~)', () => {
      const reqs = markdownToGDocsRequests('~~~\ncode\n~~~');
      const texts = insertTexts(reqs);
      expect(texts.some(t => t.includes('~~~'))).toBe(false);
      expect(texts.some(t => t.includes('code'))).toBe(true);
    });
  });

  describe('lists', () => {
    it('creates unordered bullet for - item', () => {
      const reqs = markdownToGDocsRequests('- Alpha\n- Beta');
      expect(hasBullet(reqs, false)).toBe(true);
    });

    it('creates unordered bullet for * item', () => {
      const reqs = markdownToGDocsRequests('* item');
      expect(hasBullet(reqs, false)).toBe(true);
    });

    it('creates ordered bullet for 1. item', () => {
      const reqs = markdownToGDocsRequests('1. First\n2. Second');
      expect(hasBullet(reqs, true)).toBe(true);
    });

    it('does not insert the list marker text (- / 1.) into the doc', () => {
      const reqs = markdownToGDocsRequests('- My item');
      const texts = insertTexts(reqs);
      expect(texts.some(t => /^-\s/.test(t))).toBe(false);
    });
  });

  describe('task lists', () => {
    it('uses BULLET_CHECKBOX preset for - [ ] items', () => {
      const reqs = markdownToGDocsRequests('- [ ] Pack tent');
      expect(reqs.some((r: any) => r.createParagraphBullets?.bulletPreset === 'BULLET_CHECKBOX')).toBe(true);
    });

    it('does not apply strikethrough for unchecked items', () => {
      const reqs = markdownToGDocsRequests('- [ ] Pack tent');
      expect(hasStyle(reqs, 'strikethrough')).toBe(false);
    });

    it('applies strikethrough for - [x] items', () => {
      const reqs = markdownToGDocsRequests('- [x] Done thing');
      expect(hasStyle(reqs, 'strikethrough')).toBe(true);
    });

    it('does not include [ ] or [x] in the inserted text', () => {
      const reqs = markdownToGDocsRequests('- [ ] Item\n- [x] Done');
      const texts = insertTexts(reqs);
      expect(texts.some(t => t.includes('['))).toBe(false);
    });

    it('applies indentStart for a single-level indented task item', () => {
      const reqs = markdownToGDocsRequests('\t- [ ] Sub item');
      expect(hasIndentAtLevel(reqs, 1)).toBe(true);
    });

    it('applies double indentStart for a double-indented task item', () => {
      const reqs = markdownToGDocsRequests('\t\t- [ ] Deep item');
      expect(hasIndentAtLevel(reqs, 2)).toBe(true);
    });

    it('applies indentStart for a 2-space indented task item', () => {
      const reqs = markdownToGDocsRequests('  - [ ] Sub item');
      expect(hasIndentAtLevel(reqs, 1)).toBe(true);
    });

    it('does not apply indentStart for top-level task items', () => {
      const reqs = markdownToGDocsRequests('- [ ] Top level');
      expect(hasIndentAtLevel(reqs, 1)).toBe(false);
    });

    it('does not insert tab characters for task items', () => {
      const reqs = markdownToGDocsRequests('- [ ] general\n\t- [ ] tool kit');
      const texts = insertTexts(reqs);
      expect(texts.some(t => t === '\t' || t === '\t\t')).toBe(false);
    });

    it('handles a hierarchical checklist end-to-end', () => {
      const md = '- [ ] general\n\t- [ ] tool kit\n\t- [x] trash bags';
      const reqs = markdownToGDocsRequests(md);
      const texts = insertTexts(reqs);
      expect(texts.some(t => t.includes('general'))).toBe(true);
      expect(texts.some(t => t.includes('tool kit'))).toBe(true);
      expect(texts.some(t => t.includes('trash bags'))).toBe(true);
      expect(hasIndentAtLevel(reqs, 1)).toBe(true); // nested items indented
      expect(hasStyle(reqs, 'strikethrough')).toBe(true); // trash bags is checked
    });

    it('tracks index correctly across nested and top-level items', () => {
      // No tabs are inserted, so index advances by content length only.
      // 'general\n' (8 chars) at 1 → next at 9
      // 'tool kit\n' (9 chars) at 9 → next at 18
      // 'third\n' (6 chars) at 18
      const md = '- [ ] general\n\t- [ ] tool kit\n- [ ] third';
      const reqs = markdownToGDocsRequests(md);
      const indices = insertIndices(reqs);
      expect(indices).toContain(1);
      expect(indices).toContain(9);
      expect(indices).toContain(18);
    });

    it('createParagraphBullets range spans only the inserted content', () => {
      // No tab characters inserted, so range = [lineStart, lineStart + content.length + 1]
      // 'nested item\n' = 12 chars, starting at index 1 → range [1, 13]
      const md = '\t- [ ] nested item';
      const reqs = markdownToGDocsRequests(md);
      const ends = bulletRangeEnds(reqs);
      expect(ends.some(e => e === 13)).toBe(true);
    });
  });

  describe('horizontal rules', () => {
    it('converts --- to a line of em-dashes', () => {
      const reqs = markdownToGDocsRequests('---');
      const texts = insertTexts(reqs);
      expect(texts.some(t => t.includes('─'))).toBe(true);
    });

    it('also handles *** and ___', () => {
      for (const rule of ['***', '___']) {
        const reqs = markdownToGDocsRequests(rule);
        const texts = insertTexts(reqs);
        expect(texts.some(t => t.includes('─'))).toBe(true);
      }
    });
  });

  describe('blank lines and empty input', () => {
    it('returns no text content requests for empty input', () => {
      const reqs = markdownToGDocsRequests('');
      const texts = insertTexts(reqs);
      // An empty string split produces [''] — one blank line insertion is fine,
      // but no actual content should be written.
      expect(texts.every(t => t === '\n')).toBe(true);
    });

    it('inserts a newline for blank lines', () => {
      const reqs = markdownToGDocsRequests('Line 1\n\nLine 2');
      const texts = insertTexts(reqs);
      expect(texts.some(t => t === '\n')).toBe(true);
    });
  });
});
