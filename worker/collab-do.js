// MindSpark live collaboration — one Durable Object instance per map "room".
// It is a dependency-free RELAY: it broadcasts ops + cursor/presence between
// connected clients and keeps one opaque latest snapshot in storage so that a
// late joiner can sync immediately. It never parses the map model itself.
// Uses the WebSocket Hibernation API so idle rooms cost nothing.
import { DurableObject } from 'cloudflare:workers';

const COLORS = ['#e0613a','#3a6ea5','#2e9e6b','#9a5bb8','#d0902e','#c14d7a','#1f8a8a','#b8513a'];

export class CollabRoom extends DurableObject {
  async fetch(request){
    if (request.headers.get('Upgrade') !== 'websocket') return this._http(request);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);                       // hibernatable

    const taken = new Set();
    for (const w of this.ctx.getWebSockets()) { const a=this._att(w); if(a) taken.add(a.color); }
    const color = COLORS.find(c=>!taken.has(c)) || COLORS[Math.floor(Math.random()*COLORS.length)];
    const id = crypto.randomUUID().slice(0,8);
    server.serializeAttachment({ id, color, name:'' });

    const snapshot = await this.ctx.storage.get('snapshot');
    server.send(JSON.stringify({ t:'welcome', id, color, snapshot: snapshot||null, peers: this._peers(server) }));
    this._broadcast(server, { t:'join', id, color });
    return new Response(null, { status:101, webSocket: client });
  }

  // Validate the edit token. allowClaim lets the FIRST write claim an unclaimed map.
  async _tokenOk(request, allowClaim){
    const provided = request.headers.get('X-Edit-Token') || '';
    const stored = await this.ctx.storage.get('editToken');
    if (stored) return provided === stored ? { ok: true } : { ok: false, status: 403, error: 'invalid edit token' };
    if (allowClaim){ if (!provided) return { ok: false, status: 400, error: 'edit token required' }; await this.ctx.storage.put('editToken', provided); return { ok: true }; }
    return { ok: false, status: 404, error: 'map not found' };
  }
  // Apply per-node ops onto the stored snapshot so concurrent async edits converge
  // (node-level last-write-wins) instead of whole-map overwrite.
  _applyOps(snap, ops){
    snap.nodes = snap.nodes || {};
    for (const op of (ops || [])){
      if (op && op.t === 'node' && op.id) snap.nodes[op.id] = op.n;
      else if (op && op.t === 'del' && op.id) delete snap.nodes[op.id];
      else if (op && op.t === 'meta' && op.k) snap[op.k] = op.v;
    }
    return snap;
  }
  // Durable shared-map HTTP API (no session needed): GET loads the stored map,
  // PUT publishes/updates it. This promotes the in-storage snapshot to a
  // persistent source of truth a collaborator can open any time.
  async _http(request){
    const origin = (this.env && this.env.ALLOWED_ORIGIN) || '*';
    const cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, PUT, PATCH, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Edit-Token' };
    const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method === 'GET'){
      const snap = await this.ctx.storage.get('snapshot');
      return snap ? json(200, snap) : json(404, { error: 'not found' });
    }
    if (request.method === 'PUT'){
      let m; try{ m = await request.json(); }catch(e){ return json(400, { error: 'bad json' }); }
      if (!m || typeof m !== 'object') return json(400, { error: 'map object required' });
      const t = await this._tokenOk(request, true);   // first PUT claims the token
      if (!t.ok) return json(t.status, { error: t.error });
      await this.ctx.storage.put('snapshot', m);
      return json(200, { ok: true });
    }
    if (request.method === 'PATCH'){
      const t = await this._tokenOk(request, false);  // map must already be claimed
      if (!t.ok) return json(t.status, { error: t.error });
      let body; try{ body = await request.json(); }catch(e){ return json(400, { error: 'bad json' }); }
      const ops = Array.isArray(body && body.ops) ? body.ops : [];
      let snap = await this.ctx.storage.get('snapshot') || { nodes: {} };
      snap = this._applyOps(snap, ops);               // merge onto current -> no whole-map clobber
      await this.ctx.storage.put('snapshot', snap);
      return json(200, { ok: true, map: snap });      // return merged map so the client converges
    }
    return json(405, { error: 'method not allowed' });
  }

  async webSocketMessage(ws, message){
    let m; try{ m = JSON.parse(message); }catch{ return; }
    const me = this._att(ws) || {};
    if (m.t === 'snapshot'){ await this.ctx.storage.put('snapshot', m.map); return; }   // store opaque
    if (m.t === 'name'){
      const name = String(m.name||'').slice(0,40);
      ws.serializeAttachment({ ...me, name });
      this._broadcast(ws, { t:'name', id: me.id, name });
      return;
    }
    m.from = me.id;                                          // tag ops/cursor with sender, relay to others
    this._broadcast(ws, m);
  }
  async webSocketClose(ws){ this._leave(ws); }
  async webSocketError(ws){ this._leave(ws); }

  _att(ws){ try{ return ws.deserializeAttachment(); }catch{ return null; } }
  _peers(except){
    const out=[]; for(const w of this.ctx.getWebSockets()){ if(w===except) continue; const a=this._att(w); if(a) out.push({id:a.id,color:a.color,name:a.name||''}); }
    return out;
  }
  _broadcast(sender, data){
    const s = JSON.stringify(data);
    for(const w of this.ctx.getWebSockets()){ if(w===sender) continue; try{ w.send(s); }catch{} }
  }
  _leave(ws){ const me=this._att(ws)||{}; try{ ws.close(); }catch{} this._broadcast(ws, { t:'leave', id: me.id }); }
}
