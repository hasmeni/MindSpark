// MindSpark live collaboration — one Durable Object instance per map "room".
// It is a dependency-free RELAY: it broadcasts ops + cursor/presence between
// connected clients and keeps one opaque latest snapshot in storage so that a
// late joiner can sync immediately. It never parses the map model itself.
// Uses the WebSocket Hibernation API so idle rooms cost nothing.
import { DurableObject } from 'cloudflare:workers';
import { handleCollabHttp } from './collab-http.js';

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

  // Durable shared-map HTTP API with identity-based ACLs. All policy + routing lives
  // in the (Cloudflare-free, unit-tested) collab-http module; here we just add CORS.
  async _http(request){
    const origin = (this.env && this.env.ALLOWED_ORIGIN) || '*';
    const cors = { 'Access-Control-Allow-Origin': origin,
                   'Access-Control-Allow-Methods': 'GET, PUT, PATCH, POST, DELETE, OPTIONS',
                   'Access-Control-Allow-Headers': 'Content-Type, X-Edit-Token, Authorization' };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let res; try{ res = await handleCollabHttp(this.ctx.storage, this.env, request); }
    catch(e){ res = { status: 500, body: { error: 'server error' } }; }
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { ...cors, 'Content-Type': 'application/json' } });
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
