// Node/Express server: serves the PWA from ./public and proxies /api/* to Fleaflicker.
import express from 'express';
import compression from 'compression';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { proxyFleaflicker } from './src/proxy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.use(compression());

app.get('/api/:method', async (req, res) => {
  const url = new URL(req.originalUrl, 'http://localhost');
  const r = await proxyFleaflicker(url);
  res.status(r.status);
  r.headers.forEach((v, k) => res.setHeader(k, v));
  res.send(Buffer.from(await r.arrayBuffer()));
});
app.all('/api/*', (_req, res) => res.status(404).json({ error: 'Unknown API endpoint' }));

app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders(res, file) {
      // The service worker and HTML must always revalidate so updates roll out.
      if (/\.(html|webmanifest)$|sw\.js$/.test(file)) res.setHeader('cache-control', 'no-cache');
    },
  })
);

const port = Number(process.env.PORT) || 8787;
app.listen(port, () => {
  // Deliberately no request/response logging: responses contain scores.
  console.log(`Blindside listening on http://localhost:${port}`);
});
