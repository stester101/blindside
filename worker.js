// Cloudflare Worker entry. Static files in ./public are served by Workers Static Assets;
// requests that match no asset (including every /api/* path) reach this handler.
import { proxyFleaflicker } from './src/proxy.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      return proxyFleaflicker(url);
    }
    return env.ASSETS.fetch(request);
  },
};
