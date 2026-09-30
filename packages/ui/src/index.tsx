import './styles/global.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatApp } from './components/ChatApp';
import { BubbleApp } from './components/bubbles/BubbleApp';
import { ErrorBoundary } from './components/ErrorBoundary';
import { PluginHostBootstrap } from './components/PluginExtensionPoints';
import { UpdateBanner } from './components/UpdateBanner';
import { RestartSuggestionBanner } from './components/RestartSuggestionBanner';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Missing #root container');

// The desktop app's floating-bubble overlay window loads this same bundle
// with `?bubbles` (see packages/desktop/bubbles.ts).
const isBubbles = new URLSearchParams(window.location.search).has('bubbles');

createRoot(rootEl).render(
  <StrictMode>
    {isBubbles ? (
      <ErrorBoundary context="bubbles">
        <BubbleApp />
      </ErrorBoundary>
    ) : (
      <ErrorBoundary context="desktop">
        <PluginHostBootstrap />
        <ChatApp />
        <UpdateBanner />
        <RestartSuggestionBanner />
      </ErrorBoundary>
    )}
  </StrictMode>,
);
