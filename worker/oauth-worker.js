// MindSpark — GitHub OAuth Worker (Cloudflare Workers)
// -----------------------------------------------------------------------------
// This tiny Worker exists for ONE reason: GitHub's OAuth "code -> access token"
// exchange needs the OAuth App client_secret, which must never live in the
// browser. The Worker holds the secret, performs the exchange, and hands the
// resulting token back to the MindSpark window via postMessage. The app then
// stores that token exactly like a personal access token, so nothing else in
// MindSpark changes.
//
// It is entirely OPTIONAL. If you don't deploy it (and leave GH_OAUTH blank in
// public/app.js), MindSpark stays fully static and uses the PAT login only.
//
// Setup
// -----
//   1. Create a GitHub OAuth App: https://github.com/settings/developers
//        - Homepage URL:               your MindSpark URL
//        - Authorization callback URL: https://<your-worker>.workers.dev/callback
//      Copy the Client ID; generate a Client secret.
//   2. Set the secrets (from this folder):
//        wrangler secret put GITHUB_CLIENT_ID
//        wrangler secret put GITHUB_CLIENT_SECRET
//   3. Deploy:
//        wrangler deploy
//   4. In public/app.js set:
//        GH_OAUTH.clientId  = '<your client id>'
//        GH_OAUTH.workerUrl = 'https://<your-worker>.workers.dev'
// -----------------------------------------------------------------------------

import { handleImport } from './import-core.js';
export { CollabRoom } from './collab-do.js';
import { signJWT } from './auth-core.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Live collaboration WebSocket: /api/collab/<roomId> -> the map's Durable Object.
    if (url.pathname.startsWith('/api/collab/')) {
      const rest = url.pathname.slice('/api/collab/'.length);
      const room = decodeURIComponent(rest.split('/')[0] || '');   // first segment only; /acl,/link go to the DO
      if (!room) return new Response('room required', { status: 400 });
      const stub = env.COLLAB.get(env.COLLAB.idFromName(room));
      return stub.fetch(request);
    }

    // Session token: verify the caller's GitHub token, mint a short-lived signed JWT
    // (identity = GitHub id + login) the app sends as a Bearer to the collab DO for ACLs.
    if (url.pathname === '/api/session') {
      const allowed = (env.ALLOWED_ORIGIN || '*').replace(/\/+$/, '') || '*';
      const cors = { 'Access-Control-Allow-Origin': allowed, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
      const jres = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      if (request.method !== 'POST') return jres(405, { error: 'method not allowed' });
      if (!env.AUTH_SECRET) return jres(501, { error: 'identity not configured' });   // app falls back to legacy links
      let ghToken = '';
      const auth = request.headers.get('Authorization') || '';
      const m = auth.match(/^Bearer\s+(.+)$/i);
      if (m) ghToken = m[1];
      if (!ghToken) { try { const b = await request.json(); ghToken = (b && b.token) || ''; } catch (e) {} }
      if (!ghToken) return jres(400, { error: 'github token required' });
      let u;
      try {
        const gh = await fetch('https://api.github.com/user', {
          headers: { 'Authorization': 'Bearer ' + ghToken, 'User-Agent': 'MindSpark', 'Accept': 'application/vnd.github+json' }
        });
        if (!gh.ok) return jres(401, { error: 'invalid github token' });
        u = await gh.json();
      } catch (e) { return jres(502, { error: 'github unreachable' }); }
      if (!u || u.id == null) return jres(401, { error: 'no github identity' });
      const ttl = 12 * 60 * 60;   // 12h
      const token = await signJWT({ sub: String(u.id), login: u.login || '' }, env.AUTH_SECRET, ttl);
      return jres(200, { token, exp: Math.floor(Date.now() / 1000) + ttl, id: String(u.id), login: u.login || '' });
    }

    // GPT map import (POST /api/import) — returns a read-only #view= share link.
    if (url.pathname === '/api/import' && request.method === 'POST') {
      return handleImport(request, env);
    }

    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      const state = (url.searchParams.get('state') || '').replace(/[^A-Za-z0-9_-]/g, '');
      if (!code) return html(resultPage('', state, 'missing_code', (env.ALLOWED_ORIGIN || '').replace(/\/+$/, '')));

      // Where the token may be delivered. If ALLOWED_ORIGIN is set (recommended),
      // the token is postMessage'd ONLY to that origin — otherwise a malicious
      // site that opens the authorize URL itself could receive a previously-
      // authorized user's token via its own opener window.
      const allowed = (env.ALLOWED_ORIGIN || '').replace(/\/+$/, '');
      let token = '', error = '';
      try {
        const resp = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: env.GITHUB_CLIENT_ID,
            client_secret: env.GITHUB_CLIENT_SECRET,
            code
          })
        });
        const data = await resp.json();
        token = data.access_token || '';
        error = data.error || (token ? '' : 'no_token');
      } catch (e) {
        error = 'exchange_failed';
      }
      return html(resultPage(token, state, error, allowed));
    }

    if (url.pathname === '/' || url.pathname === '') {
      return new Response('MindSpark OAuth worker is running. The app calls /callback.', {
        status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
    return new Response('Not found', { status: 404 });
  }
};

// HTML page returned to the popup: posts the result to the opener, then closes.
function resultPage(token, state, error, allowedOrigin) {
  // JSON.stringify makes each value a safe JS literal; escape "<" defensively so
  // no field can ever break out of the <script> block.
  const payload = JSON.stringify({ type: 'mindspark-oauth', token, state, error })
    .replace(/</g, '\\u003c');
  // Restrict delivery to the configured app origin when provided ('*' otherwise,
  // for backwards compatibility — set ALLOWED_ORIGIN, see README).
  const target = JSON.stringify(allowedOrigin || '*');
  const msg = error ? 'Sign-in failed. You can close this window.'
                    : 'Signed in. You can close this window.';
  return `<!doctype html><html><head><meta charset="utf-8"><title>MindSpark — GitHub</title>
<style>body{font:15px system-ui,-apple-system,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#333}</style>
</head><body><p>${msg}</p>
<script>
(function(){
  try { if (window.opener) window.opener.postMessage(${payload}, ${target}); } catch (e) {}
  setTimeout(function(){ try { window.close(); } catch (e) {} }, 400);
})();
</script>
</body></html>`;
}

function html(body) {
  return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
