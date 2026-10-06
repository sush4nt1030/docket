import { createRoot } from 'react-dom/client';
import { App } from './components/App.jsx';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('Service worker registration failed', err)); });
  navigator.serviceWorker.addEventListener && navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'navigate' && e.data.url) location.hash = e.data.url.split('#')[1] || '/';
  });
}
createRoot(document.getElementById('root')).render(<App />);
