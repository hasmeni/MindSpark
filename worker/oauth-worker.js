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

    // --- GPT map import: POST /api/import ------------------------------------
    // Writes a generated map into the mindspark-maps repo (via GITHUB_PAT) so it
    // shows up in the app. servers.url for the Custom GPT Action points here.
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


// ===========================================================================
// MindSpark map import (GPT integration)
// ===========================================================================
const J = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const ghHeaders = (pat) => ({
  Authorization: `token ${pat}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'MindSpark-Import'   // GitHub rejects requests without a User-Agent
});

// UTF-8-safe base64 (btoa is Latin-1 only)
function b64(str){
  const bytes = new TextEncoder().encode(str);
  let bin = ''; const C = 0x8000;
  for (let i = 0; i < bytes.length; i += C) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + C));
  return btoa(bin);
}
function unb64(s){
  const bin = atob((s || '').replace(/\n/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

async function ghGetFile(env, owner, repo, path){
  const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, { headers: ghHeaders(env.GITHUB_PAT) });
  if (r.status === 404) return { sha: null, json: null };
  if (!r.ok) throw new Error(`GitHub read ${path}: HTTP ${r.status}`);
  const d = await r.json();
  let json = null; try { json = JSON.parse(unb64(d.content)); } catch (e) {}
  return { sha: d.sha, json };
}
function ghPutFile(env, owner, repo, path, contentStr, sha){
  const body = { message: `MindSpark import: ${path}`, content: b64(contentStr) };
  if (sha) body.sha = sha;
  return fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
    method: 'PUT', headers: { ...ghHeaders(env.GITHUB_PAT), 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
}

async function handleImport(request, env){
  // Fail closed: a public write endpoint must be protected.
  if (!env.IMPORT_TOKEN) return J(500, { error: 'IMPORT_TOKEN is not configured on the worker' });
  if (request.headers.get('Authorization') !== `Bearer ${env.IMPORT_TOKEN}`) return J(401, { error: 'unauthorized' });
  if (!env.GITHUB_PAT) return J(500, { error: 'GITHUB_PAT is not configured on the worker' });

  let spec; try { spec = await request.json(); } catch (e) { return J(400, { error: 'body must be valid JSON' }); }
  let map;  try { map = buildMapFromSpec(spec); } catch (e) { return J(400, { error: String(e && e.message || e) }); }

  // Owner: explicit GITHUB_OWNER, else the PAT's own account.
  let owner = env.GITHUB_OWNER;
  if (!owner) {
    const u = await fetch('https://api.github.com/user', { headers: ghHeaders(env.GITHUB_PAT) });
    if (!u.ok) return J(500, { error: `GITHUB_PAT rejected by GitHub (HTTP ${u.status})` });
    owner = (await u.json()).login;
  }
  const repo = env.GITHUB_REPO || 'mindspark-maps';

  // 1) Write the map file (fresh id -> no sha).
  const wr = await ghPutFile(env, owner, repo, `maps/${map.id}.json`, JSON.stringify(map));
  if (!wr.ok) {
    const t = await wr.text();
    return J(502, { error: `could not write map (HTTP ${wr.status}). The '${repo}' repo must exist (sign in to MindSpark once) and the PAT needs Contents read/write. ${t.slice(0,160)}` });
  }

  // 2) Add to _index.json so it appears in the sidebar (best-effort, one retry on sha conflict).
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const idx = await ghGetFile(env, owner, repo, '_index.json');
      let arr = Array.isArray(idx.json) ? idx.json : [];
      arr = arr.filter(e => e && e.id !== map.id);
      arr.unshift({ id: map.id, title: map.title, color: map.color, updated: map.updated });
      arr.sort((a, b) => (b.updated || 0) - (a.updated || 0));
      const ir = await ghPutFile(env, owner, repo, '_index.json', JSON.stringify(arr), idx.sha);
      if (ir.ok || (ir.status !== 409 && ir.status !== 422)) break;
    }
  } catch (e) { /* index is best-effort; the map still opens via ?map=<id> */ }

  const allowed = (env.ALLOWED_ORIGIN || '').replace(/\/+$/, '');
  return J(201, { id: map.id, url: `${allowed}/?map=${map.id}` });
}

// Identical conversion to server.js: spec -> MindSpark map model. Positions stay
// 0,0 and `_import:true` makes the app lay it out (with real measurements) on open.
const uid = () => Math.random().toString(36).slice(2, 9);
function buildMapFromSpec(spec){
  if (!spec || typeof spec !== 'object') throw new Error('body must be a JSON object');
  const title = (typeof spec.title === 'string' && spec.title.trim()) ? spec.title.trim() : 'Imported map';
  const inNodes = Array.isArray(spec.nodes) ? spec.nodes : null;
  if (!inNodes || !inNodes.length) throw new Error('nodes[] is required and must be non-empty');

  const byId = new Map();
  for (const n of inNodes) {
    if (!n || typeof n.id !== 'string' || !n.id) throw new Error('every node needs a non-empty string id');
    if (byId.has(n.id)) throw new Error('duplicate node id: ' + n.id);
    if (typeof n.text !== 'string') throw new Error('node ' + n.id + ' is missing text');
    byId.set(n.id, n);
  }
  let rootId = (typeof spec.rootId === 'string' && spec.rootId) ? spec.rootId : null;
  if (rootId && !byId.has(rootId)) throw new Error('rootId does not match any node');
  if (!rootId) {
    const roots = inNodes.filter(n => n.parent == null);
    if (roots.length !== 1) throw new Error('exactly one root node (parent=null) required, found ' + roots.length);
    rootId = roots[0].id;
  }
  for (const n of inNodes) {
    if (n.id === rootId) continue;
    if (n.parent == null) throw new Error('node ' + n.id + ' has no parent (only the root may be parent-less)');
    if (!byId.has(n.parent)) throw new Error('node ' + n.id + ' references missing parent ' + n.parent);
    if (n.parent === n.id) throw new Error('node ' + n.id + ' is its own parent');
  }
  const N = byId.size;
  for (const n of inNodes) { let cur = n, hops = 0; while (cur && cur.id !== rootId) { cur = byId.get(cur.parent); if (++hops > N) throw new Error('cycle detected near node ' + n.id); } }

  const nodes = {};
  for (const n of inNodes) {
    const node = { id: n.id, text: String(n.text), parent: n.id === rootId ? null : n.parent,
      x: 0, y: 0, side: n.id === rootId ? 'root' : null, color: (typeof n.color === 'string' && n.color) ? n.color : '#fff' };
    if (typeof n.notes === 'string' && n.notes.trim()) node.notes = n.notes;
    if (n.collapsed === true) node.collapsed = true;
    if (n.tag != null && n.tag !== '') node.tag = String(n.tag);
    if (n.citation && typeof n.citation === 'object') {
      const c = n.citation, cit = {};
      if (Array.isArray(c.authors) && c.authors.length) cit.authors = c.authors.join(', ');
      else if (typeof c.authors === 'string' && c.authors.trim()) cit.authors = c.authors.trim();
      if (c.year != null) cit.year = c.year;
      if (typeof c.title === 'string' && c.title.trim()) cit.title = c.title.trim();
      if (typeof c.doi === 'string' && c.doi.trim()) cit.doi = c.doi.trim();
      else if (typeof c.arxiv === 'string' && c.arxiv.trim()) { cit.doi = 'arXiv:' + c.arxiv.trim(); cit.source = 'arXiv'; }
      if (Object.keys(cit).length) { node.citation = cit; node.ref = true; }
    }
    nodes[n.id] = node;
  }
  const links = Array.isArray(spec.links)
    ? spec.links.filter(l => l && byId.has(l.from) && byId.has(l.to))
                .map(l => { const o = { from: l.from, to: l.to }; if (l.label != null && l.label !== '') o.label = String(l.label); return o; })
    : [];
  return { id: uid(), title, titleAuto: false, color: (typeof spec.color === 'string' && spec.color) ? spec.color : '#e0613a',
           layout: 'balanced', rootId, nodes, links, _import: true, updated: Date.now() };
}
