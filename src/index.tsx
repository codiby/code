import './styles/global.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatApp } from './components/ChatApp';
import { PluginHostBootstrap } from './components/PluginExtensionPoints';
import { UpdateBanner } from './components/UpdateBanner';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Missing #root container');

createRoot(rootEl).render(
  <StrictMode>
    <PluginHostBootstrap />
    <ChatApp />
    <UpdateBanner />
  </StrictMode>,
);
