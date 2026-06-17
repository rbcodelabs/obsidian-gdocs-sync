import { WorkspaceLeaf, MarkdownView, TFile } from 'obsidian';
import { SyncEngine, stripFrontmatter } from '../sync/SyncEngine';
import { GDocsPluginSettings } from '../types';

// sha256 via Web Crypto — reimplemented locally to avoid exporting it from SyncEngine
async function sha256(text: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(text);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Minimal interface — avoids importing GDocsPlugin directly (circular dep risk)
interface GDocsPluginLike {
	app: import('obsidian').App;
	registerEvent(event: import('obsidian').EventRef): void;
	syncEngine: SyncEngine;
	settings: GDocsPluginSettings;
	/** Per-file error messages surfaced by push/pull failures */
	perFileErrors?: Map<string, string>;
}

/**
 * FileCommandBar injects a slim action bar between the view header and the
 * editor content for every Markdown leaf whose open file has a gdocs-id
 * frontmatter field. The bar surfaces sync state and Push / Pull controls
 * so the user can act without leaving the document.
 */
export class FileCommandBar {
	/** Map from leaf.id → injected bar wrapper element */
	private bars: Map<string, HTMLElement> = new Map();

	/**
	 * Dirty-state cache per file path.
	 * `undefined`   — not yet checked
	 * `'checking'`  — async check in flight
	 * `true/false`  — resolved result
	 */
	private dirtyCache: Map<string, boolean | 'checking'> = new Map();

	constructor(private plugin: GDocsPluginLike) {
		plugin.registerEvent(
			plugin.app.workspace.on('file-open', () => {
				// Give the view DOM one tick to settle before injecting
				setTimeout(() => this.refresh(), 60);
			})
		);
		plugin.registerEvent(
			plugin.app.workspace.on('layout-change', () => {
				this.refresh();
			})
		);
	}

	/**
	 * Called after a sync completes for the given file path.
	 * Clears the dirty cache for that path and re-renders all bars.
	 */
	update(filePath?: string): void {
		if (filePath) {
			this.dirtyCache.delete(filePath);
		} else {
			this.dirtyCache.clear();
		}
		this.refresh();
	}

	/** Remove all injected bars — call on plugin unload. */
	destroy(): void {
		for (const bar of this.bars.values()) bar.remove();
		this.bars.clear();
		this.dirtyCache.clear();
	}

	/**
	 * Reconcile bars across every open leaf:
	 * - Leaves showing a gdocs-linked file get a bar (created or content-updated).
	 * - Leaves showing a non-linked file have any bar removed.
	 * - Bars whose leaf has since closed are cleaned up.
	 */
	refresh(): void {
		const activeLeafIds = new Set<string>();

		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			if (!(leaf.view instanceof MarkdownView)) return;
			const file = (leaf.view as MarkdownView).file;
			if (!file) return;

			const id = this.leafId(leaf);
			activeLeafIds.add(id);

			const meta = this.plugin.app.metadataCache.getFileCache(file);
			const docId: string | undefined = meta?.frontmatter?.['gdocs-id'];

			if (docId) {
				this.renderBar(leaf, id, file, docId);
			} else {
				this.removeBar(id);
			}
		});

		// Clean up bars for leaves that are no longer open
		for (const id of [...this.bars.keys()]) {
			if (!activeLeafIds.has(id)) {
				this.removeBar(id);
			}
		}
	}

	// ── Private helpers ─────────────────────────────────────────────────────

	private leafId(leaf: WorkspaceLeaf): string {
		return (leaf as unknown as { id: string }).id;
	}

	private removeBar(id: string): void {
		const existing = this.bars.get(id);
		if (existing) {
			existing.remove();
			this.bars.delete(id);
		}
	}

	private renderBar(leaf: WorkspaceLeaf, leafId: string, file: TFile, docId: string): void {
		let bar = this.bars.get(leafId);

		if (!bar) {
			// Insert the bar between .view-header and .view-content
			const viewContent = leaf.view.containerEl.querySelector('.view-content');
			if (!viewContent || !viewContent.parentElement) return;

			bar = createEl('div', { cls: 'gdocs-command-bar' });
			viewContent.parentElement.insertBefore(bar, viewContent);
			this.bars.set(leafId, bar);
		}

		this.buildBarContent(bar, file, docId);
	}

	private buildBarContent(bar: HTMLElement, file: TFile, docId: string): void {
		const meta = this.plugin.app.metadataCache.getFileCache(file);
		const fm = meta?.frontmatter;

		const gdocsUrl: string = fm?.['gdocs-url'] ?? `https://docs.google.com/document/d/${docId}/edit`;
		const lastSync: string | undefined = fm?.['gdocs-hash'] !== undefined
			? fm?.['gdocs-last-sync']
			: undefined;
		const gdocsHash: string | undefined = fm?.['gdocs-hash'];

		const isSyncing = this.plugin.syncEngine.isSyncing(file.path) || this.plugin.syncEngine.isSyncing(docId);
		const errorMsg: string | undefined = this.plugin.perFileErrors?.get(file.path);
		const isError = !!errorMsg;

		// Determine dirty state from cache
		const cachedDirty = this.dirtyCache.get(file.path);
		const isDirty = cachedDirty === true;

		// Kick off async dirty check if not yet cached and we have a hash to compare
		if (cachedDirty === undefined && gdocsHash !== undefined && !isSyncing) {
			this.dirtyCache.set(file.path, 'checking');
			this.checkDirty(file, gdocsHash).then((dirty) => {
				// Only update if the file is still open in the workspace
				let stillOpen = false;
				this.plugin.app.workspace.iterateAllLeaves((l) => {
					if (l.view instanceof MarkdownView && l.view.file?.path === file.path) {
						stillOpen = true;
					}
				});
				if (stillOpen) {
					this.dirtyCache.set(file.path, dirty);
					this.refresh();
				}
			});
		}

		// Reset state classes
		bar.className = 'gdocs-command-bar';
		if (isDirty && !isError && !isSyncing) bar.addClass('is-dirty');
		if (isError) bar.addClass('is-error');
		if (isSyncing) bar.addClass('is-syncing');

		bar.empty();

		// ── Left: status icon + identity + status label ─────────────────────
		const info = bar.createEl('div', { cls: 'gdocs-bar-info' });

		const iconText = isSyncing ? '↻' : isError ? '✕' : isDirty ? '●' : '✓';
		info.createEl('span', {
			cls: 'gdocs-bar-icon',
			text: iconText,
			attr: { 'aria-hidden': 'true' },
		});

		info.createEl('span', { cls: 'gdocs-bar-name', text: 'Google Docs' });

		// Clickable pill showing doc title (or "linked doc") — opens the doc URL
		const docTitle = fm?.['gdocs-title'] as string | undefined;
		const pillLabel = docTitle ?? 'linked doc';
		const pill = info.createEl('button', {
			cls: 'gdocs-bar-doc-pill',
			attr: {
				type: 'button',
				'aria-label': `Open Google Doc: ${pillLabel}`,
				title: gdocsUrl,
			},
		});
		pill.createEl('span', { text: pillLabel });
		pill.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			window.open(gdocsUrl, '_blank');
		});

		// Status label
		if (isSyncing) {
			info.createEl('span', { cls: 'gdocs-bar-status-label is-syncing', text: 'syncing…' });
		} else if (isError) {
			info.createEl('span', {
				cls: 'gdocs-bar-status-label is-error',
				text: errorMsg,
				attr: { title: errorMsg },
			});
		} else if (isDirty) {
			info.createEl('span', { cls: 'gdocs-bar-status-label is-dirty', text: '● local edits' });
		} else if (cachedDirty === 'checking') {
			info.createEl('span', { cls: 'gdocs-bar-status-label is-syncing', text: 'checking…' });
		} else if (lastSync) {
			const rel = this.relativeTime(lastSync);
			info.createEl('span', {
				cls: 'gdocs-bar-status-label is-clean',
				text: `synced ${rel}`,
				attr: { title: new Date(lastSync).toLocaleString() },
			});
		}

		// ── Right: action buttons ────────────────────────────────────────────
		const actions = bar.createEl('div', { cls: 'gdocs-bar-actions' });

		const pushBtnCls = isDirty && !isSyncing ? 'gdocs-bar-btn is-cta' : 'gdocs-bar-btn';
		const pushBtn = actions.createEl('button', {
			cls: pushBtnCls,
			text: '↑ Push',
			attr: { 'aria-label': 'Push local changes to Google Docs' },
		});
		pushBtn.disabled = isSyncing;
		pushBtn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			void this.plugin.syncEngine.syncLocalToRemote(file, true).then(() => {
				this.update(file.path);
			});
		});

		const pullBtn = actions.createEl('button', {
			cls: 'gdocs-bar-btn',
			text: '↓ Pull',
			attr: { 'aria-label': 'Pull latest from Google Docs' },
		});
		pullBtn.disabled = isSyncing;
		pullBtn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			void this.plugin.syncEngine.syncRemoteToLocal(docId, true).then(() => {
				this.update(file.path);
			});
		});

		const openBtn = actions.createEl('button', {
			cls: 'gdocs-bar-btn',
			text: '↗',
			attr: { 'aria-label': 'Open in Google Docs' },
		});
		openBtn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			window.open(gdocsUrl, '_blank');
		});
	}

	/**
	 * Asynchronously determines whether the local file content differs from
	 * the last-synced hash stored in frontmatter.
	 */
	private async checkDirty(file: TFile, gdocsHash: string): Promise<boolean> {
		try {
			const raw = await this.plugin.app.vault.read(file);
			const body = stripFrontmatter(raw);
			const hash = await sha256(body);
			return hash !== gdocsHash;
		} catch {
			// If we can't read the file, assume not dirty rather than crashing
			return false;
		}
	}

	/** Returns a human-friendly relative time string (e.g. "3 min ago"). */
	private relativeTime(isoString: string): string {
		const diffMs = Date.now() - new Date(isoString).getTime();
		const diffMin = Math.floor(diffMs / 60_000);
		if (diffMin < 1) return 'just now';
		if (diffMin < 60) return `${diffMin} min ago`;
		const diffHr = Math.floor(diffMin / 60);
		if (diffHr < 24) return `${diffHr} hr ago`;
		return `${Math.floor(diffHr / 24)} days ago`;
	}
}
