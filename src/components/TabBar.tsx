import { useState, useRef, useEffect, memo } from 'react';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, horizontalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { SessionInfo, ConnectionStatus } from '../lib/claude-client';

type TabGroup = { id: string; name: string; color: string };

interface Props {
  sessions: SessionInfo[];
  closedSessions: SessionInfo[];
  activeSessionId: string | null;
  sessionStatuses: Record<string, ConnectionStatus>;
  sessionStreaming: Record<string, boolean>;
  sessionHasPermission: Record<string, boolean>;
  sessionTurnComplete: Set<string>;
  onSelect: (id: string) => void;
  onNew: () => void;
  onClose: (id: string) => void;
  onReopen: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onReorder: (fromId: string, toId: string) => void;
  tabGroups: Record<string, TabGroup>;
  tabGroupMap: Record<string, string>;
  expandedGroupId: string | null;
  onCreateGroup: (tabIds: string[]) => void;
  onGroupTabs: (a: string, b: string) => void;
  onAddToGroup: (tabId: string, groupId: string) => void;
  onUngroupTab: (tabId: string) => void;
  onToggleGroup: (groupId: string) => void;
  onRenameGroup: (groupId: string, name: string) => void;
  onChangeGroupColor: (groupId: string, color: string) => void;
}

const COLOR_MAP: Record<string, { dot: string; bg: string; border: string; ring: string }> = {
  blue:   { dot: 'bg-blue-400',   bg: 'bg-blue-500/8',   border: 'border-blue-400/25', ring: 'ring-blue-400/40' },
  green:  { dot: 'bg-green-400',  bg: 'bg-green-500/8',  border: 'border-green-400/25', ring: 'ring-green-400/40' },
  amber:  { dot: 'bg-amber-400',  bg: 'bg-amber-500/8',  border: 'border-amber-400/25', ring: 'ring-amber-400/40' },
  violet: { dot: 'bg-violet-400', bg: 'bg-violet-500/8', border: 'border-violet-400/25', ring: 'ring-violet-400/40' },
  red:    { dot: 'bg-red-400',    bg: 'bg-red-500/8',    border: 'border-red-400/25', ring: 'ring-red-400/40' },
  pink:   { dot: 'bg-pink-400',   bg: 'bg-pink-500/8',   border: 'border-pink-400/25', ring: 'ring-pink-400/40' },
};

function getDotClass(connStatus: string, isStreaming: boolean, turnComplete: boolean): string {
  if (connStatus === 'error') return 'bg-red-400';
  if (connStatus === 'connecting') return 'bg-amber-400 animate-pulse';
  if (turnComplete) return 'bg-green-400 animate-pulse';
  if (connStatus === 'connected' && isStreaming) return 'bg-amber-400 animate-pulse';
  if (connStatus === 'connected') return 'bg-zinc-500';
  return 'bg-zinc-600';
}

const ACTIVE_GROUP_BG: Record<string, string> = {
  blue: 'bg-blue-500/20', green: 'bg-green-500/20', amber: 'bg-amber-500/20',
  violet: 'bg-violet-500/20', red: 'bg-red-500/20', pink: 'bg-pink-500/20',
};

function SortableTab({ id, session, isActive, connStatus, isStreaming, turnComplete, hasPermission, groupColor, compact, editingId, editName, editRef, setEditName, startRename, commitRename, setEditingId, onSelect, onClose, onContextMenu }: {
  id: string; session: SessionInfo; isActive: boolean; connStatus: string; isStreaming: boolean; turnComplete?: boolean; hasPermission: boolean; groupColor?: string; compact?: boolean;
  editingId: string | null; editName: string; editRef: React.RefObject<HTMLInputElement | null>;
  setEditName: (v: string) => void; startRename: (s: SessionInfo) => void; commitRename: () => void; setEditingId: (id: string | null) => void;
  onSelect: (id: string) => void; onClose: (id: string) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: editingId === session.id });
  const activeBg = isActive && groupColor ? ACTIVE_GROUP_BG[groupColor] || 'bg-surface-light' : isActive ? 'bg-surface-light' : '';
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
      {...attributes} {...listeners}
      className={`tab-item group relative flex items-center gap-1.5 px-3 ${compact ? 'h-[26px]' : 'h-[30px]'} text-[12px] cursor-pointer shrink-0 max-w-[200px] min-w-[80px] rounded-md transition-colors ${
        isActive ? `${activeBg} text-zinc-200` : 'text-zinc-500 hover:text-zinc-300 hover:bg-surface/50'
      }`}
      onClick={() => onSelect(session.id)}
      onContextMenu={onContextMenu}
    >
      <span className={`w-2 h-2 rounded-full shrink-0 ${getDotClass(connStatus, isStreaming, !!turnComplete)}`} />
      {editingId === session.id ? (
        <input ref={editRef} value={editName} onChange={e => setEditName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditingId(null); }}
          onBlur={commitRename} className="bg-transparent border-none outline-none text-[12px] text-zinc-200 w-full min-w-0" />
      ) : (
        <span className="truncate flex-1" onDoubleClick={e => { e.stopPropagation(); startRename(session); }}>{session.name}</span>
      )}
      <button className={`shrink-0 w-4 h-4 flex items-center justify-center rounded-sm text-[14px] leading-none transition-opacity ${
        isActive ? 'text-zinc-400 hover:text-zinc-200 hover:bg-surface-light' : 'opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-zinc-300 hover:bg-surface-light'
      }`} onClick={e => { e.stopPropagation(); onClose(session.id); }} onPointerDown={e => e.stopPropagation()}>&times;</button>
      {hasPermission && !isActive && (
        <span className="absolute -top-0.5 -right-0.5 flex h-3 w-3">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500 border border-[#161616]" />
        </span>
      )}
    </div>
  );
}

function SortableGroupTab({ group, memberCount, isExpanded, hasActive, onToggle, onRename, onMenuOpen }: {
  group: TabGroup; memberCount: number; isExpanded: boolean; hasActive: boolean;
  onToggle: () => void; onRename: (name: string) => void; onMenuOpen: (rect: DOMRect) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isOver } = useSortable({ id: `group::${group.id}` });
  const colors = COLOR_MAP[group.color] || COLOR_MAP.blue!;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(group.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes} {...listeners}
      className={`group relative flex items-center gap-1.5 px-3 h-[30px] text-[12px] cursor-pointer shrink-0 rounded-md transition-colors ${colors.bg} border ${colors.border} ${isOver ? `ring-1 ${colors.ring}` : ''} ${hasActive && !isExpanded ? 'text-zinc-200' : 'text-zinc-400 hover:text-zinc-300'}`}
      onClick={onToggle}
    >
      <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${colors.dot}`} />
      {editing ? (
        <input ref={inputRef} value={name} onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { onRename(name); setEditing(false); } if (e.key === 'Escape') setEditing(false); }}
          onBlur={() => { onRename(name); setEditing(false); }}
          onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}
          className="bg-transparent border-none outline-none text-[12px] text-zinc-200 w-16 min-w-0" />
      ) : (
        <span className="text-[12px] max-w-[80px] truncate" onDoubleClick={e => { e.stopPropagation(); setEditing(true); setName(group.name); }}>
          {group.name}
        </span>
      )}
      <span className="text-[11px] text-zinc-600">{memberCount}</span>
      <span className="text-[10px] text-zinc-500">{isExpanded ? '▾' : '▸'}</span>
      {/* Dropdown arrow */}
      <button ref={btnRef}
        className="shrink-0 w-4 h-4 flex items-center justify-center rounded-sm text-[11px] leading-none text-zinc-600 hover:text-zinc-300 hover:bg-surface-light transition-opacity opacity-0 group-hover:opacity-100"
        onClick={e => { e.stopPropagation(); if (btnRef.current) onMenuOpen(btnRef.current.getBoundingClientRect()); }}
        onPointerDown={e => e.stopPropagation()}
        title="Group options"
      >
        &#x25BC;
      </button>
    </div>
  );
}

export const TabBar = memo(function TabBar(props: Props) {
  const { sessions, closedSessions, activeSessionId, sessionStatuses, sessionStreaming, sessionHasPermission,
    onSelect, onNew, onClose, onReopen, onRename, onReorder,
    tabGroups, tabGroupMap, expandedGroupId, sessionTurnComplete, onCreateGroup, onGroupTabs, onAddToGroup, onToggleGroup, onRenameGroup, onChangeGroupColor } = props;

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [showMenu, setShowMenu] = useState(false);
  const [groupMenu, setGroupMenu] = useState<{ groupId: string; rect: DOMRect } | null>(null);
  const [tabMenu, setTabMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const shiftRef = useRef(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const editRef = useRef<HTMLInputElement>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.key === 'Shift') shiftRef.current = true; };
    const up = (e: KeyboardEvent) => { if (e.key === 'Shift') shiftRef.current = false; };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);

  useEffect(() => { if (editingId && editRef.current) { editRef.current.focus(); editRef.current.select(); } }, [editingId]);
  const startRename = (s: SessionInfo) => { setEditingId(s.id); setEditName(s.name); };
  const commitRename = () => { if (editingId && editName.trim()) onRename(editingId, editName.trim()); setEditingId(null); };

  // Build render structure
  const renderedGroups = new Set<string>();
  const sortableItems: string[] = [];
  type RenderItem = { type: 'tab'; session: SessionInfo } | { type: 'group'; groupId: string; members: SessionInfo[] };
  const renderList: RenderItem[] = [];

  for (const s of sessions) {
    const gid = tabGroupMap[s.id];
    if (gid && tabGroups[gid]) {
      if (!renderedGroups.has(gid)) {
        renderedGroups.add(gid);
        const members = sessions.filter(m => tabGroupMap[m.id] === gid);
        sortableItems.push(`group::${gid}`);
        if (expandedGroupId === gid) members.forEach(m => sortableItems.push(m.id));
        renderList.push({ type: 'group', groupId: gid, members });
      }
    } else {
      sortableItems.push(s.id);
      renderList.push({ type: 'tab', session: s });
    }
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const fromId = String(active.id);
    const overId = String(over.id);

    // Dropped on group header → add to group
    if (overId.startsWith('group::')) {
      onAddToGroup(fromId, overId.replace('group::', ''));
      return;
    }

    // Shift held → create/add to group
    if (shiftRef.current) {
      const targetGroupId = tabGroupMap[overId];
      if (targetGroupId) {
        onAddToGroup(fromId, targetGroupId);
      } else {
        onGroupTabs(fromId, overId);
      }
      return;
    }

    // Default: reorder
    onReorder(fromId, overId);
  };

  const tp = (s: SessionInfo, groupColor?: string, compact?: boolean) => ({
    id: s.id, session: s, isActive: s.id === activeSessionId,
    connStatus: sessionStatuses[s.id] || 'disconnected',
    isStreaming: sessionStreaming[s.id] || false,
    turnComplete: sessionTurnComplete.has(s.id),
    hasPermission: sessionHasPermission[s.id] || false,
    groupColor, compact,
    editingId, editName, editRef, setEditName, startRename, commitRename, setEditingId, onSelect, onClose,
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); setTabMenu({ tabId: s.id, x: e.clientX, y: e.clientY }); },
  });

  return (
    <div className="tab-bar flex flex-col bg-[#161616] shrink-0 select-none">
      <div className="h-[28px] shrink-0" />
      <div className="flex items-center gap-1 px-1 overflow-x-auto" style={{ minHeight: 34 }}>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={sortableItems} strategy={horizontalListSortingStrategy}>
            {renderList.map(item => {
              if (item.type === 'tab') return <SortableTab key={item.session.id} {...tp(item.session)} />;

              const group = tabGroups[item.groupId]!;
              const colors = COLOR_MAP[group.color] || COLOR_MAP.blue!;
              const isExpanded = expandedGroupId === item.groupId;
              const hasActive = item.members.some(m => m.id === activeSessionId);

              return (
                <div key={`grp-${item.groupId}`} className={`flex items-center gap-0.5 ${isExpanded ? `rounded-lg ${colors.bg} px-0.5` : ''}`}>
                  <SortableGroupTab
                    group={group} memberCount={item.members.length} isExpanded={isExpanded} hasActive={hasActive}
                    onToggle={() => onToggleGroup(item.groupId)}
                    onRename={name => onRenameGroup(item.groupId, name)}
                    onMenuOpen={rect => setGroupMenu({ groupId: item.groupId, rect })}
                  />
                  {isExpanded && item.members.map(m => <SortableTab key={m.id} {...tp(m, group.color, true)} />)}
                </div>
              );
            })}
          </SortableContext>
        </DndContext>

        {/* New/reopen */}
        <div className="shrink-0" ref={menuRef}>
          <button className="flex items-center justify-center w-8 h-[30px] text-zinc-500 hover:text-zinc-300 hover:bg-surface/50 rounded-md text-lg leading-none transition-colors"
            onClick={() => setShowMenu(m => !m)} title="Open session">+</button>
          {showMenu && (() => {
            const rect = menuRef.current?.getBoundingClientRect();
            return (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
              <div className="fixed z-50 bg-surface border border-border-light rounded-lg shadow-xl min-w-[220px] py-1 overflow-y-auto max-h-80"
                style={{ top: (rect?.bottom ?? 38) + 4, left: rect?.left ?? 0 }}>
                <button className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-zinc-300 hover:bg-surface-light transition-colors"
                  onClick={() => { setShowMenu(false); onNew(); }}>
                  <span className="text-zinc-500">+</span><span>New session</span>
                </button>
                {closedSessions.length > 0 && (
                  <>
                    <div className="h-px bg-border mx-2 my-1" />
                    <div className="px-3 py-1 text-[10px] text-zinc-600 uppercase tracking-wider">Closed sessions</div>
                    {closedSessions.map(s => (
                      <button key={s.id} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-zinc-400 hover:bg-surface-light hover:text-zinc-200 transition-colors"
                        onClick={() => { setShowMenu(false); onReopen(s.id); }}>
                        <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 shrink-0" />
                        <span className="truncate">{s.name}</span>
                        <span className="text-[10px] text-zinc-600 ml-auto shrink-0 font-mono">{s.cwd.split('/').pop()}</span>
                      </button>
                    ))}
                  </>
                )}
              </div>
            </>
            );
          })()}
        </div>
      </div>

      {/* Group dropdown menu */}
      {groupMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setGroupMenu(null)} />
          <div className="fixed z-50 bg-surface border border-border-light rounded-lg shadow-xl min-w-[160px] py-1"
            style={{ top: groupMenu.rect.bottom + 4, left: groupMenu.rect.left }}>
            <button className="w-full text-left px-3 py-1.5 text-[12px] text-zinc-400 hover:bg-surface-light hover:text-zinc-200 transition-colors"
              onClick={() => { onToggleGroup(groupMenu.groupId); setGroupMenu(null); }}>
              {expandedGroupId === groupMenu.groupId ? 'Collapse' : 'Expand'}
            </button>
            <div className="px-3 py-1.5">
              <div className="text-[10px] text-zinc-600 mb-1">Color</div>
              <div className="flex items-center gap-1">
                {Object.entries(COLOR_MAP).map(([key, c]) => (
                  <button key={key}
                    className={`w-4 h-4 rounded-full ${c.dot} transition-transform ${tabGroups[groupMenu.groupId]?.color === key ? 'ring-2 ring-white/40 scale-110' : 'hover:scale-110'}`}
                    onClick={() => { onChangeGroupColor(groupMenu.groupId, key); setGroupMenu(null); }}
                  />
                ))}
              </div>
            </div>
            <div className="h-px bg-border mx-2 my-1" />
            <button className="w-full text-left px-3 py-1.5 text-[12px] text-zinc-400 hover:bg-surface-light hover:text-zinc-200 transition-colors"
              onClick={() => {
                const members = sessions.filter(s => tabGroupMap[s.id] === groupMenu.groupId);
                for (const m of members) props.onUngroupTab(m.id);
                setGroupMenu(null);
              }}>
              Ungroup all
            </button>
          </div>
        </>
      )}

      {/* Tab context menu */}
      {tabMenu && (() => {
        const isGrouped = !!tabGroupMap[tabMenu.tabId];
        const tabGroupId = tabGroupMap[tabMenu.tabId];
        const otherUngroupedTabs = sessions.filter(s => s.id !== tabMenu.tabId && !tabGroupMap[s.id]);
        const existingGroups = Object.values(tabGroups).filter(g => !tabGroupId || g.id !== tabGroupId);

        return (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setTabMenu(null)} onContextMenu={e => { e.preventDefault(); setTabMenu(null); }} />
            <div className="fixed z-50 bg-surface border border-border-light rounded-lg shadow-xl min-w-[180px] py-1"
              style={{ top: tabMenu.y, left: tabMenu.x }}>

              {/* Rename */}
              <button className="w-full text-left px-3 py-1.5 text-[12px] text-zinc-400 hover:bg-surface-light hover:text-zinc-200 transition-colors"
                onClick={() => {
                  const s = sessions.find(s => s.id === tabMenu.tabId);
                  if (s) startRename(s);
                  setTabMenu(null);
                }}>
                Rename
              </button>

              {/* Close */}
              <button className="w-full text-left px-3 py-1.5 text-[12px] text-zinc-400 hover:bg-surface-light hover:text-zinc-200 transition-colors"
                onClick={() => { onClose(tabMenu.tabId); setTabMenu(null); }}>
                Close
              </button>

              <div className="h-px bg-border mx-2 my-1" />

              {/* Ungroup (if in a group) */}
              {isGrouped && (
                <button className="w-full text-left px-3 py-1.5 text-[12px] text-zinc-400 hover:bg-surface-light hover:text-zinc-200 transition-colors"
                  onClick={() => { props.onUngroupTab(tabMenu.tabId); setTabMenu(null); }}>
                  Remove from group
                </button>
              )}

              {/* Create group (solo) */}
              {!isGrouped && (
                <button className="w-full text-left px-3 py-1.5 text-[12px] text-zinc-400 hover:bg-surface-light hover:text-zinc-200 transition-colors"
                  onClick={() => { onCreateGroup([tabMenu.tabId]); setTabMenu(null); }}>
                  Create group
                </button>
              )}

              {/* Create group with another tab */}
              {!isGrouped && otherUngroupedTabs.length > 0 && (
                <>
                  <div className="px-3 py-1 text-[10px] text-zinc-600 uppercase tracking-wider">Group with</div>
                  {otherUngroupedTabs.slice(0, 8).map(t => (
                    <button key={t.id} className="w-full text-left px-3 py-1.5 text-[12px] text-zinc-400 hover:bg-surface-light hover:text-zinc-200 transition-colors truncate"
                      onClick={() => { onGroupTabs(tabMenu.tabId, t.id); setTabMenu(null); }}>
                      {t.name}
                    </button>
                  ))}
                </>
              )}

              {/* Add to existing group */}
              {existingGroups.length > 0 && (
                <>
                  <div className="h-px bg-border mx-2 my-1" />
                  <div className="px-3 py-1 text-[10px] text-zinc-600 uppercase tracking-wider">Add to group</div>
                  {existingGroups.map(g => {
                    const c = COLOR_MAP[g.color] || COLOR_MAP.blue!;
                    return (
                      <button key={g.id} className="w-full text-left px-3 py-1.5 text-[12px] text-zinc-400 hover:bg-surface-light hover:text-zinc-200 transition-colors flex items-center gap-2"
                        onClick={() => { onAddToGroup(tabMenu.tabId, g.id); setTabMenu(null); }}>
                        <span className={`w-2 h-2 rounded-full shrink-0 ${c.dot}`} />
                        {g.name}
                      </button>
                    );
                  })}
                </>
              )}
            </div>
          </>
        );
      })()}
    </div>
  );
});
