import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './App.css';
import App from './App.tsx';
import { setupNativeUi } from './native.ts';

// Fullscreen the app on native (hide the status bar); no-op on the web.
void setupNativeUi();

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
