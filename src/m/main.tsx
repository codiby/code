import '../styles/global.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MobileApp } from '../components/mobile/MobileApp';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Missing #root container');

createRoot(rootEl).render(
  <StrictMode>
    <MobileApp />
  </StrictMode>,
);
