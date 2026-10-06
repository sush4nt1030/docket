// Bundles the React frontend into public/app.js. Only needed after changing files in client/.
// Run `npm install` once (dev dependencies) and then `npm run build`.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const extra = process.env.EXTRA_NODE_PATH ? [process.env.EXTRA_NODE_PATH] : [];
const require = createRequire(import.meta.url);
let esbuild;
try { esbuild = require('esbuild'); } catch { esbuild = createRequire(path.join(extra[0] || '', 'x.js'))('esbuild'); }

const watch = process.argv.includes('--watch');
const ctx = await esbuild.context({
  entryPoints: [path.join(root, 'client/main.jsx')],
  bundle: true, minify: !watch, sourcemap: watch ? 'inline' : false,
  format: 'esm', target: ['es2020', 'safari15'],
  outfile: path.join(root, 'public/app.js'),
  jsx: 'automatic', nodePaths: [path.join(root, 'node_modules'), ...extra],
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
  logLevel: 'info',
});
if (watch) await ctx.watch(); else { await ctx.rebuild(); await ctx.dispose(); }
