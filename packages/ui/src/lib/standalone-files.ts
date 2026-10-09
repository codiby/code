/**
 * Files opened on their own — from Finder ("Open With" / double-click), the
 * Open dialog (⌘O) or a drop onto the window — rather than from a session's
 * explorer. They live outside every session's editor state, so no session is
 * needed and switching sessions doesn't touch them.
 *
 * The editor appears over the main area when a file is opened and steps aside
 * when the user goes back to a session; its tabs stay until closed and come
 * back with the next open. Nothing persists across launches.
 *
 * Paths are always on *this* machine (the OS hands them over), so reads and
 * writes are pinned to the local bridge regardless of which session is
 * focused. Unsaved text lives in `buffers`, outside React state, so typing
 * doesn't re-render; only the dirty flag goes through the store.
 */
import { create } from 'zustand';
import type { ClaudeClient } from './claude-client';

export type StandaloneTab = {
  path: string;
  /** Last content read from or written to disk. */
  content: string;
  dirty: boolean;
  /** Set when the file couldn't be opened as text; the tab shows it instead of an editor. */
  error: string | null;
};

type State = {
  tabs: StandaloneTab[];
  activePath: string | null;
  /** The editor is showing over the main area. */
  visible: boolean;
  /** Path field shown instead of the native Open dialog (browser tabs have none). */
  pathPrompt: boolean;
  /** One-line explanation of why the file opened here and not next to the chat. */
  notice: string | null;
};

export const useStandaloneFiles = create<State>(() => ({ tabs: [], activePath: null, visible: false, pathPrompt: false, notice: null }));

export function clearStandaloneNotice() {
  useStandaloneFiles.setState({ notice: null });
}

const buffers = new Map<string, string>();

export const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path;

/** Text the editor should show: unsaved edits if any, else what's on disk. */
export function bufferFor(tab: StandaloneTab): string {
  return buffers.get(tab.path) ?? tab.content;
}

async function load(client: ClaudeClient, path: string): Promise<StandaloneTab> {
  try {
    const file = await client.readFile(path, null);
    if (!file) return { path, content: '', dirty: false, error: 'No se pudo leer el archivo (no existe, es una carpeta o es demasiado grande).' };
    if (file.content.includes('\u0000')) return { path, content: '', dirty: false, error: 'Es un archivo binario; solo se abren archivos de texto.' };
    return { path, content: file.content, dirty: false, error: null };
  } catch (err) {
    return { path, content: '', dirty: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Reads a local file for any editor; null content comes with the reason it can't be shown. */
export async function readLocalText(client: ClaudeClient, path: string): Promise<{ content: string; error: null } | { content: null; error: string }> {
  const tab = await load(client, path);
  return tab.error ? { content: null, error: tab.error } : { content: tab.content, error: null };
}

/** Opens (or focuses) each path and shows the editor; the last path becomes active. */
export async function openStandaloneFiles(client: ClaudeClient, paths: string[], notice: string | null = null): Promise<void> {
  const wanted = [...new Set(paths.filter(Boolean))];
  if (wanted.length === 0) return;
  const known = new Set(useStandaloneFiles.getState().tabs.map(t => t.path));
  const loaded = await Promise.all(wanted.filter(p => !known.has(p)).map(p => load(client, p)));
  useStandaloneFiles.setState(s => ({
    tabs: [...s.tabs, ...loaded.filter(t => !s.tabs.some(x => x.path === t.path))],
    activePath: wanted[wanted.length - 1]!,
    visible: true,
    notice,
  }));
}

/** Shows the browser fallback for the Open dialog. */
export function promptStandalonePath() {
  useStandaloneFiles.setState({ visible: true, pathPrompt: true });
}

export function dismissStandalonePath() {
  useStandaloneFiles.setState(s => ({ pathPrompt: false, visible: s.visible && s.tabs.length > 0 }));
}

/** Steps aside without closing anything — the tabs return with the next open. */
export function hideStandaloneEditor() {
  if (useStandaloneFiles.getState().visible) useStandaloneFiles.setState({ visible: false, pathPrompt: false });
}

export function setActiveStandaloneFile(path: string) {
  useStandaloneFiles.setState({ activePath: path });
}

export function editStandaloneFile(path: string, value: string) {
  buffers.set(path, value);
  const tab = useStandaloneFiles.getState().tabs.find(t => t.path === path);
  if (!tab) return;
  const dirty = value !== tab.content;
  if (dirty !== tab.dirty) {
    useStandaloneFiles.setState(s => ({ tabs: s.tabs.map(t => (t.path === path ? { ...t, dirty } : t)) }));
  }
}

/** Writes the buffer to disk. Returns false when the bridge refused the write. */
export async function saveStandaloneFile(client: ClaudeClient, path: string): Promise<boolean> {
  const tab = useStandaloneFiles.getState().tabs.find(t => t.path === path);
  if (!tab || tab.error) return false;
  const value = bufferFor(tab);
  const ok = await client.writeFile(path, value, null);
  if (ok) {
    buffers.delete(path);
    useStandaloneFiles.setState(s => ({ tabs: s.tabs.map(t => (t.path === path ? { ...t, content: value, dirty: false } : t)) }));
  }
  return ok;
}

/** Closes a tab, dropping unsaved edits; the editor hides with its last tab. Callers confirm first when dirty. */
export function closeStandaloneFile(path: string) {
  buffers.delete(path);
  useStandaloneFiles.setState(s => {
    const idx = s.tabs.findIndex(t => t.path === path);
    const tabs = s.tabs.filter(t => t.path !== path);
    const activePath = s.activePath !== path ? s.activePath : (tabs[Math.min(idx, tabs.length - 1)]?.path ?? null);
    return { tabs, activePath, visible: s.visible && (tabs.length > 0 || s.pathPrompt) };
  });
}
