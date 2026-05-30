# Obsidian Google Docs Sync

Bi-directional sync between Obsidian notes and Google Docs. Tag a note or drop it in a sync folder and it stays in sync with a Google Doc automatically.

**Companion repo:** [`rbcodelabs/obsidian-gdocs-auth`](https://github.com/rbcodelabs/obsidian-gdocs-auth) — the Vercel-hosted OAuth proxy that keeps your Google `client_secret` off the client.

## Documentation

**[→ Full user docs on the Wiki](https://github.com/rbcodelabs/obsidian-gdocs-sync/wiki)**

- [Installation & setup](https://github.com/rbcodelabs/obsidian-gdocs-sync/wiki/Installation)
- [Syncing notes](https://github.com/rbcodelabs/obsidian-gdocs-sync/wiki/Syncing-Notes)
- [Importing Google Docs](https://github.com/rbcodelabs/obsidian-gdocs-sync/wiki/Importing-Google-Docs)
- [Settings reference](https://github.com/rbcodelabs/obsidian-gdocs-sync/wiki/Settings-Reference)
- [Troubleshooting](https://github.com/rbcodelabs/obsidian-gdocs-sync/wiki/Troubleshooting)

---

## Features

- **Auto-sync on save** — changes push to Google Docs ~2s after you stop typing
- **Remote polling** — Google Doc changes are pulled every 30s
- **Tag-based sync** — add the `gdocs-sync` tag to any note
- **Folder-based sync** — configure folders that auto-sync all notes inside
- **Import by URL** — pull an existing Google Doc into Obsidian via the command palette
- **Drive folder import** — paste a Google Drive folder URL to import all Docs inside it (including subfolders) as notes, with the folder structure mirrored in your vault
- **Automatic new-doc detection** — mapped Drive folders are polled every 5 minutes; new Docs added by anyone are imported automatically
- **Frontmatter metadata** — each synced note stores its doc ID, URL, and last-sync hash
- **Conflict resolution** — last-write-wins (v1); full diff/merge UI planned for v2

---

## Installation

### Manual (development)

1. Clone this repo
2. Build the plugin (see [Building](#building) below)
3. Copy `main.js` and `manifest.json` into your vault's plugin folder:
   ```
   <your-vault>/.obsidian/plugins/obsidian-gdocs-sync/
   ```
4. In Obsidian: **Settings → Community Plugins → Installed Plugins** → enable **Google Docs Sync**

### Community Plugin Store

Not yet submitted. Tracked in [Next Steps](#next-steps).

---

## Setup

### 1. Google Cloud Project

You need a Google Cloud project with the Docs and Drive APIs enabled and an OAuth 2.0 **Web application** credential.

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → **APIs & Services → Credentials**
2. Create an OAuth 2.0 Client ID (type: **Web application**)
3. Add these authorized redirect URIs:
   - `https://obsidian-gdocs-auth.vercel.app/api/auth/callback` (production)
   - `http://localhost:3010/api/auth/callback` (local dev)
4. Enable APIs: **Google Docs API** and **Google Drive API**

### 2. Auth Proxy

The plugin never holds your `client_secret`. Instead, OAuth token exchange happens server-side via a small Next.js proxy.

- **Production proxy (hosted):** `https://obsidian-gdocs-auth.vercel.app` — already deployed, uses `rbcodelabs` Google Cloud credentials
- **Self-hosted:** see [`obsidian-gdocs-auth`](https://github.com/rbcodelabs/obsidian-gdocs-auth) for setup

### 3. Connect your Google account

1. **Settings → Google Docs Sync**
2. Confirm the **Auth Proxy URL** is `https://obsidian-gdocs-auth.vercel.app`
3. Click **Connect Google Account** — a browser window opens, you authorize, Obsidian reopens automatically
4. Settings should show your Google email as connected

### 4. Start syncing

- Add the `gdocs-sync` tag to any note, **or**
- Configure a sync folder under **Settings → Sync Folders**
- **Cmd+P → "Sync current note to Google Docs"** for an immediate manual sync

---

## Building

```bash
npm install

# Development — watch mode (rebuilds on file change)
npm run dev

# Production build
npm run build
```

Output: `main.js` in the project root (the file Obsidian loads).

**Requirements:** Node 18+, TypeScript 5.x

---

## Testing

### Automated tests

The converter layer has full unit test coverage using [Vitest](https://vitest.dev/):

```bash
npm test
```

Tests live in `tests/converter/` and cover:

| File | What's tested |
|---|---|
| `HtmlToMarkdown.test.ts` | GDocs HTML export → Markdown: headings, inline styles, lists (ordered / unordered / checkbox / nested), tables, code blocks, links, horizontal rules |
| `MarkdownToGDocs.test.ts` | Markdown → GDocs batchUpdate requests: all block types, inline styles, list nesting, GFM tables (cell index math, header boldness, inline styles in cells) |

Test payloads are captured from the live API where relevant — no mocks for conversion logic — so format regressions are caught without running Obsidian.

### Manual / integration testing

To verify the full sync loop end-to-end:

1. Build and install the plugin (see above)
2. Connect a Google account via plugin settings
3. Create a note with the `gdocs-sync` tag
4. Run **Cmd+P → "Sync current note to Google Docs"**
5. Verify a Google Doc was created and the note's frontmatter contains:
   ```yaml
   gdocs-id: <doc-id>
   gdocs-url: https://docs.google.com/document/d/<doc-id>/edit
   gdocs-last-sync: <ISO timestamp>
   gdocs-hash: <sha256>
   ```
6. Edit the Google Doc, wait ~30s, verify the Obsidian note updates
7. Edit the Obsidian note, wait ~2s, verify the Google Doc updates

**Console logs:** Enable the browser devtools console in Obsidian (`Cmd+Option+I`) — the plugin logs all sync events prefixed with `[GDocsPlugin]`, `[SyncEngine]`, `[TokenStore]`, etc.

---

## Architecture

```
src/
  main.ts                   Plugin entry — registers commands, protocol handler, settings tab
  types.ts                  GDocsTokens, SyncMeta, GDocsPluginSettings, DEFAULT_SETTINGS
  settings.ts               Settings tab UI (connect/disconnect, proxy URL, sync tag, folders)
  auth/
    GoogleAuth.ts           OAuth connect/disconnect, handleCallback(), pendingState CSRF check
    TokenStore.ts           Token get/set/refresh via proxy /api/auth/refresh
  api/
    GoogleDocsAPI.ts        Typed wrapper for Google Docs API + Drive API
  converter/
    MarkdownToGDocs.ts      Markdown → GDocs batchUpdate requests
    GDocsToMarkdown.ts      GDocs document → Markdown string
  sync/
    SyncEngine.ts           Core orchestrator — queue deduplication, frontmatter updates
    FileWatcher.ts          vault.on('modify') + 2s debounce → SyncEngine
    GDocsPoller.ts          setInterval revision check → SyncEngine
    FolderPoller.ts         Every 5min — checks mapped Drive folders for new docs
    ConflictResolver.ts     Last-write-wins (v1)
  ui/
    StatusBar.ts            ⇅ GDocs status bar item
    ImportModal.ts          Import a Google Doc by URL or ID
    FolderImportModal.ts    Import an entire Drive folder by URL
```

### Auth flow

```
Plugin → opens browser → obsidian-gdocs-auth.vercel.app/api/auth/start?state=<uuid>
  → Google consent screen
  → /api/auth/callback (proxy exchanges code for tokens server-side)
  → obsidian://gdocs-sync?event=auth_complete&access_token=…&refresh_token=…
  → Plugin's protocol handler stores tokens
```

### Sync flow

```
FILE MODIFY (Obsidian)
  → debounce 2s
  → check tag / folder rules
  → hash content, compare to gdocs-hash frontmatter
  → if changed: clearDocument → markdownToGDocsRequests → batchUpdate
  → update frontmatter (gdocs-id, gdocs-url, gdocs-last-sync, gdocs-hash)

POLL TICK (every 30s)
  → GET /v1/documents/{id}?fields=revisionId  (cheap revision check)
  → if revision changed: fetch full doc → gdocsToMarkdown → write file

FOLDER POLL TICK (every 5 min)
  → for each folderMapping: Drive API list all docs recursively
  → for each doc not yet in vault: import as note, mirror subfolder structure
  → register new notes in syncedDocs for per-doc polling
```

### Frontmatter written by plugin

```yaml
gdocs-id: 1UQ9DeAID5wsCzDRlnZOpOliHU2aAnUB4fbsZ8n2Zd20
gdocs-url: https://docs.google.com/document/d/1UQ9.../edit
gdocs-last-sync: 2026-05-10T16:20:00.000Z
gdocs-hash: abc123...
```

### Format conversion coverage

| Feature | MD → GDocs | GDocs → MD |
|---|---|---|
| Headings H1–H6 | ✅ | ✅ |
| Bold, italic, bold+italic | ✅ | ✅ |
| Strikethrough | ✅ | ✅ |
| Inline code | ✅ | ✅ |
| Fenced code blocks | ✅ | ✅ |
| Ordered lists | ✅ | ✅ |
| Unordered lists | ✅ | ✅ |
| Links | ✅ | ✅ |
| Horizontal rules | ✅ | — |
| Tables | ✅ | ✅ |
| Nested list levels | ❌ v2 (flattened) | ✅ |
| Blockquotes | ❌ v2 | ❌ v2 |

---

## Next Steps

- [ ] Submit to Obsidian community plugins store (needs public repo + PR to `obsidian-releases`)
- [ ] Google OAuth verification (removes "unverified app" warning for new users)
- [ ] v2: nested list nesting in MD → GDocs direction
- [ ] v2: blockquote support (GFM `>` ↔ GDocs quote style)
- [ ] v2: diff/merge conflict UI instead of last-write-wins
- [ ] v2: choose destination folder when importing a Google Doc

---

## License

MIT
