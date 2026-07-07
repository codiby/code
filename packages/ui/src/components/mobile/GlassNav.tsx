import type { ReactNode } from 'react';
import { Button } from '@heroui/react';

export type NavTab = 'home' | 'chat' | 'files' | 'git' | 'settings';

interface GlassNavProps {
  active: NavTab;
  onSelect: (tab: NavTab) => void;
  /** Whether a permission request is currently pending (shows a red dot on the chat icon). */
  hasPending?: boolean;
  /** When true, slide the nav fully off the bottom edge. */
  hidden?: boolean;
}

interface TabDef {
  key: NavTab;
  label: string;
  icon: ReactNode;
}

const TABS: TabDef[] = [
  {
    key: 'home', label: 'Home',
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.7">
        <path d="M4 7.5h16" strokeLinecap="round" />
        <rect x="4" y="4" width="16" height="4" rx="1.7" />
        <rect x="4" y="10" width="16" height="4" rx="1.7" />
        <rect x="4" y="16" width="16" height="4" rx="1.7" />
      </svg>
    ),
  },
  {
    key: 'chat', label: 'Chat',
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.7">
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    key: 'files', label: 'Files',
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.7">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    key: 'git', label: 'Git',
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.7">
        <circle cx="6" cy="6" r="2.5" />
        <circle cx="6" cy="18" r="2.5" />
        <circle cx="18" cy="12" r="2.5" />
        <path d="M6 8.5v7" />
        <path d="M8.3 6.5c4 0 7.7 2 7.7 5.5" />
      </svg>
    ),
  },
  {
    key: 'settings', label: 'Settings',
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.7">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09c0 .68.39 1.27 1 1.51a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.24.61.83 1 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
];

export function GlassNav({ active, onSelect, hasPending, hidden }: GlassNavProps) {
  return (
    <nav
      className="fixed left-3 right-3 z-40 flex items-stretch justify-around gap-1 rounded-full border border-white/10 bg-zinc-900/55 px-2 py-1.5 shadow-2xl transition-[transform,opacity] duration-200 ease-out"
      style={{
        bottom: 'calc(0.75rem + env(safe-area-inset-bottom))',
        backdropFilter: 'blur(28px) saturate(180%)',
        WebkitBackdropFilter: 'blur(28px) saturate(180%)',
        transform: hidden ? 'translateY(150%)' : 'translateY(0)',
        opacity: hidden ? 0 : 1,
        pointerEvents: hidden ? 'none' : 'auto',
      }}
      aria-label="Mobile navigation"
    >
      {TABS.map((t) => {
        const isActive = active === t.key;
        return (
          <Button
            key={t.key}
            variant="ghost"
            onPress={() => onSelect(t.key)}
            className={`relative flex-1 h-auto min-w-0 min-h-12 flex flex-col items-center justify-center gap-0.5 rounded-full transition-colors ${
              isActive
                ? 'bg-white/10 text-zinc-100'
                : 'text-zinc-400 active:bg-white/5 active:text-zinc-200'
            }`}
            aria-pressed={isActive}
            aria-label={t.label}
          >
            <span className="relative">
              {t.icon}
              {t.key === 'chat' && hasPending && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500 ring-2 ring-zinc-900 animate-pulse" />
              )}
            </span>
            <span className="text-[10px] leading-none font-medium">{t.label}</span>
          </Button>
        );
      })}
    </nav>
  );
}
