import { useState } from 'react';
import {
  Check,
  FileEdit,
  FilePlus,
  FileText,
  Maximize2,
  Search,
  Terminal,
  Wrench,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@heroui/react';
import type { PermissionRequest } from '../../lib/claude-client';
import { DiffView } from './DiffView';
import { MobileDiffModal } from './MobileDiffModal';

interface Props {
  request: PermissionRequest;
  onRespond: (allow: boolean) => void;
}

/**
 * Compact permission UI for the mobile chat. Replaces the older chunky amber
 * card with a segmented (header / body / actions) layout:
 *
 *   ┌──────────────────────────────┐
 *   │  ▶  Run command        •     │   ← small header, pulse dot as urgency
 *   ├──────────────────────────────┤
 *   │  $ git status                │   ← body, tool-specific
 *   ├──────────────────────────────┤
 *   │  ✕ Deny     │     ✓ Allow    │   ← slim action row (min 44px tap)
 *   └──────────────────────────────┘
 *
 * The body renders tool-specifically: Bash shows a terminal-style command,
 * Edit shows a colored diff (with Expand → fullscreen), Write shows the
 * target path + a content peek, and the rest fall back to a short summary.
 */
export function PermissionCard({ request, onRespond }: Props) {
  const editParts = getEditParts(request);
  const bashCmd = getBashCommand(request);
  const writeParts = getWriteParts(request);
  const fallbackSummary = !editParts && !bashCmd && !writeParts ? summarise(request) : null;
  const [diffFullscreen, setDiffFullscreen] = useState(false);

  const { icon: Icon, label: toolLabel } = describeTool(request.toolName);

  return (
    <div className="mx-3 my-2 rounded-2xl bg-zinc-900/70 border border-white/10 overflow-hidden shadow-lg">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5 bg-white/[0.02]">
        <Icon size={13} className="shrink-0 text-amber-300" />
        <span className="text-[12px] font-medium text-zinc-200 truncate">{toolLabel}</span>
        <span
          className="ml-auto w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0"
          aria-label="Permission pending"
        />
      </div>

      {/* Body */}
      {request.title && (
        <p className="px-3 pt-2 text-[12px] text-zinc-300 leading-snug">{request.title}</p>
      )}

      {bashCmd ? (
        <div className="px-3 py-2">
          <div className="font-mono text-[12.5px] leading-relaxed bg-black/50 border border-white/5 rounded-lg px-3 py-2 text-zinc-100 whitespace-pre-wrap break-all max-h-48 overflow-auto">
            <span className="text-emerald-400 select-none mr-1.5">$</span>
            {bashCmd}
          </div>
        </div>
      ) : editParts || writeParts ? (() => {
        // Edit and Write share the same card layout: a file-name + expand
        // header, an inline DiffView, and a fullscreen MobileDiffModal on tap.
        // Writes are modeled as "all additions" by passing `original=''`, so
        // the whole content renders green — a clear visual signal that
        // approving creates a brand-new file (vs. an Edit that modifies one).
        const parts = editParts
          ? { filePath: editParts.filePath, original: editParts.oldStr, current: editParts.newStr, title: editParts.filePath || 'Edit' }
          : { filePath: writeParts!.filePath, original: '', current: writeParts!.content, title: writeParts!.filePath || 'Write' };
        return (
          <div className="px-3 py-2">
            {parts.filePath && (
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-[11px] font-mono text-zinc-400 truncate" title={parts.filePath}>
                  {parts.filePath.split('/').pop()}
                </span>
                <Button
                  variant="ghost"
                  onPress={() => setDiffFullscreen(true)}
                  className="h-auto min-w-0 shrink-0 flex items-center gap-1 text-[10px] text-zinc-500 active:text-zinc-200 px-1.5 py-0.5 rounded active:bg-white/5"
                  aria-label="Open diff fullscreen"
                >
                  <Maximize2 size={11} />
                  Expand
                </Button>
              </div>
            )}
            <div className="rounded-lg overflow-hidden border border-white/10">
              <DiffView
                original={parts.original}
                current={parts.current}
                maxHeight={240}
                wrap
                // Writes have no HEAD side — skipping the context-collapse
                // banner removes the "… N unchanged lines" noise that would
                // otherwise never appear (there are no unchanged lines).
                showAllContext={!editParts}
              />
            </div>
            <MobileDiffModal
              open={diffFullscreen}
              onClose={() => setDiffFullscreen(false)}
              textSource={{
                original: parts.original,
                current: parts.current,
                title: parts.title,
              }}
            />
          </div>
        );
      })() : fallbackSummary ? (
        <div className="px-3 py-2">
          <pre className="text-[11.5px] text-zinc-300 whitespace-pre-wrap break-all bg-black/40 border border-white/5 rounded-lg px-3 py-2 max-h-44 overflow-auto m-0 font-mono">
            {fallbackSummary}
          </pre>
        </div>
      ) : null}

      {/* Actions */}
      <div className="flex border-t border-white/10">
        <Button
          variant="ghost"
          onPress={() => onRespond(false)}
          className="flex-1 h-auto min-w-0 min-h-11 rounded-none flex items-center justify-center gap-1.5 text-[13px] font-medium text-red-300 active:bg-red-500/10 border-r border-white/10"
        >
          <X size={14} strokeWidth={2.5} />
          Deny
        </Button>
        <Button
          variant="ghost"
          onPress={() => onRespond(true)}
          className="flex-1 h-auto min-w-0 min-h-11 rounded-none flex items-center justify-center gap-1.5 text-[13px] font-semibold text-emerald-300 active:bg-emerald-500/10"
        >
          <Check size={14} strokeWidth={2.5} />
          Allow
        </Button>
      </div>
    </div>
  );
}

/** Tool-name → icon + short human label used in the card header. */
function describeTool(toolName: string): { icon: LucideIcon; label: string } {
  switch (toolName) {
    case 'Bash':         return { icon: Terminal, label: 'Run command' };
    case 'Edit':         return { icon: FileEdit, label: 'Edit file' };
    case 'Write':        return { icon: FilePlus, label: 'Write file' };
    case 'Read':         return { icon: FileText, label: 'Read file' };
    case 'NotebookEdit': return { icon: FileEdit, label: 'Edit notebook' };
    case 'Grep':
    case 'Glob':         return { icon: Search, label: toolName === 'Grep' ? 'Search content' : 'Find files' };
    default:             return { icon: Wrench, label: toolName };
  }
}

function getBashCommand(req: PermissionRequest): string | null {
  if (req.toolName !== 'Bash') return null;
  const input = (req.input || {}) as Record<string, unknown>;
  const cmd = typeof input.command === 'string' ? input.command.trim() : '';
  return cmd || null;
}

function getEditParts(req: PermissionRequest): { filePath: string; oldStr: string; newStr: string } | null {
  if (req.toolName !== 'Edit') return null;
  const input = (req.input || {}) as Record<string, unknown>;
  const oldStr = typeof input.old_string === 'string' ? input.old_string : '';
  const newStr = typeof input.new_string === 'string' ? input.new_string : '';
  const filePath = typeof input.file_path === 'string' ? input.file_path : '';
  if (!oldStr && !newStr) return null;
  return { filePath, oldStr, newStr };
}

function getWriteParts(req: PermissionRequest): { filePath: string; content: string } | null {
  if (req.toolName !== 'Write') return null;
  const input = (req.input || {}) as Record<string, unknown>;
  const filePath = typeof input.file_path === 'string' ? input.file_path : '';
  const content = typeof input.content === 'string' ? input.content : '';
  if (!filePath && !content) return null;
  // Pass the full content through — DiffView handles tall content via its
  // own maxHeight + internal scroll, and the Expand button opens it
  // fullscreen without any mid-file truncation.
  return { filePath, content };
}

/** Fallback summary for tools without a specialized preview (Read, Grep,
 *  Glob, arbitrary MCP tools, etc.). */
function summarise(req: PermissionRequest): string {
  const input = req.input || {};
  const get = (k: string) => (typeof (input as Record<string, unknown>)[k] === 'string' ? ((input as Record<string, unknown>)[k] as string) : '');
  switch (req.toolName) {
    case 'Read':
    case 'NotebookEdit':
      return get('file_path') || get('path');
    case 'Grep':
    case 'Glob':
      return get('pattern') || get('query');
    default:
      try { return JSON.stringify(input, null, 2).slice(0, 900); } catch { return ''; }
  }
}
