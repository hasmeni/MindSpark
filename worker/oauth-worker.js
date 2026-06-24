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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);


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
