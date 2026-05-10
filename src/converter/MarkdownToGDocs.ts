// TODO: v2 — replace this line-by-line parser with a remark/unified AST pipeline.
// Current limitations: no tables, no nested list nesting levels, no reference-
// style links, no blockquotes, no multi-paragraph list items.

// ─── Types ────────────────────────────────────────────────────────────────────

interface TextSegment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  code?: boolean;
  linkUrl?: string;
}

// ─── Inline style parser ──────────────────────────────────────────────────────

/**
 * Parse a line of markdown into styled text segments.
 * Supported: ***bold+italic***, **bold**, ~~strike~~, `code`, *italic*, [label](url)
 * Order in the alternation matters — more-specific patterns first.
 */
function parseInlineStyles(line: string): TextSegment[] {
  const segments: TextSegment[] = [];

  // Groups: 1=outer 2=boldItalic 3=bold 4=strike 5=code 6=italic 7=linkLabel 8=linkUrl
  const inlinePattern =
    /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|~~(.+?)~~|`(.+?)`|\*(.+?)\*|\[(.+?)\]\((.+?)\))/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = inlinePattern.exec(line)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: line.slice(lastIndex, match.index) });
    }

    const [full, , boldItalicText, boldText, strikeText, codeText, italicText, linkLabel, linkUrl] =
      match;

    if (boldItalicText !== undefined) {
      segments.push({ text: boldItalicText, bold: true, italic: true });
    } else if (boldText !== undefined) {
      segments.push({ text: boldText, bold: true });
    } else if (strikeText !== undefined) {
      segments.push({ text: strikeText, strikethrough: true });
    } else if (codeText !== undefined) {
      segments.push({ text: codeText, code: true });
    } else if (italicText !== undefined) {
      segments.push({ text: italicText, italic: true });
    } else if (linkLabel !== undefined && linkUrl !== undefined) {
      segments.push({ text: linkLabel, linkUrl });
    } else {
      segments.push({ text: full });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < line.length) {
    segments.push({ text: line.slice(lastIndex) });
  }
  if (segments.length === 0) {
    segments.push({ text: line });
  }

  return segments;
}

// ─── Request builders ─────────────────────────────────────────────────────────

function insertTextRequest(text: string, index: number): object {
  return { insertText: { location: { index }, text } };
}

function updateParagraphStyleRequest(
  namedStyleType: string,
  startIndex: number,
  endIndex: number,
): object {
  return {
    updateParagraphStyle: {
      range: { startIndex, endIndex },
      paragraphStyle: { namedStyleType },
      fields: 'namedStyleType',
    },
  };
}

function updateTextStyleRequest(
  segment: TextSegment,
  startIndex: number,
  endIndex: number,
): object | null {
  if (!segment.bold && !segment.italic && !segment.strikethrough && !segment.code && !segment.linkUrl) {
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const textStyle: Record<string, any> = {};
  const fields: string[] = [];

  if (segment.bold)          { textStyle.bold = true;          fields.push('bold'); }
  if (segment.italic)        { textStyle.italic = true;        fields.push('italic'); }
  if (segment.strikethrough) { textStyle.strikethrough = true; fields.push('strikethrough'); }
  if (segment.code) {
    textStyle.weightedFontFamily = { fontFamily: 'Courier New', weight: 400 };
    fields.push('weightedFontFamily');
  }
  if (segment.linkUrl) {
    textStyle.link = { url: segment.linkUrl };
    fields.push('link');
  }

  return {
    updateTextStyle: {
      range: { startIndex, endIndex },
      textStyle,
      fields: fields.join(','),
    },
  };
}

function createParagraphBulletsRequest(
  startIndex: number,
  endIndex: number,
  ordered: boolean,
): object {
  return {
    createParagraphBullets: {
      range: { startIndex, endIndex },
      bulletPreset: ordered ? 'NUMBERED_DECIMAL_ALPHA_ROMAN' : 'BULLET_DISC_CIRCLE_SQUARE',
    },
  };
}

// ─── Heading helpers ──────────────────────────────────────────────────────────

const HEADING_STYLE: Record<number, string> = {
  1: 'HEADING_1', 2: 'HEADING_2', 3: 'HEADING_3',
  4: 'HEADING_4', 5: 'HEADING_5', 6: 'HEADING_6',
};

function parseHeading(line: string): { level: number; text: string } | null {
  const m = line.match(/^(#{1,6})\s+(.*)/);
  if (!m) return null;
  return { level: m[1].length, text: m[2] };
}

// ─── Core helper: insert plain text + apply inline styles ─────────────────────

/**
 * Parses `content` for inline styles, inserts the plain text at `index`,
 * pushes updateTextStyle requests for each styled segment, then returns
 * the total number of characters inserted (including the trailing newline).
 */
function insertLineWithStyles(
  content: string,
  index: number,
  requests: object[],
): number {
  const segments = parseInlineStyles(content);
  const plainText = segments.map(s => s.text).join('');
  const fullText = plainText + '\n';

  requests.push(insertTextRequest(fullText, index));

  let segIndex = index;
  for (const seg of segments) {
    const segEnd = segIndex + seg.text.length;
    const styleReq = updateTextStyleRequest(seg, segIndex, segEnd);
    if (styleReq) requests.push(styleReq);
    segIndex = segEnd;
  }

  return fullText.length;
}

// ─── Main converter ───────────────────────────────────────────────────────────

/**
 * Converts a Markdown string into Google Docs BatchUpdate requests.
 *
 * Supported:
 *   Headings H1–H6, bold, italic, bold+italic, strikethrough, inline code,
 *   links, unordered lists, ordered lists, fenced code blocks (``` / ~~~),
 *   horizontal rules (---, ***, ___), blank line separators.
 */
export function markdownToGDocsRequests(markdown: string): object[] {
  const requests: object[] = [];
  const lines = markdown.split('\n');
  let index = 1; // GDocs body content starts at index 1
  let inCodeBlock = false;

  for (const line of lines) {

    // ── Fenced code block fence (``` or ~~~) ─────────────────────────────────
    if (/^(`{3,}|~{3,})/.test(line)) {
      inCodeBlock = !inCodeBlock;
      // The fence line itself is not inserted into the doc
      continue;
    }

    // ── Inside a code block — monospace paragraph ─────────────────────────────
    if (inCodeBlock) {
      const lineText = line + '\n';
      requests.push(insertTextRequest(lineText, index));
      // Apply monospace font to the code text (not the trailing \n)
      if (line.length > 0) {
        requests.push({
          updateTextStyle: {
            range: { startIndex: index, endIndex: index + line.length },
            textStyle: { weightedFontFamily: { fontFamily: 'Courier New', weight: 400 } },
            fields: 'weightedFontFamily',
          },
        });
      }
      index += lineText.length;
      continue;
    }

    // ── Blank line ────────────────────────────────────────────────────────────
    if (line.trim() === '') {
      requests.push(insertTextRequest('\n', index));
      index += 1;
      continue;
    }

    // ── Horizontal rule (---, ***, ___) ──────────────────────────────────────
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      const hrText = '─'.repeat(40) + '\n';
      requests.push(insertTextRequest(hrText, index));
      requests.push({
        updateTextStyle: {
          range: { startIndex: index, endIndex: index + hrText.length - 1 },
          textStyle: {
            foregroundColor: { color: { rgbColor: { red: 0.7, green: 0.7, blue: 0.7 } } },
            fontSize: { magnitude: 8, unit: 'PT' },
          },
          fields: 'foregroundColor,fontSize',
        },
      });
      index += hrText.length;
      continue;
    }

    // ── Ordered list (1. 2. etc.) ─────────────────────────────────────────────
    const orderedMatch = line.match(/^\s*\d+\.\s+(.*)/);
    if (orderedMatch) {
      const lineStart = index;
      const advance = insertLineWithStyles(orderedMatch[1], index, requests);
      requests.push(createParagraphBulletsRequest(lineStart, lineStart + advance, true));
      index += advance;
      continue;
    }

    // ── Unordered list (- or *) ───────────────────────────────────────────────
    const unorderedMatch = line.match(/^\s*[*-]\s+(.*)/);
    if (unorderedMatch) {
      const lineStart = index;
      const advance = insertLineWithStyles(unorderedMatch[1], index, requests);
      requests.push(createParagraphBulletsRequest(lineStart, lineStart + advance, false));
      index += advance;
      continue;
    }

    // ── Heading ───────────────────────────────────────────────────────────────
    const heading = parseHeading(line);
    if (heading) {
      const lineStart = index;
      const advance = insertLineWithStyles(heading.text, index, requests);
      requests.push(
        updateParagraphStyleRequest(
          HEADING_STYLE[heading.level] ?? 'NORMAL_TEXT',
          lineStart,
          lineStart + advance,
        ),
      );
      index += advance;
      continue;
    }

    // ── Normal paragraph ──────────────────────────────────────────────────────
    index += insertLineWithStyles(line, index, requests);
  }

  return requests;
}
