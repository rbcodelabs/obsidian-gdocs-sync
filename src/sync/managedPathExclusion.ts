import type { GDocsPluginSettings } from '../types';
export function managedPathExclusion(path: string, data: ArrayBuffer | undefined, settings: GDocsPluginSettings, parseYaml: (text: string) => unknown): string | null {
  const belongs = (folder: string) => { const normalized = folder.replace(/\/+$/, ''); return normalized.length > 0 && (path === normalized || path.startsWith(`${normalized}/`)); };
  if (settings.syncFolders.some(belongs) || settings.folderMappings.some(mapping => belongs(mapping.obsidianFolder))) return 'Managed by Google Docs sync; excluded to prevent two independent writers';
  if (belongs(settings.tasksFolder)) return 'Managed by Google Tasks sync; excluded to prevent two independent writers';
  if (!path.toLowerCase().endsWith('.md') || !data) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/^\uFEFF/, '');
    if (!/^---\r?\n/.test(text)) return null;
    const match = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(text);
    if (!match) return 'Cannot verify Markdown sync ownership: incomplete frontmatter';
    const parsed = parseYaml(match[1]);
    if (parsed === null || parsed === undefined) return null;
    if (typeof parsed !== 'object' || Array.isArray(parsed)) return 'Cannot verify Markdown sync ownership: invalid frontmatter';
    const frontmatter = parsed as Record<string, unknown>;
    if (frontmatter['gdocs-id']) return 'Linked to Google Docs; excluded to prevent two independent writers';
    if (frontmatter.gtasks_id) return 'Linked to Google Tasks; excluded to prevent two independent writers';
    const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [frontmatter.tags];
    if (settings.syncTag && tags.includes(settings.syncTag)) return 'Eligible for Google Docs tag sync; excluded before initial linking';
  } catch { return 'Cannot verify Markdown sync ownership: unreadable frontmatter'; }
  return null;
}
