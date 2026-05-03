import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Guard against libraries trying to overwrite window.fetch
if (typeof window !== 'undefined' && window.fetch) {
  const originalFetch = window.fetch;
  try {
    Object.defineProperty(window, 'fetch', {
      configurable: true,
      enumerable: true,
      get: () => originalFetch,
      set: (v) => {
        console.warn('Attempted to overwrite window.fetch with:', v);
      }
    });
  } catch (e) {
    console.warn('Could not redefine window.fetch:', e);
  }
}

// Debug __FIREBASE_DEFAULTS__
if (typeof window !== 'undefined' && (window as any).__FIREBASE_DEFAULTS__) {
  console.log("__FIREBASE_DEFAULTS__:", (window as any).__FIREBASE_DEFAULTS__);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
