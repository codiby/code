import type { SessionState } from './claude-client';
import type { MockupComment } from './mockup-inspector';
import type { PlanComment } from '../components/PlanPanel';
import type { LoopState, RequirementProgress, RequirementsSnapshot } from './requirements';

/** A user message composed while the session was offline / mid-turn, staged
 *  locally until it can be delivered. */
export type PendingMessage = {
  id: string;
  text: string;
  images?: { media_type: string; data: string }[];
};

/** Local UI extensions layered on top of the server's `SessionState`. The
 *  server doesn't track these fields, so the `onSessionState` merge must
 *  preserve them across re-subscribes (see the merge in ChatApp). */
export type LocalSessionState = SessionState & {
  contextTokens: number;
  pendingMessages: PendingMessage[];
  // Live HTML mockup preview shown in the side panel. UI-only — the bridge
  // server doesn't track this field, so the merge in `onSessionState` must
  // preserve `openMockup`/`lastMockup` from the existing local state.
  openMockup: { name: string; html: string } | null;
  // Most recent mockup, kept after the user closes the panel so the chat
  // header can offer a one-click "reopen" button.
  lastMockup: { name: string; html: string } | null;
  // Inspector comments per mockup name. Keyed by mockup name so they
  // survive `mockup_edit` re-broadcasts and tab switches.
  mockupComments: Record<string, MockupComment[]>;
  mockupInspect: boolean;
  // Live browser previews opened by `browser_open` — UI-only, same caveat
  // as `openMockup` so the `onSessionState` merge has to preserve them.
  // `browsers` is keyed by the model-supplied `name` (e.g. "qa-admin-
  // workflow"); multiple can coexist in a single session, each surfaced as
  // its own tab in the PanelsWorkspace. `openSeq` per
  // entry is bumped on every `open_browser` broadcast so the panel re-runs
  // its open effect when the same name is re-broadcast (retry after error,
  // reopen from chat-header chip).
  browsers: Record<string, { url: string; title: string; openSeq: number; cookieJar: string }>;
  /** Which browser name is currently revealed / focused. Tracks the visible
   *  browser panel tab and drives the focus-mode anchor + header-chip
   *  highlight. `null` when no browser is open. Matches a key in `browsers`. */
  activeBrowserName: string | null;
  /** Inspector comments, keyed by `name` then by URL — same name surviving
   *  navigations + matching the per-page-mounted dot lifecycle. */
  browserComments: Record<string, Record<string, MockupComment[]>>;
  /** Per-name inspect-mode toggle. Switching tabs preserves per-tab state. */
  browserInspect: Record<string, boolean>;
  /** Images pasted into the composer, awaiting the next send. Per-session so
   *  the focus-mode layout can show separate paste buffers in each pane. */
  pastedImages: { media_type: string; data: string; preview: string }[];
  // ExitPlanMode plan rendered in the side panel. UI-only — same merge
  // caveat as `openMockup`. `planRequestId` tracks the most recent perm
  // request id we auto-opened for so we don't reopen the panel after the
  // user closes it manually while permission is still pending.
  openPlan: { content: string; allowedPrompts?: { tool: string; prompt: string }[] } | null;
  lastPlan: { content: string; allowedPrompts?: { tool: string; prompt: string }[] } | null;
  planComments: PlanComment[];
  planRequestId: string | null;
  /** Requirements + Target snapshot, pushed by the bridge. Server-owned data,
   *  but kept here so the panel renders from the same per-session store as
   *  everything else. Null until the first fetch/broadcast lands. */
  requirements: RequirementsSnapshot | null;
  /** Whether the requirements tab is open in the panel workspace. Auto-opens
   *  the first time a session grows a target or a requirement. */
  requirementsOpen: boolean;
  /** Ids executing right now — local echo so a row shows the spinner before
   *  the server's `requirements` broadcast comes back. */
  requirementsRunning: string[];
  /** Loop-mode state, or null when the session has never been looped. */
  loop: LoopState | null;
  loopProgress: RequirementProgress | null;
};
