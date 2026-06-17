import {
  GoogleDocument,
  DocumentElement,
  DocumentList,
  Paragraph,
  ParagraphElement,
  TextStyle,
} from '../api/GoogleDocsAPI';

// ─── Monospace font detection ─────────────────────────────────────────────────

const MONOSPACE_FAMILIES = new Set([
  'Courier New', 'Courier', 'Consolas', 'Roboto Mono', 'Fira Code',
  'Source Code Pro', 'Monaco', 'Menlo', 'Lucida Console', 'Ubuntu Mono',
]);

function isMonospaceFontFamily(fontFamily: string | undefined): boolean {
  return !!fontFamily && MONOSPACE_FAMILIES.has(fontFamily);
}

/**
 * Returns true if every non-empty text run in the paragraph uses a monospace
 * font — i.e. the whole paragraph is a code block line.
 */
function isCodeParagraph(para: Paragraph): boolean {
  const runs = (para.elements ?? []).filter(el => {
    const text = el.textRun?.content ?? '';
    return text !== '' && text !== '\n';
  });
  if (runs.length === 0) return false;
  return runs.every(el =>
    isMonospaceFontFamily(el.textRun?.textStyle?.weightedFontFamily?.fontFamily),
  );
}

/** Extract plain text from a paragraph (no styling applied). */
function extractRawText(para: Paragraph): string {
  return (para.elements ?? [])
    .map(el => el.textRun?.content ?? '')
    .join('')
    .replace(/\n$/, ''); // strip Google's structural trailing newline
}

/**
 * Returns true if this paragraph is a horizontal rule — either:
 *   1. A native HR inserted via the Google Docs UI (a ParagraphElement with a
 *      `horizontalRule` field). The REST API v1 can read these but has no
 *      insertHorizontalRule batchUpdate request to create them.
 *   2. The em-dash approximation pushed by MarkdownToGDocs (3+ consecutive
 *      BOX DRAWINGS LIGHT HORIZONTAL characters, U+2500).
 */
function isHorizontalRuleParagraph(para: Paragraph): boolean {
  // Native HR: any element in the paragraph has a horizontalRule field
  if ((para.elements ?? []).some(el => el.horizontalRule !== undefined)) {
    return true;
  }
  // Em-dash approximation: the full paragraph text is 3+ ─ characters
  return /^─{3,}$/.test(extractRawText(para));
}

// ─── Inline text style rendering ─────────────────────────────────────────────

/**
 * Wrap `text` with the appropriate Markdown syntax for its GDocs TextStyle.
 * Order: bold+italic first, then individual styles, then link wraps everything.
 * Monospace font → inline code backticks (only when not a full code paragraph).
 */
function applyTextStyle(text: string, style: TextStyle | undefined): string {
  if (!style || !text) return text;

  // Strip trailing newline before applying styles so we don't wrap it
  const trailingNewline = text.endsWith('\n');
  const core = trailingNewline ? text.slice(0, -1) : text;
  if (!core) return trailingNewline ? '\n' : '';

  const isBold   = style.bold === true;
  const isItalic = style.italic === true;
  const isStrike = style.strikethrough === true;
  const isCode   = isMonospaceFontFamily(style.weightedFontFamily?.fontFamily);
  const linkUrl  = style.link?.url;

  // Inline code takes precedence over bold/italic (can't have bold code in Markdown)
  if (isCode) {
    const result = `\`${core}\``;
    return trailingNewline ? result + '\n' : result;
  }

  let result = core;

  if (isBold && isItalic) {
    result = `***${result}***`;
  } else if (isBold) {
    result = `**${result}**`;
  } else if (isItalic) {
    result = `*${result}*`;
  }

  if (isStrike) {
    result = `~~${result}~~`;
  }

  if (linkUrl) {
    result = `[${result}](${linkUrl})`;
  }

  return trailingNewline ? result + '\n' : result;
}

// ─── List type detection ──────────────────────────────────────────────────────

const ORDERED_GLYPH_TYPES = new Set([
  'DECIMAL', 'ZERO_DECIMAL', 'UPPER_ALPHA', 'ALPHA', 'UPPER_ROMAN', 'ROMAN',
]);

// Unicode checkbox characters Google Docs uses for BULLET_CHECKBOX lists
const CHECKBOX_GLYPH_SYMBOLS = new Set(['☐', '☑', '☒', '☐', '☑', '☒']);

function isOrderedList(
  lists: Record<string, DocumentList> | undefined,
  listId: string,
  nestingLevel: number,
): boolean {
  if (!lists) return false;
  const level = lists[listId]?.listProperties?.nestingLevels?.[nestingLevel];
  return !!level?.glyphType && ORDERED_GLYPH_TYPES.has(level.glyphType);
}

/**
 * Returns true if the list at this nesting level is a checkbox (BULLET_CHECKBOX) list.
 * Detection strategy: checkbox lists have a known checkbox glyph symbol, OR have
 * neither a standard glyphSymbol nor an ordered glyphType (the absence pattern
 * Google uses for BULLET_CHECKBOX).
 */
function isCheckboxList(
  lists: Record<string, DocumentList> | undefined,
  listId: string,
  nestingLevel: number,
): boolean {
  if (!lists) return false;
  const level = lists[listId]?.listProperties?.nestingLevels?.[nestingLevel];
  if (!level) return false;
  if (level.glyphSymbol && CHECKBOX_GLYPH_SYMBOLS.has(level.glyphSymbol)) return true;
  const isOrdered = !!level.glyphType && ORDERED_GLYPH_TYPES.has(level.glyphType);
  // No bullet symbol and not ordered → BULLET_CHECKBOX preset
  return !level.glyphSymbol && !isOrdered;
}

/**
 * Returns true if a checkbox paragraph is checked.
 *
 * The Google Docs REST API v1 does not expose checkbox checked state via any
 * dedicated field — probing confirmed checkboxState is absent from all responses
 * and throws a 400 if you try to write it. The only detectable signal is
 * strikethrough on all non-empty text runs, which both our push (for [x] items)
 * and the Google Docs UI apply when a box is checked.
 */
function isCheckboxChecked(para: Paragraph): boolean {
  const runs = (para.elements ?? []).filter(el => {
    const t = el.textRun?.content ?? '';
    return t !== '' && t !== '\n';
  });
  return runs.length > 0 && runs.every(el => el.textRun?.textStyle?.strikethrough === true);
}

/**
 * Render a checkbox paragraph's text with inline styles applied but with
 * strikethrough suppressed — the checked state is encoded as [x] not ~~text~~.
 */
function renderCheckboxText(para: Paragraph): string {
  const raw = (para.elements ?? [])
    .map((el: ParagraphElement) => {
      const style = el.textRun?.textStyle;
      const cleanStyle = style ? { ...style, strikethrough: false } : style;
      return applyTextStyle(el.textRun?.content ?? '', cleanStyle as typeof style);
    })
    .join('');
  return raw.endsWith('\n') ? raw.slice(0, -1) : raw;
}

// ─── Paragraph rendering ──────────────────────────────────────────────────────

function renderParagraph(
  para: Paragraph,
  lists?: Record<string, DocumentList>,
): { text: string; isList: boolean } {
  const namedStyle = para.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT';
  const isList = para.bullet !== undefined;
  const nestingLevel = para.bullet?.nestingLevel ?? 0;

  // Concatenate all text runs with inline styles applied
  const rawText = (para.elements ?? [])
    .map((el: ParagraphElement) => applyTextStyle(el.textRun?.content ?? '', el.textRun?.textStyle))
    .join('');

  // Strip Google's mandatory structural trailing newline
  const lineText = rawText.endsWith('\n') ? rawText.slice(0, -1) : rawText;

  if (isList) {
    const listId = para.bullet?.listId ?? '';
    const ordered = isOrderedList(lists, listId, nestingLevel);
    const indent = '  '.repeat(nestingLevel);

    if (!ordered && isCheckboxList(lists, listId, nestingLevel)) {
      // Render as a Markdown task list item. Use renderCheckboxText so
      // strikethrough is not emitted as ~~text~~ — checked state is [x].
      const checkboxText = renderCheckboxText(para);
      const prefix = isCheckboxChecked(para) ? '- [x] ' : '- [ ] ';
      return { text: `${indent}${prefix}${checkboxText}`, isList: true };
    }

    const prefix = ordered ? '1. ' : '- ';
    return { text: `${indent}${prefix}${lineText}`, isList: true };
  }

  const headingPrefix: Record<string, string> = {
    HEADING_1: '# ', HEADING_2: '## ', HEADING_3: '### ',
    HEADING_4: '#### ', HEADING_5: '##### ', HEADING_6: '###### ',
    NORMAL_TEXT: '', TITLE: '# ', SUBTITLE: '## ',
  };

  const prefix = headingPrefix[namedStyle] ?? '';
  return { text: `${prefix}${lineText}`, isList: false };
}

// ─── Document walker ──────────────────────────────────────────────────────────

export function gdocsToMarkdown(doc: GoogleDocument): string {
  const elements: DocumentElement[] = doc.body?.content ?? [];
  const lists = doc.lists;
  const lines: string[] = [];
  let prevWasList = false;
  let inCodeBlock = false;

  for (const element of elements) {
    if (!element.paragraph) {
      // Tables, section breaks — skip for v1.
      // TODO: v2 — render tables as GFM pipe tables.
      continue;
    }

    const para = element.paragraph;

    // ── Horizontal rule (em-dash paragraph pushed by MarkdownToGDocs) ─────────
    if (isHorizontalRuleParagraph(para)) {
      if (inCodeBlock) { lines.push('```'); lines.push(''); inCodeBlock = false; }
      if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
      lines.push('---');
      prevWasList = false;
      continue;
    }

    // ── Code block paragraph (all runs are monospace) ─────────────────────────
    if (isCodeParagraph(para)) {
      if (!inCodeBlock) {
        if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
        lines.push('```');
        inCodeBlock = true;
        prevWasList = false;
      }
      lines.push(extractRawText(para));
      continue;
    }

    // Close an open code block when we hit a non-code paragraph
    if (inCodeBlock) {
      lines.push('```');
      lines.push('');
      inCodeBlock = false;
    }

    // ── Normal paragraph ──────────────────────────────────────────────────────
    const { text, isList } = renderParagraph(para, lists);

    // Skip the structural empty paragraph Google places at the very start of
    // every document body.
    if (text === '' && lines.length === 0) continue;

    if (isList) {
      // Add a blank line before the first item in a list group
      if (!prevWasList && lines.length > 0 && lines[lines.length - 1] !== '') {
        lines.push('');
      }
      lines.push(text);
      prevWasList = true;
    } else {
      if (text === '') {
        lines.push('');
      } else {
        if (lines.length > 0 && lines[lines.length - 1] !== '') {
          lines.push('');
        }
        lines.push(text);
      }
      prevWasList = false;
    }
  }

  // Close any unclosed code block (shouldn't happen with well-formed docs)
  if (inCodeBlock) {
    lines.push('```');
  }

  // Trim leading/trailing blank lines
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  return lines.join('\n');
}
