/**
 * Editor for files opened without a session — from Finder ("Open With" /
 * double-click), ⌘O or a drop onto the window. It takes over the main area
 * while a file is open; state lives in lib/standalone-files.ts.
 *
 * Deliberately lighter than the session editor: no LSP, explorer or AI
 * actions — those need a project root, which a lone file doesn't have.
 */
import { useEffect, useState } from 'react';
import Editor from '@monaco-editor/react';
import { FolderOpen, X, AlertTriangle } from 'lucide-react';
import { TabPill } from '../panels/Panel';
import type { ClaudeClient } from '../lib/claude-client';
import { getNative } from '../lib/native';
import { MONO_FONT_STACK } from '../lib/fonts';
import { registerDotenv } from '../lib/monaco-dotenv';
import { isMac } from '../lib/keybindings';
import {
  useStandaloneFiles,
  openStandaloneFiles,
  promptStandalonePath,
  dismissStandalonePath,
  setActiveStandaloneFile,
  editStandaloneFile,
  saveStandaloneFile,
  closeStandaloneFile,
  clearStandaloneNotice,
  bufferFor,
  baseName,
} from '../lib/standalone-files';

/** Native Open dialog, or null outside the desktop app. */
export async function pickFilesToOpen(): Promise<string[] | null> {
  const native = getNative();
  if (!native) return null;
  return await native.invoke<string[]>('pick_paths').catch(() => []);
}

/**
 * ⌘O: the native dialog in the app, the path field in a browser tab. `open`
 * decides where the picked files land (ChatApp routes them to the active
 * session when it can); by default they open here.
 */
export async function openFileDialog(
  client: ClaudeClient | null,
  open: (paths: string[]) => Promise<void> = (paths) => (client ? openStandaloneFiles(client, paths) : Promise.resolve()),
) {
  if (!client) return;
  const paths = await pickFilesToOpen();
  if (paths === null) promptStandalonePath();
  else await open(paths);
}

/** Close with a confirm when there are unsaved edits. */
export function confirmCloseStandaloneFile(path: string) {
  const tab = useStandaloneFiles.getState().tabs.find(t => t.path === path);
  if (tab?.dirty && !window.confirm(`${baseName(path)} tiene cambios sin guardar. ¿Cerrar de todos modos?`)) return;
  closeStandaloneFile(path);
}

/** Closes every tab, after one confirm if any has unsaved edits. */
function confirmCloseAll() {
  const { tabs } = useStandaloneFiles.getState();
  const dirty = tabs.filter(t => t.dirty).length;
  if (dirty && !window.confirm(dirty === 1 ? 'Hay un archivo con cambios sin guardar. ¿Cerrar de todos modos?' : `Hay ${dirty} archivos con cambios sin guardar. ¿Cerrar de todos modos?`)) return;
  for (const t of tabs) closeStandaloneFile(t.path);
  dismissStandalonePath();
}

/** `onOpenPaths` decides where newly picked files go (ChatApp's router); defaults to this editor. */
export function StandaloneEditor({ client, onOpenPaths }: { client: ClaudeClient | null; onOpenPaths?: (paths: string[]) => Promise<void> }) {
  const openPaths = (paths: string[]) => (onOpenPaths ? onOpenPaths(paths) : client ? openStandaloneFiles(client, paths) : Promise.resolve());
  const tabs = useStandaloneFiles(s => s.tabs);
  const activePath = useStandaloneFiles(s => s.activePath);
  const pathPrompt = useStandaloneFiles(s => s.pathPrompt);
  const notice = useStandaloneFiles(s => s.notice);
  const [pathInput, setPathInput] = useState('');
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(clearStandaloneNotice, 6000);
    return () => clearTimeout(t);
  }, [notice]);

  const active = tabs.find(t => t.path === activePath) ?? null;
  const mod = isMac ? '⌘' : 'Ctrl+';

  const save = async (path: string) => {
    if (!client) return;
    setSaveError('');
    if (!(await saveStandaloneFile(client, path))) setSaveError(`No se pudo guardar ${baseName(path)}.`);
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-surface">
      {/* Same strip as the session's panels (variant B: underline tabs). */}
      <div className="flex h-[32px] shrink-0 items-stretch gap-0.5 border-b border-border bg-surface px-1">
        <div className="flex min-w-0 flex-1 items-stretch">
          {tabs.map(t => (
            <div key={t.path} className="flex" title={t.path} onAuxClick={(e) => { if (e.button === 1) confirmCloseStandaloneFile(t.path); }}>
              <TabPill
                tab={{ id: t.path, kind: t.error ? 'error' : 'editor', title: baseName(t.path), icon: t.error ? '⚠' : undefined, dirty: t.dirty }}
                active={t.path === activePath}
                focused
                onActivate={() => setActiveStandaloneFile(t.path)}
                onClose={() => confirmCloseStandaloneFile(t.path)}
              />
            </div>
          ))}
        </div>
        <button
          onClick={() => void openFileDialog(client, openPaths)}
          title={`Abrir archivo… (${mod}O)`}
          className="flex shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-zinc-500 transition-colors hover:text-zinc-100"
        >
          <FolderOpen size={13} />
          <span>Abrir</span>
        </button>
        <button
          onClick={confirmCloseAll}
          title="Cerrar el editor"
          aria-label="Cerrar el editor"
          className="flex w-8 shrink-0 items-center justify-center text-zinc-500 transition-colors hover:text-zinc-100"
        >
          <X size={14} />
        </button>
      </div>

      {pathPrompt && (
        <form
          className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            const path = pathInput.trim();
            setPathInput('');
            dismissStandalonePath();
            if (path) void openPaths([path]);
          }}
        >
          <input
            autoFocus
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') dismissStandalonePath(); }}
            placeholder="Ruta absoluta del archivo en esta máquina"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-md border border-border bg-base px-2.5 py-1 font-mono text-[12px] text-zinc-100 placeholder:font-sans placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
          />
          <button type="submit" className="rounded-md bg-zinc-100 px-3 py-1 text-[12px] font-medium text-zinc-900 hover:opacity-90">Abrir</button>
        </form>
      )}

      {active && (
        <div className="flex h-7 shrink-0 items-center gap-3 border-b border-border px-3 text-[11.5px] text-zinc-500">
          <span className="min-w-0 truncate font-mono" title={active.path}>{active.path}</span>
          {saveError && <span className="shrink-0 text-red-400">{saveError}</span>}
          {active.dirty && (
            <button onClick={() => void save(active.path)} className="ml-auto shrink-0 text-zinc-400 hover:text-zinc-100">
              Guardar ({mod}S)
            </button>
          )}
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {!active ? null : active.error ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <AlertTriangle size={22} className="text-amber-400" />
            <div className="text-[13px] text-zinc-300">{active.error}</div>
            <div className="font-mono text-[11.5px] text-zinc-500">{active.path}</div>
          </div>
        ) : (
          <Editor
            key={active.path}
            path={active.path}
            defaultValue={bufferFor(active)}
            theme="vs-dark"
            beforeMount={(monaco) => registerDotenv(monaco)}
            onMount={(editor, monaco) => {
              // ⌘S inside Monaco; the global save command covers focus elsewhere.
              editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save(active.path));
              // Leave focus on the path field when it's the reason the editor opened.
              if (!useStandaloneFiles.getState().pathPrompt) editor.focus();
            }}
            onChange={(value) => editStandaloneFile(active.path, value ?? '')}
            options={{
              minimap: { enabled: false },
              fontFamily: MONO_FONT_STACK,
              fontSize: 13,
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              padding: { top: 8 },
              automaticLayout: true,
              // A file dropped on the editor opens as a tab (window handler)
              // instead of Monaco pasting its path into the text.
              dropIntoEditor: { enabled: false },
            }}
          />
        )}
        {notice && (
          <div
            role="status"
            onClick={clearStandaloneNotice}
            className="absolute bottom-4 left-1/2 max-w-[90%] -translate-x-1/2 cursor-default truncate rounded-lg border border-border-light bg-surface-lighter px-3 py-1.5 text-[12px] text-zinc-200 shadow-lg"
          >
            {notice}
          </div>
        )}
      </div>
    </div>
  );
}
