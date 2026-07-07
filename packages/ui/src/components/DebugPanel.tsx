import { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronDown, ChevronRight, Play, Pause, CornerDownRight, ArrowDown, ArrowUp } from 'lucide-react';
import {
  Button,
  TextField, Input,
  Checkbox, CheckboxControl, CheckboxIndicator,
} from '@heroui/react';
import {
  CdpClient,
  fetchDebugTargets,
  requestDebugConnect,
  requestDebugDisconnect,
  type DebugTarget,
  type CallFrame,
  type PropertyDescriptor,
  type RemoteObject,
} from '../lib/cdp-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Breakpoint {
  id?: string; // CDP breakpointId (set after connect)
  file: string;
  line: number;
  enabled: boolean;
}

interface DebugPanelProps {
  serverUrl: string;
  onNavigate: (filePath: string, line: number) => void;
  onClose: () => void;
  breakpoints: Breakpoint[];
  onToggleBreakpoint: (file: string, line: number) => void;
}

type DebugState = 'disconnected' | 'connecting' | 'running' | 'paused';

// ---------------------------------------------------------------------------
// Variable Tree
// ---------------------------------------------------------------------------

function ValueDisplay({ value }: { value: RemoteObject }) {
  if (value.type === 'undefined') return <span className="text-zinc-500">undefined</span>;
  if (value.type === 'string') return <span className="text-green-400">"{value.value}"</span>;
  if (value.type === 'number' || value.type === 'bigint') return <span className="text-blue-400">{String(value.value)}</span>;
  if (value.type === 'boolean') return <span className="text-amber-400">{String(value.value)}</span>;
  if (value.value === null) return <span className="text-zinc-500">null</span>;
  if (value.description) return <span className="text-zinc-300">{value.description}</span>;
  return <span className="text-zinc-400">{value.type}</span>;
}

function VariableNode({ name, value, cdp, depth = 0 }: { name: string; value: RemoteObject; cdp: CdpClient; depth?: number }) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<PropertyDescriptor[] | null>(null);
  const expandable = value.objectId && (value.type === 'object' || value.type === 'function');

  const toggle = async () => {
    if (!expandable) return;
    if (!expanded && !children) {
      try {
        const props = await cdp.getProperties(value.objectId!);
        setChildren(props.filter(p => p.isOwn !== false));
      } catch { setChildren([]); }
    }
    setExpanded(!expanded);
  };

  return (
    <div style={{ paddingLeft: depth * 12 }}>
      <div
        className={`flex items-center gap-1.5 py-0.5 px-1 rounded text-[12px] ${expandable ? 'cursor-pointer hover:bg-surface-light' : ''}`}
        onClick={toggle}
      >
        {expandable ? (
          <span className="text-zinc-500 shrink-0">
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className="text-violet-400 shrink-0">{name}</span>
        <span className="text-zinc-600 shrink-0">:</span>
        <span className="truncate"><ValueDisplay value={value} /></span>
      </div>
      {expanded && children?.map(child => (
        child.value ? (
          <VariableNode key={child.name} name={child.name} value={child.value} cdp={cdp} depth={depth + 1} />
        ) : null
      ))}
    </div>
  );
}

function ScopeSection({ scope, cdp }: { scope: CallFrame['scopeChain'][0]; cdp: CdpClient }) {
  const [expanded, setExpanded] = useState(scope.type === 'local');
  const [properties, setProperties] = useState<PropertyDescriptor[] | null>(null);

  const toggle = async () => {
    if (!expanded && !properties && scope.object.objectId) {
      try {
        const props = await cdp.getProperties(scope.object.objectId);
        setProperties(props.filter(p => p.isOwn !== false));
      } catch { setProperties([]); }
    }
    setExpanded(!expanded);
  };

  const label = scope.type.charAt(0).toUpperCase() + scope.type.slice(1);

  return (
    <div>
      <Button variant="ghost" fullWidth className="flex items-center gap-1 justify-start text-left px-2 py-1 h-auto rounded-none text-[11px] text-zinc-400 hover:bg-surface-light uppercase tracking-wider" onPress={toggle}>
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {label}{scope.name ? ` (${scope.name})` : ''}
      </Button>
      {expanded && properties?.map(prop => (
        prop.value ? (
          <VariableNode key={prop.name} name={prop.name} value={prop.value} cdp={cdp} depth={1} />
        ) : null
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Panel
// ---------------------------------------------------------------------------

export function DebugPanel({ serverUrl, onNavigate, onClose, breakpoints, onToggleBreakpoint }: DebugPanelProps) {
  const [state, setState] = useState<DebugState>('disconnected');
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState('9229');
  const [targets, setTargets] = useState<DebugTarget[]>([]);
  const [selectedTarget, setSelectedTarget] = useState<string>('');
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [callFrames, setCallFrames] = useState<CallFrame[]>([]);
  const [selectedFrame, setSelectedFrame] = useState<number>(0);
  const [pauseReason, setPauseReason] = useState('');
  const cdpRef = useRef<CdpClient | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cdpRef.current?.disconnect();
      if (connectionId) requestDebugDisconnect(serverUrl, connectionId).catch(() => {});
    };
  }, [connectionId, serverUrl]);

  const discover = useCallback(async () => {
    const t = await fetchDebugTargets(serverUrl, host, parseInt(port));
    setTargets(t);
    if (t.length > 0 && !selectedTarget) setSelectedTarget(t[0]!.id);
  }, [serverUrl, host, port, selectedTarget]);

  const connect = useCallback(async () => {
    setState('connecting');
    try {
      const result = await requestDebugConnect(serverUrl, host, parseInt(port), selectedTarget || undefined);
      if (!result) { setState('disconnected'); return; }

      setConnectionId(result.connectionId);

      const cdp = new CdpClient();
      cdpRef.current = cdp;

      cdp.onPaused = (frames, reason) => {
        setState('paused');
        setCallFrames(frames);
        setSelectedFrame(0);
        setPauseReason(reason);
        // Navigate to paused location
        if (frames[0]) {
          const script = cdp.getScriptById(frames[0].location.scriptId);
          const filePath = script?.url?.replace('file://', '') || frames[0].url?.replace('file://', '');
          if (filePath) onNavigate(filePath, frames[0].location.lineNumber + 1);
        }
      };

      cdp.onResumed = () => {
        setState('running');
        setCallFrames([]);
      };

      cdp.onDisconnected = () => {
        setState('disconnected');
        setCallFrames([]);
        setConnectionId(null);
      };

      await cdp.connect(serverUrl, result.connectionId);
      setState('running');

      // Sync existing breakpoints
      for (const bp of breakpoints) {
        if (bp.enabled) {
          cdp.setBreakpointByUrl(cdp.fileToDebugUrl(bp.file), bp.line - 1).catch(() => {});
        }
      }
    } catch (e) {
      console.warn('Debug connect failed:', e);
      setState('disconnected');
    }
  }, [serverUrl, host, port, selectedTarget, breakpoints, onNavigate]);

  const disconnect = useCallback(() => {
    cdpRef.current?.disconnect();
    cdpRef.current = null;
    if (connectionId) requestDebugDisconnect(serverUrl, connectionId).catch(() => {});
    setState('disconnected');
    setCallFrames([]);
    setConnectionId(null);
  }, [serverUrl, connectionId]);

  const step = useCallback((action: 'resume' | 'pause' | 'stepOver' | 'stepInto' | 'stepOut') => {
    cdpRef.current?.[action]?.().catch(() => {});
  }, []);

  const selectFrame = (idx: number) => {
    setSelectedFrame(idx);
    const frame = callFrames[idx];
    if (!frame) return;
    const cdp = cdpRef.current;
    const script = cdp?.getScriptById(frame.location.scriptId);
    const filePath = script?.url?.replace('file://', '') || frame.url?.replace('file://', '');
    if (filePath) onNavigate(filePath, frame.location.lineNumber + 1);
  };

  const currentFrame = callFrames[selectedFrame];
  const connected = state !== 'disconnected' && state !== 'connecting';

  return (
    <div className="flex flex-col h-full bg-surface border-t border-border overflow-hidden text-[12px]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-[#1a1a1a] shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-zinc-300 font-medium text-[12px]">Debugger</span>
          <span className={`w-2 h-2 rounded-full ${
            state === 'paused' ? 'bg-amber-400' :
            state === 'running' ? 'bg-green-400' :
            state === 'connecting' ? 'bg-amber-400 animate-pulse' :
            'bg-zinc-600'
          }`} />
          <span className="text-zinc-500 text-[11px]">{state}</span>
        </div>
        <Button isIconOnly size="sm" variant="ghost" onPress={onClose} aria-label="Close">
          <span className="text-[14px] leading-none">&times;</span>
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Connection */}
        {!connected && (
          <div className="p-3 space-y-2 border-b border-border">
            <div className="flex items-center gap-2">
              <TextField value={host} onChange={setHost} aria-label="Host" className="flex-1">
                <Input placeholder="Host" className="text-[12px]" />
              </TextField>
              <span className="text-zinc-600">:</span>
              <TextField value={port} onChange={setPort} aria-label="Port" className="w-16">
                <Input placeholder="Port" className="text-[12px]" />
              </TextField>
              <Button size="sm" variant="secondary" onPress={discover}>Discover</Button>
            </div>
            {targets.length > 0 && (
              <div className="space-y-1">
                {targets.map(t => (
                  <Button
                    key={t.id}
                    variant="ghost"
                    fullWidth
                    className={`text-left px-2 py-1.5 h-auto rounded text-[11px] flex flex-col items-stretch transition-colors ${
                      selectedTarget === t.id ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30' : 'text-zinc-400 hover:bg-surface-light border border-transparent'
                    }`}
                    onPress={() => setSelectedTarget(t.id)}
                  >
                    <div className="truncate">{t.title || t.url}</div>
                    <div className="text-zinc-600 truncate text-[10px]">{t.url}</div>
                  </Button>
                ))}
              </div>
            )}
            <Button
              fullWidth
              size="sm"
              className="bg-blue-600 hover:bg-blue-500 text-white"
              onPress={connect}
              isDisabled={state === 'connecting'}
            >
              {state === 'connecting' ? 'Connecting...' : 'Connect'}
            </Button>
          </div>
        )}

        {/* Step Controls */}
        {connected && (
          <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border bg-[#1a1a1a]">
            <Button isIconOnly size="sm" variant="ghost" className="p-1 h-auto rounded hover:bg-surface-light text-green-400 disabled:text-zinc-600" onPress={() => step('resume')} isDisabled={!cdpRef.current?.paused} aria-label="Continue (F5)"><Play size={14} /></Button>
            <Button isIconOnly size="sm" variant="ghost" className="p-1 h-auto rounded hover:bg-surface-light text-amber-400 disabled:text-zinc-600" onPress={() => step('pause')} isDisabled={cdpRef.current?.paused} aria-label="Pause (F6)"><Pause size={14} /></Button>
            <Button isIconOnly size="sm" variant="ghost" className="p-1 h-auto rounded hover:bg-surface-light text-zinc-300 disabled:text-zinc-600" onPress={() => step('stepOver')} isDisabled={!cdpRef.current?.paused} aria-label="Step Over (F10)"><CornerDownRight size={14} /></Button>
            <Button isIconOnly size="sm" variant="ghost" className="p-1 h-auto rounded hover:bg-surface-light text-zinc-300 disabled:text-zinc-600" onPress={() => step('stepInto')} isDisabled={!cdpRef.current?.paused} aria-label="Step Into (F11)"><ArrowDown size={14} /></Button>
            <Button isIconOnly size="sm" variant="ghost" className="p-1 h-auto rounded hover:bg-surface-light text-zinc-300 disabled:text-zinc-600" onPress={() => step('stepOut')} isDisabled={!cdpRef.current?.paused} aria-label="Step Out (Shift+F11)"><ArrowUp size={14} /></Button>
            <div className="flex-1" />
            <Button size="sm" variant="ghost" className="px-2 py-0.5 h-auto text-red-400 hover:bg-red-400/10 rounded text-[11px]" onPress={disconnect}>Disconnect</Button>
          </div>
        )}

        {/* Call Stack */}
        {state === 'paused' && callFrames.length > 0 && (
          <div className="border-b border-border">
            <div className="px-3 py-1 text-[11px] text-zinc-500 uppercase tracking-wider bg-[#1a1a1a]">
              Call Stack {pauseReason && <span className="normal-case text-amber-400/70">({pauseReason})</span>}
            </div>
            <div className="max-h-40 overflow-y-auto">
              {callFrames.map((frame, i) => {
                const script = cdpRef.current?.getScriptById(frame.location.scriptId);
                const fileName = (script?.url || frame.url || '').split('/').pop() || 'anonymous';
                return (
                  <Button
                    key={i}
                    variant="ghost"
                    fullWidth
                    className={`text-left justify-start px-3 py-1 h-auto rounded-none flex items-center gap-2 hover:bg-surface-light transition-colors ${i === selectedFrame ? 'bg-surface-light text-zinc-200' : 'text-zinc-400'}`}
                    onPress={() => selectFrame(i)}
                  >
                    {i === 0 && <ChevronRight size={12} className="text-amber-400 shrink-0" />}
                    <span className="truncate">{frame.functionName || '(anonymous)'}</span>
                    <span className="text-zinc-600 shrink-0 ml-auto">{fileName}:{frame.location.lineNumber + 1}</span>
                  </Button>
                );
              })}
            </div>
          </div>
        )}

        {/* Variables */}
        {state === 'paused' && currentFrame && cdpRef.current && (
          <div className="border-b border-border">
            <div className="px-3 py-1 text-[11px] text-zinc-500 uppercase tracking-wider bg-[#1a1a1a]">Variables</div>
            <div className="max-h-60 overflow-y-auto px-1">
              {currentFrame.scopeChain
                .filter(s => s.type !== 'global')
                .map((scope, i) => (
                  <ScopeSection key={i} scope={scope} cdp={cdpRef.current!} />
                ))
              }
            </div>
          </div>
        )}

        {/* Breakpoints */}
        {breakpoints.length > 0 && (
          <div>
            <div className="px-3 py-1 text-[11px] text-zinc-500 uppercase tracking-wider bg-[#1a1a1a]">Breakpoints</div>
            <div className="max-h-32 overflow-y-auto">
              {breakpoints.map((bp, i) => {
                const fileName = bp.file.split('/').pop() || bp.file;
                return (
                  <div key={i} className="flex items-center gap-2 px-3 py-0.5 hover:bg-surface-light text-zinc-400">
                    <Checkbox
                      isSelected={bp.enabled}
                      onChange={() => onToggleBreakpoint(bp.file, bp.line)}
                      aria-label={`Toggle breakpoint ${fileName}:${bp.line}`}
                    >
                      <CheckboxControl><CheckboxIndicator /></CheckboxControl>
                    </Checkbox>
                    <Button
                      variant="ghost"
                      className="flex-1 text-left justify-start px-0 py-0 h-auto rounded-none truncate hover:text-zinc-200 transition-colors"
                      onPress={() => onNavigate(bp.file, bp.line)}
                    >
                      <span className="text-zinc-300">{fileName}</span>
                      <span className="text-zinc-600">:{bp.line}</span>
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
