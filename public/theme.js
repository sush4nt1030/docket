// Apply the saved theme before first paint (per-device convenience only; the real setting syncs via the server).
try { var t = JSON.parse(localStorage.getItem('docket:theme') || '"system"'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch (e) {}
