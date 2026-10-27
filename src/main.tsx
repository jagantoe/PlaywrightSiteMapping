import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

// Register the Playwright snapshot service worker (public/sw.bundle.js).
// It intercepts /snapshot/* requests to serve exact DOM snapshots from trace zips.
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.bundle.js`).catch(err => {
        console.warn('[trace-viewer] Service worker registration failed:', err);
    });
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
