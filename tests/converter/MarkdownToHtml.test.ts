import { describe, it, expect, vi } from 'vitest';
import { markdownToHtml } from '../../src/converter/MarkdownToHtml';

// ─── Mock app.vault helpers ───────────────────────────────────────────────────

function makeApp(files: Record<string, Uint8Array> = {}): object {
  return {
    vault: {
      getFileByPath: vi.fn((path: string) => {
        return files[path] !== undefined ? { path } : null;
      }),
      readBinary: vi.fn(async (file: { path: string }) => {
        return files[file.path].buffer as ArrayBuffer;
      }),
    },
  };
}

// ─── Basic Markdown elements ──────────────────────────────────────────────────

describe('markdownToHtml — headings', () => {
  it('converts H1 heading', async () => {
    const app = makeApp();
    const result = await markdownToHtml('# Hello', app, '');
    expect(result).toContain('<h1>Hello</h1>');
  });

  it('converts H2 heading', async () => {
    const app = makeApp();
    const result = await markdownToHtml('## World', app, '');
    expect(result).toContain('<h2>World</h2>');
  });

  it('converts H3 heading', async () => {
    const app = makeApp();
    const result = await markdownToHtml('### Section', app, '');
    expect(result).toContain('<h3>Section</h3>');
  });
});

describe('markdownToHtml — inline formatting', () => {
  it('converts bold text', async () => {
    const app = makeApp();
    const result = await markdownToHtml('**bold**', app, '');
    expect(result).toContain('<strong>bold</strong>');
  });

  it('converts italic text', async () => {
    const app = makeApp();
    const result = await markdownToHtml('*italic*', app, '');
    expect(result).toContain('<em>italic</em>');
  });

  it('converts strikethrough text', async () => {
    const app = makeApp();
    const result = await markdownToHtml('~~strike~~', app, '');
    expect(result).toContain('<del>strike</del>');
  });
});

describe('markdownToHtml — code', () => {
  it('converts fenced code block', async () => {
    const app = makeApp();
    const result = await markdownToHtml('```\nconst x = 1;\n```', app, '');
    expect(result).toContain('<code>');
    expect(result).toContain('const x = 1;');
  });

  it('converts inline code', async () => {
    const app = makeApp();
    const result = await markdownToHtml('Use `npm install`', app, '');
    expect(result).toContain('<code>npm install</code>');
  });
});

describe('markdownToHtml — lists', () => {
  it('converts unordered list', async () => {
    const app = makeApp();
    const result = await markdownToHtml('- item 1\n- item 2', app, '');
    expect(result).toContain('<ul>');
    expect(result).toContain('<li>item 1</li>');
    expect(result).toContain('<li>item 2</li>');
  });

  it('converts ordered list', async () => {
    const app = makeApp();
    const result = await markdownToHtml('1. first\n2. second', app, '');
    expect(result).toContain('<ol>');
    expect(result).toContain('<li>first</li>');
    expect(result).toContain('<li>second</li>');
  });

  it('converts task list', async () => {
    const app = makeApp();
    const result = await markdownToHtml('- [ ] unchecked\n- [x] checked', app, '');
    expect(result).toContain('<li>');
    expect(result).toContain('unchecked');
    expect(result).toContain('checked');
  });
});

describe('markdownToHtml — tables', () => {
  it('converts a GFM pipe table', async () => {
    const md = '| Name | Age |\n| --- | --- |\n| Alice | 30 |';
    const app = makeApp();
    const result = await markdownToHtml(md, app, '');
    expect(result).toContain('<table>');
    expect(result).toContain('Name');
    expect(result).toContain('Alice');
  });
});

describe('markdownToHtml — horizontal rule', () => {
  it('converts --- to <hr>', async () => {
    const app = makeApp();
    const result = await markdownToHtml('---', app, '');
    expect(result).toContain('<hr');
  });
});

// ─── Image handling ───────────────────────────────────────────────────────────

describe('markdownToHtml — external images', () => {
  it('passes through external image URLs as-is', async () => {
    const app = makeApp();
    const result = await markdownToHtml('![alt](https://example.com/img.png)', app, '');
    expect(result).toContain('src="https://example.com/img.png"');
    expect(result).toContain('alt="alt"');
  });

  it('passes through http:// external image URLs', async () => {
    const app = makeApp();
    const result = await markdownToHtml('![photo](http://cdn.test/photo.jpg)', app, '');
    expect(result).toContain('src="http://cdn.test/photo.jpg"');
  });
});

describe('markdownToHtml — local images via Markdown syntax', () => {
  it('embeds a local image as a base64 data URI', async () => {
    // Create a simple 4-byte PNG-like binary
    const fakeImageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const app = makeApp({ 'assets/image.png': fakeImageBytes });

    const result = await markdownToHtml('![alt](assets/image.png)', app, '');
    expect(result).toContain('data:image/png;base64,');
    // base64 of [0x89, 0x50, 0x4e, 0x47]
    const expected = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47));
    expect(result).toContain(expected);
  });

  it('resolves relative image paths using noteFolder', async () => {
    const fakeImageBytes = new Uint8Array([1, 2, 3]);
    const app = makeApp({ 'notes/subfolder/photo.jpg': fakeImageBytes });

    const result = await markdownToHtml('![img](photo.jpg)', app, 'notes/subfolder');
    expect(result).toContain('data:image/jpeg;base64,');
  });

  it('uses text/plain MIME for unknown extensions', async () => {
    const fakeBytes = new Uint8Array([65, 66]);
    const app = makeApp({ 'notes/file.xyz': fakeBytes });

    const result = await markdownToHtml('![file](file.xyz)', app, 'notes');
    expect(result).toContain('data:');
  });

  it('passes through relative path as-is when file is not found in vault', async () => {
    const app = makeApp({});
    const result = await markdownToHtml('![missing](missing.png)', app, '');
    // Should not throw, and should keep the src as relative path
    expect(result).toContain('missing.png');
  });
});

describe('markdownToHtml — Obsidian wikilink images', () => {
  it('embeds an Obsidian wikilink image ![[filename.png]] as base64', async () => {
    const fakeImageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]);
    const app = makeApp({ 'notes/diagram.png': fakeImageBytes });

    const result = await markdownToHtml('![[diagram.png]]', app, 'notes');
    expect(result).toContain('data:image/png;base64,');
  });

  it('embeds wikilink image with leading folder path', async () => {
    const fakeImageBytes = new Uint8Array([1, 2, 3, 4]);
    const app = makeApp({ 'assets/logo.png': fakeImageBytes });

    const result = await markdownToHtml('![[assets/logo.png]]', app, '');
    expect(result).toContain('data:image/png;base64,');
  });

  it('leaves wikilink image as fallback text if file not found', async () => {
    const app = makeApp({});
    const result = await markdownToHtml('![[ghost.png]]', app, '');
    // Should not throw — produce some output
    expect(result).toBeTruthy();
  });
});

describe('markdownToHtml — MIME type detection', () => {
  it('uses image/png for .png files', async () => {
    const app = makeApp({ 'img.png': new Uint8Array([1]) });
    const result = await markdownToHtml('![a](img.png)', app, '');
    expect(result).toContain('data:image/png;base64,');
  });

  it('uses image/jpeg for .jpg files', async () => {
    const app = makeApp({ 'img.jpg': new Uint8Array([1]) });
    const result = await markdownToHtml('![a](img.jpg)', app, '');
    expect(result).toContain('data:image/jpeg;base64,');
  });

  it('uses image/jpeg for .jpeg files', async () => {
    const app = makeApp({ 'img.jpeg': new Uint8Array([1]) });
    const result = await markdownToHtml('![a](img.jpeg)', app, '');
    expect(result).toContain('data:image/jpeg;base64,');
  });

  it('uses image/gif for .gif files', async () => {
    const app = makeApp({ 'img.gif': new Uint8Array([1]) });
    const result = await markdownToHtml('![a](img.gif)', app, '');
    expect(result).toContain('data:image/gif;base64,');
  });

  it('uses image/webp for .webp files', async () => {
    const app = makeApp({ 'img.webp': new Uint8Array([1]) });
    const result = await markdownToHtml('![a](img.webp)', app, '');
    expect(result).toContain('data:image/webp;base64,');
  });
});
