// MindSpark — identity & access-control core (no Cloudflare imports, unit-testable).
// Provides HMAC-SHA256 JWT mint/verify (WebCrypto, available in Workers and Node 22)
// and a PURE authorization decision used by the collab Durable Object.
//
// Identity-based ACL model (per map room), stored in the DO as `acl`:
//   { ownerId:"<gh id>", ownerLogin:"<login>",
//     members:{ "<gh id>": { role:"editor"|"viewer", login:"<login>" }, ... },
//     linkAccess:"none"|"view"|"edit" }     // "anyone with the link" capability
// Legacy capability links (#shared=id:token) keep working via the stored editToken;
// when an owner first claims a token-map, linkAccess defaults to "edit" so old links
// don't break, and the owner can tighten it later (revoke = set linkAccess "none").

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64url(buf){
  const u = new Uint8Array(buf); let s='';
  for(let i=0;i<u.length;i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
export function b64urlToBytes(str){
  let s = String(str).replace(/-/g,'+').replace(/_/g,'/');
  while(s.length % 4) s += '=';
  const bin = atob(s); const u = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) u[i] = bin.charCodeAt(i);
  return u;
}
async function hmacKey(secret){
  return crypto.subtle.importKey('raw', enc.encode(String(secret)),
    { name:'HMAC', hash:'SHA-256' }, false, ['sign','verify']);
}
// Mint a compact JWS (HS256). payload should include sub/login; exp is added if ttlSec given.
export async function signJWT(payload, secret, ttlSec){
  const now = Math.floor(Date.now()/1000);
  const body = { iat: now, ...(ttlSec ? { exp: now + ttlSec } : {}), ...payload };
  const head = b64url(enc.encode(JSON.stringify({ alg:'HS256', typ:'JWT' })));
  const pl   = b64url(enc.encode(JSON.stringify(body)));
  const data = head + '.' + pl;
  const sig  = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data));
  return data + '.' + b64url(sig);
}
// Verify signature + expiry; returns the payload object or null.
export async function verifyJWT(token, secret){
  const parts = String(token||'').split('.');
  if(parts.length !== 3) return null;
  const [h,p,s] = parts;
  let ok=false;
  try{ ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64urlToBytes(s), enc.encode(h+'.'+p)); }
  catch(e){ return null; }
  if(!ok) return null;
  let payload; try{ payload = JSON.parse(dec.decode(b64urlToBytes(p))); }catch(e){ return null; }
  if(payload && payload.exp && Math.floor(Date.now()/1000) > payload.exp) return null;
  return payload;
}

const rank = r => r==='owner'?3 : r==='editor'?2 : r==='viewer'?1 : 0;

// PURE decision. Inputs are already-resolved state (no I/O):
//   acl         : the stored ACL object or undefined/null (unclaimed/legacy)
//   editToken   : the stored legacy capability token or undefined
//   identity    : { sub, login } from a verified JWT, or null
//   tokenHeader : the X-Edit-Token request header value (string)
//   need        : 'read' | 'write' | 'admin'
// Returns { ok, status?, role, claim? } where claim=true means "establish ownership".
export function authorizeRequest({ acl, editToken, identity, tokenHeader, need, allowClaim = true }){
  const linkAccess = (acl && acl.linkAccess != null) ? acl.linkAccess : (editToken ? 'edit' : 'none');
  let role = null;
  if(identity && acl){
    if(String(acl.ownerId) === identity.sub) role = 'owner';
    else if(acl.members && acl.members[identity.sub]) role = acl.members[identity.sub].role || null;
  }
  const tokenOk = !!(editToken && tokenHeader && tokenHeader === editToken);
  const unauthStatus = identity ? 403 : 401;

  if(need === 'admin'){
    if(role === 'owner') return { ok:true, role:'owner' };
    if(identity && !acl && allowClaim) return { ok:true, role:'owner', claim:true };   // first authed user claims & administers
    return { ok:false, status: unauthStatus };
  }

  if(need === 'write'){
    if(acl){
      if(rank(role) >= 2) return { ok:true, role };
      if(linkAccess === 'edit' && (identity || tokenOk)) return { ok:true, role:'link-editor' };  // anonymous-allowed (legacy)
      if(linkAccess === 'edit-auth' && identity) return { ok:true, role:'link-editor' };          // sign-in required
      return { ok:false, status: unauthStatus };
    }
    // No ACL yet (legacy / unclaimed):
    if(identity && allowClaim) return { ok:true, role:'owner', claim:true };  // first authed PUBLISH becomes owner
    if(tokenOk)  return { ok:true, role:'link-editor' };                       // legacy: matching token edits
    if(!editToken && allowClaim) return { ok:true, role:'link-editor', claimToken:true }; // very first PUT claims the token
    return { ok:false, status: unauthStatus };
  }

  // need === 'read'
  if(!acl) return { ok:true, role:'open-legacy' };                       // pre-ACL maps: GET was open to anyone with the id
  if(rank(role) >= 1) return { ok:true, role };
  if(linkAccess === 'view' || linkAccess === 'edit') return { ok:true, role:'link-viewer' };          // anonymous-allowed
  if((linkAccess === 'view-auth' || linkAccess === 'edit-auth') && identity) return { ok:true, role:'link-viewer' };  // sign-in required
  return { ok:false, status: unauthStatus };
}
