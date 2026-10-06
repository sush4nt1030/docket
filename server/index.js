import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// Load .env (simple KEY=VALUE lines) if present; real environment variables win.
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const dataDir = path.resolve(root, process.env.DATA_DIR || 'data');
const app = createApp({ dataDir });
app.server.listen(port, host, () => {
  console.log(`Docket running at http://localhost:${port}  (data: ${dataDir})`);
  console.log(`Email reminders: ${app.mailer.describe()}`);
  console.log(`Web push: VAPID keys ${app.push.source === 'environment' ? 'from environment' : 'generated and stored in the database'}`);
});
const shutdown = () => { console.log('Shutting down…'); app.close(); setTimeout(() => process.exit(0), 300); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
