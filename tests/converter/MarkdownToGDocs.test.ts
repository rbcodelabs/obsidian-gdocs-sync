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
