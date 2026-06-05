/**
 * MindSpark — open-source mind mapping server.
 *
 * ZERO dependencies. Uses Node's built-in HTTP server and built-in SQLite.
 * No `npm install` required. Just:
 *
 *   node server.js
 *
 * Requires Node.js >= 22 (for the built-in node:sqlite module).
 *
 * Environment variables (all optional):
 *   PORT     – HTTP port            (default 3000)
 *   DB_PATH  – SQLite database file (default ./data/mindspark.db)
 *   PUBLIC   – static files dir     (default ./public)
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'mindspark.db');
const PUBLIC = process.env.PUBLIC || path.join(__dirname, 'public');

// ---- database ------------------------------------------------------------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS maps (
    id      TEXT PRIMARY KEY,
    title   TEXT NOT NULL DEFAULT 'Untitled map',
    color   TEXT,
    data    TEXT NOT NULL,
    updated INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS map_versions (
    id    TEXT NOT NULL,
    ts    INTEGER NOT NULL,
    data  TEXT NOT NULL,
    PRIMARY KEY (id, ts)
  );
  CREATE INDEX IF NOT EXISTS idx_versions_id ON map_versions (id, ts DESC);
`);
const Q = {
  list:   db.prepare('SELECT id, title, color, updated FROM maps ORDER BY updated DESC'),
  get:    db.prepare('SELECT data FROM maps WHERE id = ?'),
  insert: db.prepare('INSERT INTO maps (id,title,color,data,updated) VALUES (?,?,?,?,?)'),
  update: db.prepare('UPDATE maps SET title=?, color=?, data=?, updated=? WHERE id=?'),
  del:    db.prepare('DELETE FROM maps WHERE id = ?'),
  // version history
  vLatest: db.prepare('SELECT data FROM map_versions WHERE id = ? ORDER BY ts DESC LIMIT 1'),
  vInsert: db.prepare('INSERT OR REPLACE INTO map_versions (id,ts,data) VALUES (?,?,?)'),
  vList:   db.prepare('SELECT ts FROM map_versions WHERE id = ? ORDER BY ts DESC LIMIT 100'),
  vGet:    db.prepare('SELECT data FROM map_versions WHERE id = ? AND ts = ?'),
  vDelOld: db.prepare('DELETE FROM map_versions WHERE id = ? AND ts NOT IN (SELECT ts FROM map_versions WHERE id = ? ORDER BY ts DESC LIMIT 50)'),
  vDelAll: db.prepare('DELETE FROM map_versions WHERE id = ?')
};
const upsert = (m) => {
  const data = JSON.stringify(m);
  const updated = m.updated || Date.now();
  const r = Q.update.run(m.title || 'Untitled map', m.color || null, data, updated, m.id);
  if (r.changes === 0) Q.insert.run(m.id, m.title || 'Untitled map', m.color || null, data, updated);
  // Snapshot a version only when the content actually changed (skips no-op autosaves),
  // then prune to the most recent 50 per map.
  const last = Q.vLatest.get(m.id);
  if (!last || last.data !== data) {
    Q.vInsert.run(m.id, updated, data);
    Q.vDelOld.run(m.id, m.id);
  }
};

// ---- tiny helpers --------------------------------------------------------
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon' };
const send = (res, code, body, type='application/json') => {
  res.writeHead(code, { 'Content-Type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve, reject) => {
  let d = '';
  req.on('data', c => { d += c; if (d.length > 8e6) { req.destroy(); reject(new Error('payload too large')); } });
  req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
  req.on('error', reject);
});

// ---- server --------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // Baseline security headers on every response.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  // Defense-in-depth CSP. Permits everything the app actually uses (self,
  // inline styles/script for the bootstrap, Google Fonts, data:/blob: images,
  // and the GitHub API for cloud mode) while blocking external script/exfil
  // origins, framing, and plugins. Relax if you self-host extra integrations.
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self' https://api.github.com https://api.crossref.org https://api.anthropic.com https://api.openai.com",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'"
  ].join('; '));

  try {
    // ----- API -----
    if (p === '/api/maps' && req.method === 'GET') return send(res, 200, Q.list.all());

    if (p === '/api/maps' && req.method === 'POST') {
      const m = await readBody(req);
      if (!m || !m.id) return send(res, 400, { error: 'missing map id' });
      upsert(m); return send(res, 201, { ok: true, id: m.id });
    }

    const idMatch = p.match(/^\/api\/maps\/([\w-]+)$/);
    if (idMatch) {
      const id = idMatch[1];
      if (req.method === 'GET') {
        const row = Q.get.get(id);
        return row ? send(res, 200, row.data, 'application/json') : send(res, 404, { error: 'not found' });
      }
      if (req.method === 'PUT') {
        const m = await readBody(req); m.id = id; upsert(m);
        return send(res, 200, { ok: true, id });
      }
      if (req.method === 'DELETE') { Q.del.run(id); Q.vDelAll.run(id); res.writeHead(204); return res.end(); }
    }

    // ----- version history -----
    const vListMatch = p.match(/^\/api\/maps\/([\w-]+)\/versions$/);
    if (vListMatch && req.method === 'GET') {
      return send(res, 200, Q.vList.all(vListMatch[1]).map(r => ({ ts: r.ts })));
    }
    const vGetMatch = p.match(/^\/api\/maps\/([\w-]+)\/versions\/(\d+)$/);
    if (vGetMatch && req.method === 'GET') {
      const row = Q.vGet.get(vGetMatch[1], Number(vGetMatch[2]));
      return row ? send(res, 200, row.data, 'application/json') : send(res, 404, { error: 'not found' });
    }

    if (p === '/healthz') return send(res, 200, { ok: true });

    // ----- static files -----
    let file = p === '/' ? '/index.html' : p;
    const full = path.join(PUBLIC, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
    if (full.startsWith(PUBLIC) && fs.existsSync(full) && fs.statSync(full).isFile()) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      return send(res, 200, fs.readFileSync(full), MIME[path.extname(full)] || 'application/octet-stream');
    }

    // If the frontend itself is missing, explain it instead of a cryptic 404.
    if (!fs.existsSync(path.join(PUBLIC, 'index.html'))) {
      return send(res, 500, `<!doctype html><meta charset=utf-8>
        <style>body{font-family:system-ui;max-width:640px;margin:60px auto;padding:0 24px;line-height:1.6;color:#23201b}
        code{background:#f0ece3;padding:2px 6px;border-radius:5px}h1{color:#b8451f}</style>
        <h1>Frontend files not found</h1>
        <p>The server is running, but it can't find the <code>public/</code> folder with the app's files.</p>
        <p>It looked here:<br><code>${PUBLIC}</code></p>
        <p><b>Fix:</b> make sure a <code>public</code> folder (containing <code>index.html</code>,
        <code>app.js</code>, <code>styles.css</code>) sits right next to <code>server.js</code>,
        then run <code>node server.js</code> again from that folder. Re-extracting the zip usually resolves it.</p>`,
        'text/html');
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`\n  MindSpark running → http://localhost:${PORT}`);
  console.log(`  Database          → ${DB_PATH}`);
  const ok = fs.existsSync(path.join(PUBLIC, 'index.html'));
  console.log(`  Frontend          → ${PUBLIC}  ${ok ? '✓ found' : '✗ NOT FOUND'}`);
  if (!ok) {
    console.log(`\n  ⚠  public/index.html was not found at the path above.`);
    console.log(`     Make sure the "public" folder is next to server.js, then restart.`);
  }
  console.log(`  (zero dependencies — Node built-in HTTP + SQLite)\n`);
});
