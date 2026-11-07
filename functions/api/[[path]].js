// Cloudflare Pages Function: proxies /api/* to Fleaflicker (same code as the Worker).
import { proxyFleaflicker } from '../../src/proxy.js';

export const onRequestGet = ({ request }) => proxyFleaflicker(new URL(request.url));
