// MindSpark — GPT map import via read-only share link (no GitHub, no PAT).
// The worker turns a GPT/structured-output map spec into the SAME gzip+base64url
// "#view=" token the app's "Copy share link" feature produces, so the generated
// map opens as a read-only view in any browser. The viewer clicks "Make an
// editable copy" to save it into THEIR own repo with THEIR token — so this works
// for every user and needs no personal access token on the worker.

const J = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

// gzip + base64url, byte-identical to the app's _gzip + _b64urlFromBytes.
async function gzipB64url(str){
  const cs = new CompressionStream('gzip');
  const w = cs.writable.getWriter(); w.write(new TextEncoder().encode(str)); w.close();
  const bytes = new Uint8Array(await new Response(cs.readable).arrayBuffer());
  let bin = ''; const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function handleImport(request, env){
  // Optional shared secret to stop your worker being used as a free service.
  if (env.IMPORT_TOKEN && request.headers.get('Authorization') !== `Bearer ${env.IMPORT_TOKEN}`)
    return J(401, { error: 'unauthorized' });

  let spec; try { spec = await request.json(); } catch (e) { return J(400, { error: 'body must be valid JSON' }); }
  let map;  try { map = buildMapFromSpec(spec); } catch (e) { return J(400, { error: String(e && e.message || e) }); }

  // Same shape as the app's _shareePayload(); the shared view runs autoLayout()
  // itself, so no node positions are needed.
  const payload = { v: 1, title: map.title, color: map.color, style: map.style,
                    layout: map.layout, rootId: map.rootId, nodes: map.nodes, links: map.links, vars: {} };
  const token = 'g' + await gzipB64url(JSON.stringify(payload));
  const allowed = (env.ALLOWED_ORIGIN || '').replace(/\/+$/, '');
  return J(201, { id: map.id, url: `${allowed}/#view=${token}` });
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
    if (typeof n.notes === 'string' && n.notes.trim()) node.notes = n.notes;     // sticky note (rich HTML)
    if (n.collapsed === true) node.collapsed = true;
    if (n.tag != null && n.tag !== '') node.tag = String(n.tag);
    // Bulleted/numbered list: multi-line text rendered as a list (selective use).
    if (n.listType === 'ul' || n.listType === 'ol') { node.listType = n.listType; node.align = node.align || 'left'; }
    if (n.bold === true) node.bold = true;
    if (n.italic === true) node.italic = true;
    if (n.highlight === true) node.highlight = true;
    if (n.align === 'left' || n.align === 'center' || n.align === 'right') node.align = n.align;
    // Checklist item: "done" or "todo".
    if (n.task === 'done' || n.task === 'todo') node.task = n.task;
    if (n.citation && typeof n.citation === 'object') {
      const c = n.citation, cit = {};
      if (Array.isArray(c.authors) && c.authors.length) cit.authors = c.authors.join(', ');
      else if (typeof c.authors === 'string' && c.authors.trim()) cit.authors = c.authors.trim();
      if (c.year != null) cit.year = c.year;
      if (typeof c.title === 'string' && c.title.trim()) cit.title = c.title.trim();
      if (typeof c.source === 'string' && c.source.trim()) cit.source = c.source.trim();   // journal / venue
      if (typeof c.doi === 'string' && c.doi.trim()) cit.doi = c.doi.trim();
      else if (typeof c.arxiv === 'string' && c.arxiv.trim()) { cit.doi = 'arXiv:' + c.arxiv.trim(); if(!cit.source) cit.source = 'arXiv'; }
      if (Object.keys(cit).length) { node.citation = cit; node.ref = true; }
    }
    nodes[n.id] = node;
  }

  // Balance root branches like balanceRootSides(): first half right, second half left.
  const rootKids = inNodes.filter(n => n.id !== rootId && n.parent === rootId).map(n => n.id);
  const half = Math.ceil(rootKids.length / 2);
  rootKids.forEach((id, i) => { nodes[id].side = (i < half) ? 'right' : 'left'; });

  const links = Array.isArray(spec.links)
    ? spec.links.filter(l => l && byId.has(l.from) && byId.has(l.to))
                .map(l => { const o = { from: l.from, to: l.to }; if (l.label != null && l.label !== '') o.label = String(l.label); return o; })
    : [];
  return { id: uid(), title, color: (typeof spec.color === 'string' && spec.color) ? spec.color : '#e0613a',
           style: undefined, layout: 'balanced', rootId, nodes, links };
}
