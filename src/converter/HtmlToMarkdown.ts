/**
 * HtmlToMarkdown — Convert a Google Docs HTML export to Markdown.
 *
 * Uses DOMParser (available natively in Electron / Obsidian, and via
 * happy-dom in the test environment). No production dependencies.
 *
 * Handles the specific CSS patterns Google Docs uses in its HTML export:
 *  - Inline styles for bold (font-weight:700), italic, strikethrough, code font
 *  - Google redirect URL wrapping (www.google.com/url?q=<actual>)
 *  - Checkbox lists via role="checkbox" and text-decoration:line-through on <li>
 *  - Nested lists as sibling <ul>/<ol> elements with lst-kix_ CSS classes
 *  - Code blocks as <pre> or consecutive monospace <p> elements with <br> newlines
 *  - GFM pipe tables from <table> elements
 */

// ─── Font detection ───────────────────────────────────────────────────────────

const MONOSPACE_FAMILIES = new Set([
  'courier new', 'courier', 'consolas', 'roboto mono', 'fira code',
  'source code pro', 'monaco', 'menlo', 'lucida console', 'ubuntu mono',
]);

function isMonospace(family: string | undefined): boolean {
  if (!family) return false;
  // Strip quotes, take the first family in a comma-separated list, normalise case.
  const first = family.replace(/['"]/g, '').split(',')[0].trim().toLowerCase();
  return MONOSPACE_FAMILIES.has(first);
}

// ─── CSS inline style parsing ─────────────────────────────────────────────────

type CSSProps = Record<string, string>;

function parseCSSStyle(el: Element): CSSProps {
  const result: CSSProps = {};
  const attr = el.getAttribute('style') ?? '';
  for (const decl of attr.split(';')) {
    const colon = decl.indexOf(':');
    if (colon < 0) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const val  = decl.slice(colon + 1).trim().toLowerCase();
    if (prop && val) result[prop] = val;
  }
  return result;
}

// ─── URL extraction ───────────────────────────────────────────────────────────

/**
 * Google Docs wraps all outbound links in a redirect:
 *   https://www.google.com/url?q=<actual-url>&sa=D&source=editors&...
 * Extract the real URL from the `q` parameter when present.
 */
function extractUrl(href: string): string {
  try {
    const u = new URL(href);
    if (u.hostname === 'www.google.com' && u.pathname === '/url') {
      const q = u.searchParams.get('q');
      if (q) return q;
    }
  } catch {
    // Not a valid URL — return as-is
  }
  return href;
}

// ─── Inline rendering ─────────────────────────────────────────────────────────

/**
 * Wrap `inner` with Markdown markers, keeping leading/trailing whitespace
 * outside the markers (Markdown does not allow spaces at the inner edges
 * of bold/italic/strikethrough markers).
 */
function wrapMD(inner: string, open: string, close: string): string {
  const core = inner.trim();
  if (!core) return inner;
  const leading  = inner.slice(0, inner.length - inner.trimStart().length);
  const trailing = inner.slice(inner.trimEnd().length);
  return `${leading}${open}${core}${close}${trailing}`;
}

interface RenderOpts {
  /** Suppress strikethrough — used for checkbox text where [x] encodes checked state. */
  suppressStrikethrough?: boolean;
  /**
   * Suppress bold — used when rendering heading content, because Google Docs adds
   * font-weight:700 to every heading span as an inherent heading style, not as
   * user-applied bold. The heading marker (#) already implies strong weight.
   */
  suppressBold?: boolean;
}

/**
 * Recursively render a DOM node as Markdown inline content.
 * Text nodes have their whitespace normalised (runs of whitespace → single space)
 * to match browser rendering; element nodes apply appropriate Markdown syntax.
 */
function renderInline(node: ChildNode, opts: RenderOpts = {}): string {
  if (node.nodeType === Node.TEXT_NODE) {
    // Collapse runs of whitespace (including newlines from HTML indentation) to a
    // single space, the same way a browser renders inline text nodes.
    return (node.textContent ?? '').replace(/\s+/g, ' ');
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const el   = node as Element;
  const tag  = el.tagName.toLowerCase();
  const kids = () => Array.from(el.childNodes).map(n => renderInline(n, opts)).join('');

  switch (tag) {
    case 'br': return '\n';

    case 'a': {
      const href  = extractUrl(el.getAttribute('href') ?? '');
      const label = kids();
      if (!label.trim()) return '';
      return `[${label}](${href})`;
    }

    case 'strong': case 'b':
      return wrapMD(kids(), '**', '**');

    case 'em': case 'i':
      return wrapMD(kids(), '*', '*');

    case 'del': case 's':
      return opts.suppressStrikethrough ? kids() : wrapMD(kids(), '~~', '~~');

    case 'code': {
      const text = kids().trim();
      return text ? `\`${text}\`` : '';
    }

    case 'span': {
      const css = parseCSSStyle(el);

      // Inline code: any monospace font family
      if (isMonospace(css['font-family'])) {
        const text = kids().trim();
        return text ? `\`${text}\`` : '';
      }

      const bold   = !opts.suppressBold && (css['font-weight'] === '700' || css['font-weight'] === 'bold');
      const italic = css['font-style'] === 'italic';
      const td     = css['text-decoration'] ?? '';
      const strike = !opts.suppressStrikethrough && td.includes('line-through') && td !== 'none';

      let result = kids();

      if (bold && italic) result = wrapMD(result, '***', '***');
      else if (bold)      result = wrapMD(result, '**', '**');
      else if (italic)    result = wrapMD(result, '*', '*');

      if (strike) result = wrapMD(result, '~~', '~~');

      return result;
    }

    // Pass-through containers
    default: return kids();
  }
}

/** Render all children of `el` as inline Markdown. */
function renderContent(el: Element, opts: RenderOpts = {}): string {
  return Array.from(el.childNodes).map(n => renderInline(n, opts)).join('');
}

// ─── Code block helpers ───────────────────────────────────────────────────────

/**
 * Extract plain text from an element, converting <br> tags to newlines.
 * Used to recover code block content that Google Docs stores with <br> linebreaks
 * inside a single <p> element.
 *
 * Whitespace-only text nodes (containing only spaces/tabs/newlines) are skipped —
 * these are HTML indentation artifacts from the export, not actual code content.
 * Real code indentation lives inside span text content, not as standalone text nodes.
 */
function extractCodeText(el: Element): string {
  let text = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const content = node.textContent ?? '';
      if (!content.trim()) continue; // skip HTML indentation noise
      text += content;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const child = node as Element;
      text += child.tagName.toLowerCase() === 'br'
        ? '\n'
        : extractCodeText(child);
    }
  }
  return text;
}

/**
 * Returns true if this <p> paragraph is entirely in a monospace font,
 * meaning it is a code block line (Google Docs collapses <pre><code> into
 * a single <p> with Courier font and <br> newlines on HTML export).
 *
 * Critically, a paragraph with MIXED content (some spans monospace, some not,
 * or plain text nodes alongside monospace spans) is NOT a code paragraph —
 * it is a normal paragraph containing inline code snippets.
 */
function isCodeParagraph(p: Element): boolean {
  // Primary signal: the <p> element itself carries a monospace font-family.
  // This is how Google Docs exports a code block paragraph.
  if (isMonospace(parseCSSStyle(p)['font-family'])) return true;

  // Secondary: every direct child must be either:
  //   - A whitespace-only text node (HTML indentation noise — safe to ignore)
  //   - A <br> element (line separator within the code)
  //   - An element with a monospace font-family
  // Any non-whitespace plain text node OR any non-monospace element means the
  // paragraph has mixed content and is NOT a code paragraph.
  let hasContent = false;
  for (const node of Array.from(p.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      if ((node.textContent ?? '').trim()) return false; // non-empty plain text → mixed
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el  = node as Element;
      const tag = el.tagName.toLowerCase();
      if (tag === 'br') continue;
      if (!isMonospace(parseCSSStyle(el)['font-family'])) return false;
      if ((el.textContent ?? '').trim()) hasContent = true;
    }
  }
  return hasContent;
}

// ─── List helpers ─────────────────────────────────────────────────────────────

/**
 * Extract the nesting level of a Google Docs list element.
 *
 * Google Docs HTML export encodes nesting level in the CSS class name:
 *   "lst-kix_list_1-0"  → level 0
 *   "lst-kix_list_2-1"  → level 1
 * Falls back to estimating from the first <li>'s margin-left (36pt per level).
 */
function getListLevel(listEl: Element): number {
  const cls = listEl.getAttribute('class') ?? '';
  const m   = cls.match(/lst-kix_[^-]+-(\d+)/);
  if (m) return parseInt(m[1], 10);

  // Fallback: margin-left estimation (36pt per nesting level in GDocs defaults)
  const firstLi = listEl.querySelector('li');
  if (!firstLi) return 0;
  const ml = parseFloat(parseCSSStyle(firstLi)['margin-left'] ?? '0');
  if (isNaN(ml) || ml <= 36) return 0;
  return Math.max(0, Math.round(ml / 36) - 1);
}

/**
 * Returns true if the list element is a BULLET_CHECKBOX list.
 * Native Google Docs checkbox lists export their <li> items with role="checkbox".
 */
function isCheckboxList(listEl: Element): boolean {
  const firstLi = listEl.querySelector('li');
  return firstLi?.getAttribute('role') === 'checkbox';
}

/**
 * Returns true if a checkbox <li> is in the checked state.
 *
 * Two signals are tried:
 *  1. aria-checked="true" on the <li> (set by the Google Docs HTML export
 *     for natively-checked items and our batchUpdate-pushed checked items).
 *  2. text-decoration:line-through on the <li> style — same signal but
 *     via CSS rather than ARIA attribute; Google uses both simultaneously.
 */
function isLiChecked(li: Element): boolean {
  if (li.getAttribute('aria-checked') === 'true') return true;
  const td = parseCSSStyle(li)['text-decoration'] ?? '';
  return td.includes('line-through') && td !== 'none';
}

// ─── Table rendering ──────────────────────────────────────────────────────────

/**
 * Render a <table> element as a GFM pipe table.
 * Treats the first <tr> as the header row; generates a separator row after it.
 */
function renderTable(table: Element): string {
  const rows = Array.from(table.querySelectorAll('tr'));
  if (rows.length === 0) return '';

  const renderRow = (tr: Element): string => {
    const cells = Array.from(tr.querySelectorAll('th, td'));
    return '| ' + cells.map(c => renderContent(c).trim().replace(/\|/g, '\\|')).join(' | ') + ' |';
  };

  const [headerRow, ...bodyRows] = rows;
  const header    = renderRow(headerRow);
  const colCount  = headerRow.querySelectorAll('th, td').length || 1;
  const separator = '| ' + Array(colCount).fill('---').join(' | ') + ' |';

  const parts = [header, separator, ...bodyRows.map(renderRow)];
  return parts.join('\n');
}

// ─── Document walker ──────────────────────────────────────────────────────────

interface WalkCtx {
  lines: string[];
  codeBuffer: string[];
  prevWasList: boolean;
}

/** Flush a pending code block buffer and emit the fenced block. */
function flushCode(ctx: WalkCtx): void {
  if (ctx.codeBuffer.length === 0) return;
  // Trailing blank lines inside the buffer are noise — strip them
  while (ctx.codeBuffer.length > 0 && ctx.codeBuffer[ctx.codeBuffer.length - 1].trim() === '') {
    ctx.codeBuffer.pop();
  }
  if (ctx.lines.length > 0 && ctx.lines[ctx.lines.length - 1] !== '') ctx.lines.push('');
  ctx.lines.push('```');
  for (const line of ctx.codeBuffer) ctx.lines.push(line);
  ctx.lines.push('```');
  ctx.lines.push('');
  ctx.codeBuffer = [];
}

/** Emit a non-list block, ensuring exactly one blank line separates it from the previous non-empty block. */
function emitBlock(ctx: WalkCtx, text: string): void {
  flushCode(ctx);
  if (text === '') {
    // Avoid consecutive blank lines
    if (ctx.lines.length > 0 && ctx.lines[ctx.lines.length - 1] !== '') {
      ctx.lines.push('');
    }
    return;
  }
  if (ctx.lines.length > 0 && ctx.lines[ctx.lines.length - 1] !== '') ctx.lines.push('');
  ctx.lines.push(text);
  ctx.prevWasList = false;
}

/**
 * Convert a Google Docs HTML export string to Markdown.
 *
 * Relies on `DOMParser` being available in the execution context.
 * In the Obsidian plugin (Electron), it is a global. In tests, configure
 * vitest to use `environment: 'happy-dom'` which provides it.
 */
export function htmlToMarkdown(html: string): string {
  const dom = new DOMParser().parseFromString(html, 'text/html');
  const ctx: WalkCtx = { lines: [], codeBuffer: [], prevWasList: false };

  for (const child of Array.from(dom.body.children)) {
    const tag = child.tagName.toLowerCase();

    // ── Headings ──────────────────────────────────────────────────────────────
    if (/^h[1-6]$/.test(tag)) {
      const level = parseInt(tag[1], 10);
      // suppressBold: Google Docs wraps ALL heading text in font-weight:700 spans
      // as an inherent heading style — the # marker already implies heading weight.
      const text = renderContent(child, { suppressBold: true }).trim();
      emitBlock(ctx, '#'.repeat(level) + ' ' + text);
      ctx.prevWasList = false;
      continue;
    }

    // ── Paragraphs ────────────────────────────────────────────────────────────
    if (tag === 'p') {
      if (isCodeParagraph(child)) {
        // A single GDocs code-paragraph may contain multiple lines separated
        // by <br> elements (this is how Google exports <pre><code> blocks).
        const raw = extractCodeText(child);
        for (const line of raw.split('\n')) ctx.codeBuffer.push(line);
        ctx.prevWasList = false;
        continue;
      }

      flushCode(ctx);
      // Trim and collapse multiple spaces that arise from HTML indentation whitespace
      // between inline elements. Google Docs' actual export has no such indentation,
      // but tests and some editors produce it.
      const text = renderContent(child).trim().replace(/  +/g, ' ');

      // Skip the structural empty first paragraph Google inserts at doc start
      if (text === '' && ctx.lines.length === 0) continue;

      if (text === '') {
        emitBlock(ctx, '');
      } else {
        emitBlock(ctx, text);
      }
      ctx.prevWasList = false;
      continue;
    }

    // ── Lists (unordered, ordered, checkbox) ──────────────────────────────────
    if (tag === 'ul' || tag === 'ol') {
      flushCode(ctx);

      const level       = getListLevel(child);
      const indent      = '  '.repeat(level);
      const isOrdered   = tag === 'ol';
      const isCheckbox  = !isOrdered && isCheckboxList(child);

      // Add a blank line before the first item of a list group only when
      // transitioning from non-list content — consecutive list siblings
      // (including nested-level siblings) get no separator.
      const items = Array.from(child.querySelectorAll(':scope > li'));
      for (let i = 0; i < items.length; i++) {
        const li = items[i];

        const textOpts: RenderOpts = isCheckbox ? { suppressStrikethrough: true } : {};
        // .trim() removes leading/trailing whitespace that HTML indentation creates
        // (text nodes between the <li> tag and its first <span> child)
        const itemText = renderContent(li, textOpts).trim();

        let prefix: string;
        if (isCheckbox) {
          prefix = isLiChecked(li) ? '- [x] ' : '- [ ] ';
        } else if (isOrdered) {
          prefix = '1. ';
        } else {
          prefix = '- ';
        }

        const line     = `${indent}${prefix}${itemText}`;
        const isFirst  = i === 0 && !ctx.prevWasList;

        if (isFirst && ctx.lines.length > 0 && ctx.lines[ctx.lines.length - 1] !== '') {
          ctx.lines.push('');
        }
        ctx.lines.push(line);
      }

      ctx.prevWasList = true;
      continue;
    }

    // ── Horizontal rules ──────────────────────────────────────────────────────
    if (tag === 'hr') {
      emitBlock(ctx, '---');
      ctx.prevWasList = false;
      continue;
    }

    // ── Native <pre> code blocks ──────────────────────────────────────────────
    if (tag === 'pre') {
      const codeEl = child.querySelector('code') ?? child;
      const raw    = extractCodeText(codeEl);
      for (const line of raw.split('\n')) ctx.codeBuffer.push(line);
      ctx.prevWasList = false;
      continue;
    }

    // ── Tables ────────────────────────────────────────────────────────────────
    if (tag === 'table') {
      emitBlock(ctx, renderTable(child));
      ctx.prevWasList = false;
      continue;
    }

    // All other elements (div wrappers, etc.) — recurse into children
    // This handles Google Docs' occasional wrapping divs.
    if (child.children.length > 0) {
      const inner = htmlToMarkdown(child.outerHTML);
      if (inner) emitBlock(ctx, inner);
    }
  }

  flushCode(ctx);

  // Trim leading/trailing blank lines and deduplicate consecutive blanks
  return ctx.lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extract the document title from the HTML export's <title> tag.
 * Falls back to an empty string if no title is present.
 */
export function extractDocTitle(html: string): string {
  const dom = new DOMParser().parseFromString(html, 'text/html');
  return (dom.querySelector('title')?.textContent ?? '').trim();
}
