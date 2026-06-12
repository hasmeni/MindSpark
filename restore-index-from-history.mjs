// Restore _index.json for your MindSpark `mindspark-maps` repo from GitHub's
// commit history — i.e. the exact list you had *before* it got clobbered. Because
// it restores a real past version, it RESPECTS deletions (it can never resurrect a
// map you intentionally deleted, unlike rebuilding from the maps/ folder).
//
// Usage (Node 18+):
//   GH_TOKEN=ghp_xxx GH_USER=you node restore-index-from-history.mjs            # auto-pick + restore
//   DRY=1   ... node restore-index-from-history.mjs                              # preview only, no write
//   PICK=<commitSha> ... node restore-index-from-history.mjs                     # restore a specific version
//
// It prints every historical version with its date and map-count so you can pick
// manually (set PICK=) if the auto choice isn't the one you want.

const token = process.env.GH_TOKEN, user = process.env.GH_USER;
const repo  = process.env.REPO || 'mindspark-maps';
const DRY   = process.env.DRY === '1';
const PICK  = process.env.PICK || null;
if (!token || !user) { console.error('Set GH_TOKEN and GH_USER.'); process.exit(1); }
const H = { Authorization: `token ${token}`, Accept: 'application/vnd.github+json' };
const api = (p, o = {}) => fetch(`https://api.github.com/repos/${user}/${repo}/${p}`, { ...o, headers: { ...H, ...(o.headers || {}) } });
const parseAt = async (ref) => {
  const r = await api(`contents/_index.json?ref=${encodeURIComponent(ref)}`);
  if (!r.ok) return null;
  const d = await r.json();
  try { return JSON.parse(Buffer.from(d.content, 'base64').toString('utf8')); } catch { return null; }
};

// 1. History of _index.json (newest first)
const ch = await api('commits?path=_index.json&per_page=50');
if (!ch.ok) { console.error('Could not read history:', ch.status, await ch.text()); process.exit(1); }
const commits = await ch.json();
if (!commits.length) { console.error('No history for _index.json.'); process.exit(1); }

// 2. Tabulate each version's map count
console.log('\n#   date                  maps  commit');
const rows = [];
for (let i = 0; i < commits.length; i++) {
  const c = commits[i];
  const arr = await parseAt(c.sha);
  const count = Array.isArray(arr) ? arr.length : '?';
  rows.push({ sha: c.sha, date: c.commit.author.date, count, arr });
  console.log(String(i).padEnd(3), (c.commit.author.date || '').padEnd(21), String(count).padStart(4), ' ', c.sha.slice(0, 8));
}

// 3. Choose the version to restore
let chosen;
if (PICK) {
  chosen = rows.find(r => r.sha.startsWith(PICK));
  if (!chosen) { console.error(`\nPICK ${PICK} not found in history.`); process.exit(1); }
} else {
  const current = typeof rows[0].count === 'number' ? rows[0].count : 0;
  // newest version that had MORE maps than the current (clobbered) one
  chosen = rows.slice(1).find(r => typeof r.count === 'number' && r.count > current);
  if (!chosen) { console.error('\nNo earlier version has more maps than the current one — nothing obvious to restore. Use PICK=<sha> to force one.'); process.exit(1); }
  console.log(`\nAuto-picked the last version with more maps than now (${current}): ${chosen.sha.slice(0,8)} (${chosen.count} maps, ${chosen.date}).`);
}

if (DRY) { console.log('\nDRY run — would restore this list:\n', JSON.stringify(chosen.arr, null, 2)); process.exit(0); }

// 4. Write it back as the current _index.json (needs the current HEAD blob sha)
let sha = null;
const cur = await api('contents/_index.json');
if (cur.ok) sha = (await cur.json()).sha;
const body = { message: `MindSpark: restore _index.json from ${chosen.sha.slice(0,8)} (${chosen.count} maps)`,
               content: Buffer.from(JSON.stringify(chosen.arr)).toString('base64') };
if (sha) body.sha = sha;
const put = await api('contents/_index.json', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
if (!put.ok) { console.error('Restore failed:', put.status, await put.text()); process.exit(1); }
console.log(`\n✓ Restored _index.json with ${chosen.count} maps. Reload MindSpark.`);
