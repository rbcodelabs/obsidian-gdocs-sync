/**
 * HtmlToMarkdown test suite.
 *
 * HTML fixtures are based on actual Google Docs HTML export patterns confirmed
 * by live API probes. Each test targets a specific formatting case.
 *
 * Requires vitest environment: 'happy-dom' for DOMParser.
 */

import { describe, it, expect } from 'vitest';
import { htmlToMarkdown, extractDocTitle } from '../../src/converter/HtmlToMarkdown';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Wrap a body fragment in a minimal Google Docs HTML shell. */
function gdoc(body: string): string {
  return `<!DOCTYPE html><html><head><title>Test Doc</title></head><body>${body}</body></html>`;
}

// ─── extractDocTitle ──────────────────────────────────────────────────────────

describe('extractDocTitle', () => {
  it('returns the <title> text', () => {
    expect(extractDocTitle(gdoc(''))).toBe('Test Doc');
  });

  it('returns empty string when no title present', () => {
    expect(extractDocTitle('<html><body></body></html>')).toBe('');
  });
});

// ─── Headings ─────────────────────────────────────────────────────────────────

describe('headings', () => {
  it('converts H1 through H6', () => {
    for (let i = 1; i <= 6; i++) {
      const html = gdoc(`<h${i}><span>Level ${i}</span></h${i}>`);
      expect(htmlToMarkdown(html)).toBe(`${'#'.repeat(i)} Level ${i}`);
    }
  });

  it('does not add ** for heading spans with font-weight:700 (inherent heading style)', () => {
    // Google Docs adds font-weight:700 to ALL heading spans as an inherent style.
    // The # marker already implies heading weight — adding ** would be noise.
    const html = gdoc(`<h2><span style="font-weight:700">Bold Heading</span></h2>`);
    expect(htmlToMarkdown(html)).toBe('## Bold Heading');
  });

  it('strips Google Docs inline span wrapper', () => {
    // GDocs wraps every heading in a <span style="..."> — result should be clean
    const html = gdoc(`<h1 style="padding-top:12pt"><span style="font-weight:700;text-decoration:none;font-size:24pt;font-family:Arial">My Title</span></h1>`);
    expect(htmlToMarkdown(html)).toBe('# My Title');
  });
});

// ─── Paragraphs and blank lines ───────────────────────────────────────────────

describe('paragraphs', () => {
  it('separates paragraphs with a blank line', () => {
    const html = gdoc('<p>First</p><p>Second</p>');
    expect(htmlToMarkdown(html)).toBe('First\n\nSecond');
  });

  it('skips the structural empty first paragraph Google inserts', () => {
    const html = gdoc('<p></p><p>Real content</p>');
    expect(htmlToMarkdown(html)).toBe('Real content');
  });

  it('does not produce more than one consecutive blank line', () => {
    const html = gdoc('<p>A</p><p></p><p></p><p>B</p>');
    expect(htmlToMarkdown(html)).not.toMatch(/\n{3,}/);
    expect(htmlToMarkdown(html)).toBe('A\n\nB');
  });

  it('returns empty string for a document with no body content', () => {
    expect(htmlToMarkdown(gdoc(''))).toBe('');
  });
});

// ─── Inline styles ────────────────────────────────────────────────────────────

describe('inline styles — GDocs CSS pattern (font-weight:700 etc.)', () => {
  it('renders bold via font-weight:700', () => {
    const html = gdoc('<p><span style="font-weight:700">bold</span></p>');
    expect(htmlToMarkdown(html)).toBe('**bold**');
  });

  it('renders italic via font-style:italic', () => {
    const html = gdoc('<p><span style="font-style:italic">italic</span></p>');
    expect(htmlToMarkdown(html)).toBe('*italic*');
  });

  it('renders bold-italic via combined CSS', () => {
    const html = gdoc('<p><span style="font-weight:700;font-style:italic">both</span></p>');
    expect(htmlToMarkdown(html)).toBe('***both***');
  });

  it('renders strikethrough via text-decoration:line-through on span', () => {
    const html = gdoc('<p><span style="text-decoration:line-through">struck</span></p>');
    expect(htmlToMarkdown(html)).toBe('~~struck~~');
  });

  it('does not render text-decoration:none as strikethrough', () => {
    const html = gdoc('<p><span style="text-decoration:none">plain</span></p>');
    expect(htmlToMarkdown(html)).toBe('plain');
  });

  it('renders inline code via Courier New font', () => {
    const html = gdoc(`<p>use <span style="font-family:'Courier New'">myFunc()</span> here</p>`);
    expect(htmlToMarkdown(html)).toBe('use `myFunc()` here');
  });

  it('renders inline code via unquoted font family', () => {
    // A paragraph with mixed content — non-monospace text surrounding a Courier span
    // should render the monospace span as inline backtick code, not a fenced block
    const html = gdoc(`<p>Type <span style="font-family:Courier New">x = 1</span> here</p>`);
    expect(htmlToMarkdown(html)).toBe('Type `x = 1` here');
  });

  it('renders semantic <strong>, <em>, <del> tags', () => {
    const html = gdoc('<p><strong>bold</strong> <em>italic</em> <del>struck</del></p>');
    expect(htmlToMarkdown(html)).toBe('**bold** *italic* ~~struck~~');
  });

  it('keeps whitespace outside bold markers', () => {
    // "Hello **world** there" — space before ** and after ** should be outside
    const html = gdoc('<p>Hello <span style="font-weight:700">world</span> there</p>');
    expect(htmlToMarkdown(html)).toBe('Hello **world** there');
  });

  it('handles mixed inline styles in one paragraph', () => {
    const html = gdoc(`<p>
      <span>Normal </span>
      <span style="font-weight:700">bold </span>
      <span style="font-style:italic">italic </span>
      <span style="font-weight:700;font-style:italic">both</span>
    </p>`);
    expect(htmlToMarkdown(html)).toBe('Normal **bold** *italic* ***both***');
  });
});

// ─── Links ────────────────────────────────────────────────────────────────────

describe('links', () => {
  it('renders a plain link', () => {
    const html = gdoc('<p><a href="https://example.com">click here</a></p>');
    expect(htmlToMarkdown(html)).toBe('[click here](https://example.com)');
  });

  it('unwraps Google redirect URLs', () => {
    const actual = 'https://example.com/target';
    const redirect = `https://www.google.com/url?q=${encodeURIComponent(actual)}&sa=D&source=editors`;
    const html = gdoc(`<p><a href="${redirect}">link text</a></p>`);
    expect(htmlToMarkdown(html)).toBe(`[link text](${actual})`);
  });

  it('handles bold link text', () => {
    const html = gdoc(`<p><a href="https://example.com"><span style="font-weight:700">bold link</span></a></p>`);
    expect(htmlToMarkdown(html)).toBe('[**bold link**](https://example.com)');
  });

  it('skips links with no text', () => {
    const html = gdoc('<p><a href="https://example.com"></a>after</p>');
    expect(htmlToMarkdown(html)).toBe('after');
  });
});

// ─── Code blocks ─────────────────────────────────────────────────────────────

describe('code blocks', () => {
  it('renders a <pre><code> block as fenced Markdown', () => {
    const html = gdoc('<pre><code>const x = 1;\nconst y = 2;</code></pre>');
    expect(htmlToMarkdown(html)).toBe('```\nconst x = 1;\nconst y = 2;\n```');
  });

  it('renders a GDocs monospace paragraph (single-line code)', () => {
    // Google Docs exports a code paragraph as <p style="font-family:Courier New">
    const html = gdoc(`<p style="font-family:Courier New">const x = 1;</p>`);
    expect(htmlToMarkdown(html)).toBe('```\nconst x = 1;\n```');
  });

  it('renders a GDocs monospace paragraph with <br> newlines (multi-line)', () => {
    // This is how Google Docs exports <pre><code> after a round-trip:
    // a single <p> with Courier font and <br> for line breaks
    const html = gdoc(`<p style="font-family:Courier">const x = 1;<br>const y = 2;<br>console.log(x + y);</p>`);
    expect(htmlToMarkdown(html)).toBe('```\nconst x = 1;\nconst y = 2;\nconsole.log(x + y);\n```');
  });

  it('groups consecutive monospace paragraphs into one code block', () => {
    const html = gdoc(`
      <p style="font-family:Courier New">line one</p>
      <p style="font-family:Courier New">line two</p>
      <p style="font-family:Courier New">line three</p>
    `);
    expect(htmlToMarkdown(html)).toBe('```\nline one\nline two\nline three\n```');
  });

  it('closes a code block before a normal paragraph', () => {
    const html = gdoc(`
      <p style="font-family:Courier New">code line</p>
      <p>Normal text</p>
    `);
    const md = htmlToMarkdown(html);
    expect(md).toContain('```\ncode line\n```');
    expect(md).toContain('Normal text');
  });

  it('renders inline code inside a normal paragraph', () => {
    const html = gdoc(`<p>Call <span style="font-family:Courier New">foo()</span> here</p>`);
    expect(htmlToMarkdown(html)).toBe('Call `foo()` here');
  });

  it('handles the real GDocs probe output (Courier, all-span monospace)', () => {
    // From the live API probe: code content comes through with all spans in Courier
    const html = gdoc(`
      <p style="padding:0;font-family:Courier;font-size:11pt">
        <span style="font-family:Courier;font-size:11pt">const x = 1;</span>
      </p>
    `);
    expect(htmlToMarkdown(html)).toBe('```\nconst x = 1;\n```');
  });
});

// ─── Unordered lists ──────────────────────────────────────────────────────────

describe('unordered lists', () => {
  it('renders bullet list items with - prefix', () => {
    const html = gdoc(`
      <ul class="lst-kix_list_1-0">
        <li><span>Alpha</span></li>
        <li><span>Beta</span></li>
        <li><span>Gamma</span></li>
      </ul>
    `);
    expect(htmlToMarkdown(html)).toBe('- Alpha\n- Beta\n- Gamma');
  });

  it('adds a blank line before a list after a paragraph', () => {
    const html = gdoc(`
      <p>Intro text</p>
      <ul class="lst-kix_list_1-0">
        <li><span>Item one</span></li>
      </ul>
    `);
    const md = htmlToMarkdown(html);
    expect(md).toBe('Intro text\n\n- Item one');
  });

  it('does not add extra blank lines between consecutive list siblings', () => {
    // Google Docs exports nested lists as sibling <ul> elements, not nested ones
    const html = gdoc(`
      <ul class="lst-kix_list_1-0">
        <li><span>Parent</span></li>
      </ul>
      <ul class="lst-kix_list_2-1">
        <li><span>Child</span></li>
      </ul>
      <ul class="lst-kix_list_1-0">
        <li><span>Another parent</span></li>
      </ul>
    `);
    const md = htmlToMarkdown(html);
    expect(md).not.toMatch(/\n\n/);
    expect(md).toBe('- Parent\n  - Child\n- Another parent');
  });

  it('renders inline formatting inside list items', () => {
    const html = gdoc(`
      <ul class="lst-kix_list_1-0">
        <li><span style="font-weight:700">bold item</span></li>
        <li><span style="font-style:italic">italic item</span></li>
      </ul>
    `);
    expect(htmlToMarkdown(html)).toBe('- **bold item**\n- *italic item*');
  });
});

// ─── Ordered lists ────────────────────────────────────────────────────────────

describe('ordered lists', () => {
  it('renders numbered list items with 1. prefix', () => {
    const html = gdoc(`
      <ol class="lst-kix_list_1-0">
        <li><span>First</span></li>
        <li><span>Second</span></li>
        <li><span>Third</span></li>
      </ol>
    `);
    expect(htmlToMarkdown(html)).toBe('1. First\n1. Second\n1. Third');
  });
});

// ─── Nested lists ─────────────────────────────────────────────────────────────

describe('nested lists', () => {
  it('indents level-1 items with 2 spaces', () => {
    const html = gdoc(`
      <ul class="lst-kix_list_1-0 start">
        <li><span>Parent</span></li>
      </ul>
      <ul class="lst-kix_list_2-1 start">
        <li><span>Child A</span></li>
        <li><span>Child B</span></li>
      </ul>
      <ul class="lst-kix_list_1-0">
        <li><span>Another parent</span></li>
      </ul>
    `);
    expect(htmlToMarkdown(html)).toBe(
      '- Parent\n  - Child A\n  - Child B\n- Another parent'
    );
  });

  it('indents level-2 items with 4 spaces', () => {
    const html = gdoc(`
      <ul class="lst-kix_list_1-0">
        <li><span>Root</span></li>
      </ul>
      <ul class="lst-kix_list_2-1">
        <li><span>Mid</span></li>
      </ul>
      <ul class="lst-kix_list_3-2">
        <li><span>Deep</span></li>
      </ul>
    `);
    expect(htmlToMarkdown(html)).toBe('- Root\n  - Mid\n    - Deep');
  });

  it('handles mixed ordered/unordered nesting', () => {
    const html = gdoc(`
      <ol class="lst-kix_list_1-0">
        <li><span>Step one</span></li>
        <li><span>Step two</span></li>
      </ol>
      <ul class="lst-kix_list_2-1">
        <li><span>Sub-bullet A</span></li>
        <li><span>Sub-bullet B</span></li>
      </ul>
      <ol class="lst-kix_list_1-0">
        <li><span>Step three</span></li>
      </ol>
    `);
    expect(htmlToMarkdown(html)).toBe(
      '1. Step one\n1. Step two\n  - Sub-bullet A\n  - Sub-bullet B\n1. Step three'
    );
  });
});

// ─── Checkbox / task lists ────────────────────────────────────────────────────

describe('checkbox lists', () => {
  it('renders unchecked items as - [ ]', () => {
    const html = gdoc(`
      <ul class="lst-kix_list_1-0">
        <li role="checkbox" aria-checked="false" style="list-style-type:none;margin-left:36pt">
          <span>pack tent</span>
        </li>
      </ul>
    `);
    expect(htmlToMarkdown(html)).toBe('- [ ] pack tent');
  });

  it('renders checked items as - [x] via aria-checked', () => {
    const html = gdoc(`
      <ul class="lst-kix_list_1-0">
        <li role="checkbox" aria-checked="true" style="list-style-type:none;text-decoration:line-through;margin-left:36pt">
          <span style="text-decoration:none">buy food</span>
        </li>
      </ul>
    `);
    expect(htmlToMarkdown(html)).toBe('- [x] buy food');
  });

  it('renders checked items as - [x] via text-decoration on <li> (no aria-checked)', () => {
    const html = gdoc(`
      <ul class="lst-kix_list_1-0">
        <li role="checkbox" style="text-decoration:line-through;list-style-type:none">
          <span style="text-decoration:none">done thing</span>
        </li>
      </ul>
    `);
    expect(htmlToMarkdown(html)).toBe('- [x] done thing');
  });

  it('does NOT emit ~~strikethrough~~ for checked checkbox text', () => {
    // The checked state is encoded as [x], not ~~text~~
    const html = gdoc(`
      <ul class="lst-kix_list_1-0">
        <li role="checkbox" aria-checked="true" style="text-decoration:line-through">
          <span style="text-decoration:none">insect repellant</span>
        </li>
      </ul>
    `);
    const md = htmlToMarkdown(html);
    expect(md).toBe('- [x] insect repellant');
    expect(md).not.toContain('~~');
  });

  it('renders a mixed checked/unchecked list', () => {
    const html = gdoc(`
      <ul class="lst-kix_list_1-0">
        <li role="checkbox" aria-checked="false" style="list-style-type:none;margin-left:36pt">
          <span>pack tent</span>
        </li>
        <li role="checkbox" aria-checked="true" style="list-style-type:none;text-decoration:line-through;margin-left:36pt">
          <span style="text-decoration:none">buy food</span>
        </li>
        <li role="checkbox" aria-checked="false" style="list-style-type:none;margin-left:36pt">
          <span>charge headlamp</span>
        </li>
      </ul>
    `);
    expect(htmlToMarkdown(html)).toBe(
      '- [ ] pack tent\n- [x] buy food\n- [ ] charge headlamp'
    );
  });

  it('handles the exact Pictured Rocks doc HTML export format', () => {
    // Real captured HTML from the live probe of the Pictured Rocks packing list
    const html = gdoc(`
      <ul style="padding:0;margin:0">
        <li style="vertical-align:baseline;list-style-type:none;font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;-webkit-text-decoration-skip:none;text-decoration-skip-ink:none;white-space:pre;margin-left:36pt" role="checkbox" aria-checked="false" aria-level="1">
          <span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;-webkit-text-decoration-skip:none;text-decoration-skip-ink:none;vertical-align:baseline;white-space:pre">general</span>
        </li>
        <li style="vertical-align:baseline;list-style-type:none;font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:line-through;-webkit-text-decoration-skip:none;text-decoration-skip-ink:none;white-space:pre;margin-left:72pt" role="checkbox" aria-checked="true" aria-level="2">
          <span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;-webkit-text-decoration-skip:none;text-decoration-skip-ink:none;vertical-align:baseline;white-space:pre">insect repellant (DEET)</span>
        </li>
      </ul>
    `);
    const md = htmlToMarkdown(html);
    expect(md).toContain('- [ ] general');
    expect(md).toContain('- [x] insect repellant (DEET)');
    expect(md).not.toContain('~~');
  });

  it('indents nested checkbox items', () => {
    const html = gdoc(`
      <ul class="lst-kix_list_1-0">
        <li role="checkbox" aria-checked="false" style="margin-left:36pt;list-style-type:none">
          <span>parent task</span>
        </li>
      </ul>
      <ul class="lst-kix_list_2-1">
        <li role="checkbox" aria-checked="false" style="margin-left:72pt;list-style-type:none">
          <span>child task</span>
        </li>
        <li role="checkbox" aria-checked="true" style="text-decoration:line-through;margin-left:72pt;list-style-type:none">
          <span style="text-decoration:none">done child</span>
        </li>
      </ul>
    `);
    expect(htmlToMarkdown(html)).toBe(
      '- [ ] parent task\n  - [ ] child task\n  - [x] done child'
    );
  });

  it('preserves inline formatting inside checkbox items (excluding strikethrough)', () => {
    const html = gdoc(`
      <ul class="lst-kix_list_1-0">
        <li role="checkbox" aria-checked="false" style="list-style-type:none">
          <span style="font-weight:700">bold task</span>
        </li>
        <li role="checkbox" aria-checked="true" style="text-decoration:line-through;list-style-type:none">
          <span style="text-decoration:none;font-style:italic">italic done</span>
        </li>
      </ul>
    `);
    expect(htmlToMarkdown(html)).toBe('- [ ] **bold task**\n- [x] *italic done*');
  });
});

// ─── Horizontal rules ─────────────────────────────────────────────────────────

describe('horizontal rules', () => {
  it('converts <hr> to ---', () => {
    const html = gdoc('<p>Above</p><hr><p>Below</p>');
    expect(htmlToMarkdown(html)).toBe('Above\n\n---\n\nBelow');
  });
});

// ─── Tables ───────────────────────────────────────────────────────────────────

describe('tables', () => {
  it('renders a basic GFM pipe table', () => {
    const html = gdoc(`
      <table>
        <tr><th>Name</th><th>Role</th></tr>
        <tr><td>Alice</td><td>Engineer</td></tr>
        <tr><td>Bob</td><td>Designer</td></tr>
      </table>
    `);
    expect(htmlToMarkdown(html)).toBe(
      '| Name | Role |\n| --- | --- |\n| Alice | Engineer |\n| Bob | Designer |'
    );
  });

  it('escapes pipe characters in cell content', () => {
    const html = gdoc(`
      <table>
        <tr><th>A</th><th>B</th></tr>
        <tr><td>a | b</td><td>c</td></tr>
      </table>
    `);
    const md = htmlToMarkdown(html);
    expect(md).toContain('a \\| b');
  });

  it('renders inline formatting inside table cells', () => {
    const html = gdoc(`
      <table>
        <tr><th><span style="font-weight:700">Header</span></th></tr>
        <tr><td><span style="font-style:italic">cell</span></td></tr>
      </table>
    `);
    const md = htmlToMarkdown(html);
    expect(md).toContain('**Header**');
    expect(md).toContain('*cell*');
  });
});

// ─── Full document integration ────────────────────────────────────────────────

describe('full document integration', () => {
  it('converts a realistic GDocs export with mixed content', () => {
    const html = gdoc(`
      <h1 style="padding:0"><span style="font-weight:700;text-decoration:none;font-size:24pt">Camping Trip</span></h1>
      <p style="padding:0"><span>Plan for the weekend trip.</span></p>
      <h2 style="padding:0"><span style="font-weight:700;font-size:18pt">Packing List</span></h2>
      <ul class="lst-kix_list_1-0">
        <li role="checkbox" aria-checked="true" style="text-decoration:line-through;list-style-type:none;margin-left:36pt">
          <span style="text-decoration:none">tent</span>
        </li>
        <li role="checkbox" aria-checked="false" style="list-style-type:none;margin-left:36pt">
          <span>sleeping bag</span>
        </li>
      </ul>
      <h2 style="padding:0"><span style="font-weight:700;font-size:18pt">Notes</span></h2>
      <p style="padding:0"><span>Leave by </span><span style="font-weight:700">6am</span><span> Friday.</span></p>
    `);

    const md = htmlToMarkdown(html);
    expect(md).toContain('# Camping Trip');
    expect(md).toContain('Plan for the weekend trip.');
    expect(md).toContain('## Packing List');
    expect(md).toContain('- [x] tent');
    expect(md).toContain('- [ ] sleeping bag');
    expect(md).toContain('## Notes');
    expect(md).toContain('Leave by **6am** Friday.');
  });

  it('matches the HTML from the live API probe round-trip', () => {
    // HTML reconstructed from the probe output (Step 3) for key elements
    const html = `<!DOCTYPE html><html>
<head><title>HTML-first Test</title></head>
<body>
<h1 style="padding-top:12pt;font-weight:700;font-size:24pt;font-family:Arial"><span style="font-weight:700;text-decoration:none;font-size:24pt;font-family:Arial">HTML-first Test</span></h1>
<p style="font-size:11pt;font-family:Arial">
  <span>Paragraph with </span>
  <span style="font-weight:700">bold</span>
  <span>, </span>
  <span style="font-style:italic">italic</span>
  <span>, </span>
  <span style="font-weight:700;font-style:italic">bold-italic</span>
  <span>, </span>
  <span style="text-decoration-skip-ink:none;-webkit-text-decoration-skip:none;text-decoration:line-through">strikethrough</span>
  <span>, inline code, and a </span>
  <span><a href="https://www.google.com/url?q=https://example.com&amp;sa=D">link</a></span>
  <span>.</span>
</p>
<h2 style="font-weight:700;font-size:18pt"><span style="font-weight:700;font-size:18pt">Unordered List</span></h2>
<ul class="lst-kix_list_1-0 start" style="padding:0;margin:0">
  <li style="margin-left:30pt"><span>Alpha</span></li>
  <li style="margin-left:30pt"><span>Beta</span></li>
  <li style="margin-left:30pt"><span>Gamma</span></li>
</ul>
<h2 style="font-weight:700;font-size:18pt"><span>Ordered List</span></h2>
<ol class="lst-kix_list_2-0 start" style="padding:0;margin:0">
  <li style="margin-left:30pt"><span>First</span></li>
  <li style="margin-left:30pt"><span>Second</span></li>
</ol>
</body></html>`;

    const md = htmlToMarkdown(html);
    expect(md).toContain('# HTML-first Test');
    expect(md).toContain('**bold**');
    expect(md).toContain('*italic*');
    expect(md).toContain('***bold-italic***');
    expect(md).toContain('~~strikethrough~~');
    expect(md).toContain('[link](https://example.com)');
    expect(md).toContain('## Unordered List');
    expect(md).toContain('- Alpha');
    expect(md).toContain('- Beta');
    expect(md).toContain('## Ordered List');
    expect(md).toContain('1. First');
    expect(md).toContain('1. Second');
  });
});
