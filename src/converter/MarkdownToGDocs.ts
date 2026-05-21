// TODO: v2 — replace this line-by-line parser with a remark/unified AST pipeline.
// Current limitations: no tables, no reference-style links, no blockquotes,
// no multi-paragraph list items.

// ─── Types ────────────────────────────────────────────────────────────────────

interface TextSegment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  code?: boolean;
  linkUrl?: string;
}

type BulletPreset =
  | 'BULLET_CHECKBOX'
  | 'BULLET_DISC_CIRCLE_SQUARE'
  | 'NUMBERED_DECIMAL_ALPHA_ROMAN';

interface PendingListItem {
  nestingLevel: number;
  content: string; // raw markdown (may have inline styles)
  checked?: boolean; // task items only
  preset: BulletPreset;
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

// ─── List nesting helpers ─────────────────────────────────────────────────────

/**
 * Convert Markdown list indentation to a nesting level.
 * 1 tab = 1 level; 2 spaces = 1 level (standard Markdown convention).
 */
function indentToNestingLevel(indent: string): number {
  let level = 0;
  let i = 0;
  while (i < indent.length) {
    if (indent[i] === '\t') {
      level++;
      i++;
    } else {
      let spaces = 0;
      while (i < indent.length && indent[i] === ' ') { spaces++; i++; }
      level += Math.floor(spaces / 2);
    }
  }
  return level;
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
 *   links, unordered lists, ordered lists, task lists (- [ ] / - [x]),
 *   fenced code blocks (``` / ~~~), horizontal rules (---, ***, ___),
 *   blank line separators.
 *
 * List nesting strategy: consecutive items of the same bullet preset are
 * buffered, then emitted as a single createParagraphBullets call covering
 * the full range. Leading tab characters are inserted for nested items before
 * the call so the API reads them as nesting signals (Approach B). Inline
 * style and strikethrough requests use post-consumption positions (tabs
 * removed by createParagraphBullets are not counted in subsequent indices).
 */
export function markdownToGDocsRequests(markdown: string): object[] {
  const requests: object[] = [];
  const lines = markdown.split('\n');
  let index = 1; // GDocs body content starts at index 1
  let inCodeBlock = false;

  // ── List buffer ─────────────────────────────────────────────────────────────
  // Consecutive list items are buffered and flushed as one createParagraphBullets
  // call so that leading \t chars correctly set the nesting level via the API.

  let pending: PendingListItem[] = [];
  let pendingPreset: BulletPreset | null = null;
  let pendingStart = 1;

  function flushList() {
    if (pending.length === 0) return;

    // Pre-compute segments and advance (chars inserted) for each item.
    const items = pending.map(item => {
      const segments = parseInlineStyles(item.content);
      const plainText = segments.map(s => s.text).join('');
      return { ...item, segments, plainText, advance: plainText.length + 1 /* +\n */ };
    });

    // Phase 1: insert text with leading tabs for nested items.
    let insertIdx = pendingStart;
    for (const item of items) {
      if (item.nestingLevel > 0) {
        requests.push(insertTextRequest('\t'.repeat(item.nestingLevel), insertIdx));
        insertIdx += item.nestingLevel;
      }
      requests.push(insertTextRequest(item.plainText + '\n', insertIdx));
      insertIdx += item.advance;
    }
    const groupEnd = insertIdx;

    // Phase 2: single createParagraphBullets on the full group range.
    // The API reads leading \t chars per paragraph to set nesting level,
    // then removes them (which reduces groupEnd by the total tab count).
    requests.push({
      createParagraphBullets: {
        range: { startIndex: pendingStart, endIndex: groupEnd },
        bulletPreset: pendingPreset!,
      },
    });

    // Phase 3: inline styles and strikethrough using post-consumption positions.
    // After the tabs are consumed, item k's content starts at:
    //   pendingStart + sum(advance_i for i < k)
    // The tab chars no longer exist in the document at this point in the batch.
    let cumAdvance = 0;
    for (const item of items) {
      const postStart = pendingStart + cumAdvance;

      // Inline styles
      let segIdx = postStart;
      for (const seg of item.segments) {
        const segEnd = segIdx + seg.text.length;
        const styleReq = updateTextStyleRequest(seg, segIdx, segEnd);
        if (styleReq) requests.push(styleReq);
        segIdx = segEnd;
      }

      // Strikethrough for checked task items
      if (item.checked && item.content.length > 0) {
        requests.push({
          updateTextStyle: {
            range: { startIndex: postStart, endIndex: postStart + item.content.length },
            textStyle: { strikethrough: true },
            fields: 'strikethrough',
          },
        });
      }

      cumAdvance += item.advance;
    }

    // Advance index: post-consumption length = sum of content advances (no tabs).
    index = pendingStart + cumAdvance;
    pending = [];
    pendingPreset = null;
  }

  function addToPending(item: PendingListItem) {
    // Flush if preset changed (e.g. ordered list after checkbox list).
    if (pendingPreset !== null && pendingPreset !== item.preset) {
      flushList();
    }
    if (pending.length === 0) {
      pendingStart = index;
      pendingPreset = item.preset;
    }
    pending.push(item);
  }

  // ── Line loop ────────────────────────────────────────────────────────────────

  for (const line of lines) {

    // ── Fenced code block fence (``` or ~~~) ─────────────────────────────────
    if (/^(`{3,}|~{3,})/.test(line)) {
      flushList();
      inCodeBlock = !inCodeBlock;
      continue;
    }

    // ── Inside a code block — monospace paragraph ─────────────────────────────
    if (inCodeBlock) {
      flushList();
      const lineText = line + '\n';
      requests.push(insertTextRequest(lineText, index));
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
      flushList();
      requests.push(insertTextRequest('\n', index));
      index += 1;
      continue;
    }

    // ── Horizontal rule (---, ***, ___) ──────────────────────────────────────
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushList();
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

    // ── Task list item (- [ ] unchecked or - [x] checked) ────────────────────
    const taskMatch = line.match(/^(\s*)[-*]\s+\[([ xX])\]\s+(.*)/);
    if (taskMatch) {
      addToPending({
        nestingLevel: indentToNestingLevel(taskMatch[1]),
        content: taskMatch[3],
        checked: taskMatch[2].toLowerCase() === 'x',
        preset: 'BULLET_CHECKBOX',
      });
      continue;
    }

    // ── Ordered list (1. 2. etc.) ─────────────────────────────────────────────
    const orderedMatch = line.match(/^(\s*)\d+\.\s+(.*)/);
    if (orderedMatch) {
      addToPending({
        nestingLevel: indentToNestingLevel(orderedMatch[1]),
        content: orderedMatch[2],
        preset: 'NUMBERED_DECIMAL_ALPHA_ROMAN',
      });
      continue;
    }

    // ── Unordered list (- or *) ───────────────────────────────────────────────
    const unorderedMatch = line.match(/^(\s*)[*-]\s+(.*)/);
    if (unorderedMatch) {
      addToPending({
        nestingLevel: indentToNestingLevel(unorderedMatch[1]),
        content: unorderedMatch[2],
        preset: 'BULLET_DISC_CIRCLE_SQUARE',
      });
      continue;
    }

    // ── Heading ───────────────────────────────────────────────────────────────
    flushList();
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
    flushList();
    index += insertLineWithStyles(line, index, requests);
  }

  flushList();
  return requests;
}
