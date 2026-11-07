// Renders public/icons/icon.svg to PNGs with Playwright (dev-only helper).
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import fs from 'node:fs';
const dir = new URL('../public/icons/', import.meta.url);
const svg = fs.readFileSync(new URL('icon.svg', dir), 'utf8');
const b = await chromium.launch();
const p = await b.newPage();
for (const [name, size, pad] of [['icon-192.png', 192, 0], ['icon-512.png', 512, 0], ['icon-maskable-512.png', 512, 0.12]]) {
  await p.setViewportSize({ width: size, height: size });
  const inner = Math.round(size * (1 - pad * 2));
  await p.setContent(`<body style="margin:0;background:#0b0f14;display:grid;place-items:center;height:${size}px">
    <div style="width:${inner}px;height:${inner}px">${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</div></body>`);
  fs.writeFileSync(new URL(name, dir), await p.screenshot({ omitBackground: false }));
}
await b.close();
