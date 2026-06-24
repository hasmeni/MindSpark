// MindSpark — shared map-import logic (used by the app worker's /api/import route).
// Converts a GPT/structured-output map spec into MindSpark's stored map model and
// writes it (plus an _index.json entry) into the mindspark-maps repo via GITHUB_PAT.

const J = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const ghHeaders = (pat) => ({
  Authorization: `token ${pat}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'MindSpark-Import'   // GitHub rejects requests without a User-Agent
});

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

export async function handleImport(request, env){
  if (!env.IMPORT_TOKEN) return J(500, { error: 'IMPORT_TOKEN is not configured on the worker' });
  if (request.headers.get('Authorization') !== `Bearer ${env.IMPORT_TOKEN}`) return J(401, { error: 'unauthorized' });
  if (!env.GITHUB_PAT) return J(500, { error: 'GITHUB_PAT is not configured on the worker' });

  let spec; try { spec = await request.json(); } catch (e) { return J(400, { error: 'body must be valid JSON' }); }
  let map;  try { map = buildMapFromSpec(spec); } catch (e) { return J(400, { error: String(e && e.message || e) }); }

  let owner = env.GITHUB_OWNER;
  if (!owner) {
    const u = await fetch('https://api.github.com/user', { headers: ghHeaders(env.GITHUB_PAT) });
    if (!u.ok) return J(500, { error: `GITHUB_PAT rejected by GitHub (HTTP ${u.status})` });
    owner = (await u.json()).login;
  }
  const repo = env.GITHUB_REPO || 'mindspark-maps';

  const wr = await ghPutFile(env, owner, repo, `maps/${map.id}.json`, JSON.stringify(map));
  if (!wr.ok) {
    const t = await wr.text();
    return J(502, { error: `could not write map (HTTP ${wr.status}). The '${repo}' repo must exist (sign in to MindSpark once) and the PAT needs Contents read/write. ${t.slice(0,160)}` });
  }
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

const uid = () => Math.random().toString(36).slice(2, 9);
export function buildMapFromSpec(spec){
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
