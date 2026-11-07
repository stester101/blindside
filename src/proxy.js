// Fleaflicker API proxy shared by the Node/Express server and the Cloudflare Worker.
// It only ever talks to https://www.fleaflicker.com/api/, only for three read-only
// methods, and only forwards known numeric query parameters.

const UPSTREAM = 'https://www.fleaflicker.com/api/';

// Allowed methods -> allowed query params.
// NOTE: FetchLeagueBoxscore returns HTTP 400 if `season` is sent, so it is not forwarded.
const METHODS = {
  FetchLeagueStandings: ['league_id', 'season'],
  FetchLeagueScoreboard: ['league_id', 'season', 'scoring_period'],
  FetchLeagueBoxscore: ['league_id', 'scoring_period', 'fantasy_game_id'],
};

function jsonResponse(status, obj, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders },
  });
}

/**
 * @param {URL} url  incoming request URL (path must start with /api/)
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<Response>}
 */
export async function proxyFleaflicker(url, fetchImpl = fetch) {
  const method = url.pathname.replace(/^\/api\//, '');
  if (!Object.prototype.hasOwnProperty.call(METHODS, method)) {
    return jsonResponse(404, { error: 'Unknown API endpoint' });
  }

  const out = new URLSearchParams({ sport: 'NFL' });
  for (const key of METHODS[method]) {
    const v = url.searchParams.get(key);
    if (v == null || v === '') continue;
    if (!/^\d{1,12}$/.test(v)) return jsonResponse(400, { error: `Invalid ${key}` });
    out.set(key, v);
  }
  if (!out.has('league_id')) return jsonResponse(400, { error: 'league_id is required' });
  if (method === 'FetchLeagueBoxscore' && !out.has('fantasy_game_id')) {
    return jsonResponse(400, { error: 'fantasy_game_id is required' });
  }

  // Built from a constant base: the host can never be anything but www.fleaflicker.com.
  const target = new URL(`${method}?${out}`, UPSTREAM);
  if (target.origin !== 'https://www.fleaflicker.com') return jsonResponse(400, { error: 'Bad target' });

  let upstream;
  try {
    upstream = await fetchImpl(target, {
      headers: { accept: 'application/json', 'user-agent': 'blindside-proxy/1.0' },
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    return jsonResponse(502, { error: 'Could not reach Fleaflicker' });
  }

  if (!upstream.ok) {
    // Never pass the upstream body through: it is an HTML error page.
    return jsonResponse(502, { error: `Fleaflicker returned HTTP ${upstream.status}`, upstreamStatus: upstream.status });
  }

  const body = await upstream.text();
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Short cache so "Refresh" stays meaningful while scores update.
      'cache-control': 'private, max-age=15',
    },
  });
}
