import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Optional label used in the logged message, e.g. "desktop" / "mobile". */
  context?: string;
}

interface State {
  error: Error | null;
}

/**
 * Last-resort UI safety net. A throw during render anywhere below this
 * boundary would otherwise unmount the whole React tree and leave a blank
 * window. We catch it, log it, and show a minimal recovery screen so the user
 * can reload instead of staring at nothing. The bridge sidecar and the
 * Electron main process have their own process-level nets — this is the
 * renderer's equivalent.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error(`[${this.props.context ?? 'ui'}] Uncaught render error:`, error, info.componentStack);
  }

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100vh',
            gap: 16,
            padding: 24,
            textAlign: 'center',
            color: '#e5e7eb',
            background: '#0a0a0a',
            // Fallback spelled out after the var: this screen renders when the
            // app has already failed, and the stylesheet may not have loaded.
            fontFamily: 'var(--font-sans, system-ui, sans-serif)',
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 600 }}>Something went wrong</div>
          <div style={{ fontSize: 13, opacity: 0.7, maxWidth: 520, whiteSpace: 'pre-wrap' }}>
            {this.state.error.message || String(this.state.error)}
          </div>
          <button
            onClick={this.handleReload}
            style={{
              marginTop: 8,
              padding: '8px 16px',
              fontSize: 13,
              borderRadius: 8,
              border: '1px solid #2a2a2a',
              background: '#1a1a1a',
              color: '#e5e7eb',
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
