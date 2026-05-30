/* ============================================================
   MindSpark — pluggable storage.
   - ServerStore: when running with `node server.js` locally (SQLite)
   - CloudStore : when deployed as static files (GitHub Pages, CF Pages,
                  Netlify, etc.). User logs in with a GitHub PAT and we
                  store each map as a JSON file inside their own private
                  `mindspark-maps` repo. No backend required.
   `initStore()` probes /healthz, then picks one.
   ============================================================ */
const ServerStore = {
  async _j(url,opt){ const r=await fetch(url,opt); if(!r.ok) throw new Error(r.status); return r.status===204?null:r.json(); },
  async list(){ try{ return await this._j('/api/maps'); }catch(e){ return []; } },
  async get(id){ try{ return await this._j('/api/maps/'+id); }catch(e){ return null; } },
  async save(map){
    map.updated=Date.now();
    try{ await this._j('/api/maps/'+map.id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(map)}); }
    catch(e){ await this._j('/api/maps',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(map)}); }
  },
  async remove(id){ try{ await this._j('/api/maps/'+id,{method:'DELETE'}); }catch(e){} }
};

const CloudStore = {
  token:null, user:null, repo:'mindspark-maps',
  shas:{}, indexSha:null, index:[],

  _headers(t=this.token){ return {Authorization:`token ${t}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}; },
  // Base64 helpers safe for UTF-8 (atob/btoa are Latin-1 only)
  _encode(s){ return btoa(unescape(encodeURIComponent(s))); },
  _decode(s){ return decodeURIComponent(escape(atob(s.replace(/\n/g,'')))); },

  async _verify(t){
    const r=await fetch('https://api.github.com/user',{headers:this._headers(t)});
    if(!r.ok) throw new Error('Invalid GitHub token (HTTP '+r.status+')');
    return r.json();
  },
  async tryInit(){
    const t=localStorage.getItem('mindspark:gh:token');
    if(!t) return false;
    try{
      this.user=await this._verify(t);
      this.token=t;
      await this._ensureRepo();
      await this._loadIndex();
      return true;
    }catch(e){
      console.warn('Stored GitHub token rejected:', e.message);
      localStorage.removeItem('mindspark:gh:token');
      return false;
    }
  },
  async login(token){
    this.user=await this._verify(token);
    this.token=token;
    localStorage.setItem('mindspark:gh:token', token);
    await this._ensureRepo();
    await this._loadIndex();
    return this.user;
  },
  logout(){
    this.token=null; this.user=null;
    this.shas={}; this.indexSha=null; this.index=[];
    localStorage.removeItem('mindspark:gh:token');
  },
  async _ensureRepo(){
    const r=await fetch(`https://api.github.com/repos/${this.user.login}/${this.repo}`,{headers:this._headers()});
    if(r.status===404){
      const cr=await fetch('https://api.github.com/user/repos',{
        method:'POST',
        headers:{...this._headers(),'Content-Type':'application/json'},
        body:JSON.stringify({name:this.repo,description:'My MindSpark mind maps',private:true,auto_init:true})
      });
      if(!cr.ok){ const t=await cr.text(); throw new Error('Could not create '+this.repo+' (HTTP '+cr.status+'). Token may lack `repo` scope. '+t.slice(0,140)); }
      await new Promise(res=>setTimeout(res,800));
    } else if(!r.ok){
      throw new Error('Could not access repo (HTTP '+r.status+')');
    }
  },
  async _loadIndex(){
    const r=await fetch(`https://api.github.com/repos/${this.user.login}/${this.repo}/contents/_index.json`,{headers:this._headers()});
    if(r.status===404){ this.index=[]; this.indexSha=null; return; }
    if(!r.ok) throw new Error('Could not load index (HTTP '+r.status+')');
    const data=await r.json();
    this.indexSha=data.sha;
    try{ this.index=JSON.parse(this._decode(data.content)); }catch(e){ this.index=[]; }
  },
  async _writeFile(path, content, sha){
    const body={message:`MindSpark: update ${path}`, content:this._encode(content)};
    if(sha) body.sha=sha;
    const r=await fetch(`https://api.github.com/repos/${this.user.login}/${this.repo}/contents/${path}`,{
      method:'PUT', headers:{...this._headers(),'Content-Type':'application/json'},
      body:JSON.stringify(body)
    });
    if(!r.ok){
      // If we got a 409 sha conflict, try once more after refreshing the sha
      if(r.status===409 || r.status===422){
        const gh=await fetch(`https://api.github.com/repos/${this.user.login}/${this.repo}/contents/${path}`,{headers:this._headers()});
        if(gh.ok){
          const d=await gh.json();
          body.sha=d.sha;
          const retry=await fetch(`https://api.github.com/repos/${this.user.login}/${this.repo}/contents/${path}`,{
            method:'PUT', headers:{...this._headers(),'Content-Type':'application/json'},
            body:JSON.stringify(body)
          });
          if(retry.ok){ const dat=await retry.json(); return dat.content.sha; }
        }
      }
      const t=await r.text();
      throw new Error('Write '+path+' failed (HTTP '+r.status+') '+t.slice(0,140));
    }
    const data=await r.json();
    return data.content.sha;
  },
  async _deleteFile(path, sha){
    const r=await fetch(`https://api.github.com/repos/${this.user.login}/${this.repo}/contents/${path}`,{
      method:'DELETE', headers:{...this._headers(),'Content-Type':'application/json'},
      body:JSON.stringify({message:`MindSpark: delete ${path}`, sha})
    });
    if(!r.ok) throw new Error('Delete '+path+' failed (HTTP '+r.status+')');
  },
  async _saveIndex(){
    this.indexSha=await this._writeFile('_index.json', JSON.stringify(this.index, null, 2), this.indexSha);
  },
  // public API matching ServerStore
  async list(){ return this.index.slice(); },
  async get(id){
    try{
      const r=await fetch(`https://api.github.com/repos/${this.user.login}/${this.repo}/contents/maps/${id}.json`,{headers:this._headers()});
      if(r.status===404) return null;
      if(!r.ok) throw new Error('Could not load map (HTTP '+r.status+')');
      const data=await r.json();
      this.shas[id]=data.sha;
      return JSON.parse(this._decode(data.content));
    }catch(e){ console.warn('CloudStore.get', e); return null; }
  },
  async save(map){
    map.updated=Date.now();
    this.shas[map.id]=await this._writeFile(`maps/${map.id}.json`, JSON.stringify(map, null, 2), this.shas[map.id]);
    const entry={id:map.id, title:map.title, color:map.color, updated:map.updated};
    const i=this.index.findIndex(m=>m.id===map.id);
    if(i>=0) this.index[i]=entry; else this.index.unshift(entry);
    this.index.sort((a,b)=>b.updated-a.updated);
    await this._saveIndex();
  },
  async remove(id){
    const sha=this.shas[id];
    if(sha){ try{ await this._deleteFile(`maps/${id}.json`, sha); }catch(e){ console.warn(e); } }
    delete this.shas[id];
    this.index=this.index.filter(m=>m.id!==id);
    await this._saveIndex();
  }
};

let Store;
let MODE = 'unknown';
async function initStore(){
  try{
    const r=await fetch('/healthz', {cache:'no-store'});
    if(r.ok){ Store=ServerStore; MODE='server'; return {mode:'server', loggedIn:true}; }
  }catch(e){}
  Store=CloudStore; MODE='cloud';
  const loggedIn=await CloudStore.tryInit();
  return {mode:'cloud', loggedIn};
}

/* ---------- helpers ---------- */
const $=s=>document.querySelector(s);
const uid=()=>Math.random().toString(36).slice(2,9);
const NODE_COLORS=['#ffffff','#ffe2d6','#ffedc2','#dcefce','#cfe9e6','#d8e0fb','#efd9f2','#e9e2d6'];
const PALETTE=['#e0613a','#2f6f6a','#c98a1a','#5a7d3a','#3a6ea5','#9b4f96','#8a8175'];

/* ---------- app state ---------- */
let map=null;                 // current map {id,title,color,rootId,nodes:{}}
let view={x:80,y:0,k:1};      // pan/zoom
let sel=null;                 // selected node id
let history=[],hpos=-1;       // undo stack
let saveTimer=null;

const viewport=$('#viewport'), edges=$('#edges'), stage=$('#stage');

/* ============================================================
   RENDER
   ============================================================ */
function applyView(){
  viewport.style.transform=`translate(${view.x}px,${view.y}px) scale(${view.k})`;
  $('#zoomVal').textContent=Math.round(view.k*100)+'%';
}
function clearNodes(){ document.querySelectorAll('.node').forEach(n=>n.remove()); }

function render(){
  clearNodes(); edges.innerHTML='';
  if(!map){ $('#empty').style.display='grid'; return; }
  $('#empty').style.display='none';
  viewport.dataset.style = map.style || 'modern';
  viewport.dataset.layout = map.layout || 'balanced';
  const hidden=hiddenSet();
  // nodes
  for(const id in map.nodes){
    if(hidden.has(id)) continue;
    const n=map.nodes[id];
    const hasKids=childrenOf(id).length>0;
    const el=document.createElement('div');
    el.className='node'+(id===map.rootId?' root':'')+(id===sel?' sel':'')+(hasKids&&n.collapsed?' collapsed':'')+(n.side==='left'?' left':'');
    el.dataset.id=id;
    el.style.left=n.x+'px'; el.style.top=n.y+'px';
    if(id===map.rootId){
      el.style.background = colorFor(map.color||'#e0613a');
      el.style.color = '#fff';
    } else if(n.color && n.color!=='#fff' && n.color!=='#ffffff'){
      // User-picked card colour — always pair with dark text for legibility
      el.style.background = n.color;
      el.style.color = '#23201b';
    } else {
      // No explicit colour — let CSS theme variables handle it
      el.style.background = '';
      el.style.color = '';
    }
    // Manual width/height (when the user has resized the node)
    if(n.width){ el.style.width=n.width+'px'; el.style.maxWidth='none'; }
    if(n.height){ el.style.height=n.height+'px'; }
    // Text lives in its own span so contentEditable doesn't tangle with the handles
    const t=document.createElement('span'); t.className='node-text';
    renderNodeText(t, n.text||'', n.listType);
    // Per-node styling
    if(n.fontSize) t.style.fontSize=n.fontSize+'px';
    if(n.bold) t.style.fontWeight='700';
    if(n.italic) t.style.fontStyle='italic';
    const decos=[]; if(n.underline) decos.push('underline'); if(n.strike) decos.push('line-through');
    if(decos.length) t.style.textDecoration=decos.join(' ');
    if(n.textColor) t.style.color=n.textColor;
    if(n.highlight){ t.style.background=n.highlight; t.style.padding='0 4px'; t.style.borderRadius='3px'; t.style.boxDecorationBreak='clone'; t.style.webkitBoxDecorationBreak='clone'; }
    // Text alignment
    if(n.align && n.align!=='center'){
      t.style.textAlign=n.align;
      el.style.justifyContent = (n.align==='left') ? 'flex-start' : (n.align==='right') ? 'flex-end' : 'center';
    }
    if(n.listType) t.classList.add('node-text-list','list-'+n.listType);
    el.appendChild(t);

    // ---- Quick-action handles (appear on hover; collapse stays visible) ----
    const mkHandle=(cls,label,title,onClick)=>{
      const h=document.createElement('span');
      h.className='handle '+cls; h.textContent=label; h.title=title;
      h.addEventListener('mousedown',ev=>ev.stopPropagation());
      h.addEventListener('click',ev=>{ ev.stopPropagation(); onClick(); });
      return h;
    };

    // Collapse / expand toggle — only on nodes with children
    if(hasKids){
      el.appendChild(mkHandle(
        'h-collapse'+(n.collapsed?' collapsed':''),
        n.collapsed?'+':'−',
        n.collapsed?`Expand (${countDesc(id)} hidden)`:'Collapse',
        ()=>{ n.collapsed=!n.collapsed; pushHistory(); autoLayout(); }
      ));
    }
    // Add child — every node
    el.appendChild(mkHandle('h-child','+','Add child topic',()=>addNode(id,false)));
    // Add sibling — every non-root node
    if(id!==map.rootId){
      el.appendChild(mkHandle('h-sibling','+','Add sibling topic',()=>addNode(id,true)));
    }
    // Resize grip — drag from the bottom-right corner to resize the node
    const grip=document.createElement('span');
    grip.className='resize-grip'; grip.title='Drag to resize';
    grip.addEventListener('mousedown',ev=>{ ev.stopPropagation(); ev.preventDefault(); startResize(id,ev); });
    el.appendChild(grip);
    // Notes indicator — visible only if a non-empty note exists
    const noteText = (n.notes||'').replace(/<[^>]*>/g,'').trim();
    if(noteText){
      const nm=document.createElement('span');
      nm.className='notes-mark';
      nm.textContent='📝';
      nm.title=noteText.length>120 ? noteText.slice(0,120)+'…' : noteText;
      nm.addEventListener('mousedown',ev=>ev.stopPropagation());
      nm.addEventListener('click',ev=>{ ev.stopPropagation(); showNotesEditor(id); });
      el.appendChild(nm);
    }
    viewport.appendChild(el);
    // measure & store size for layout/edges
    const r=el.getBoundingClientRect();
    n.w=r.width/view.k; n.h=r.height/view.k;
  }
  drawEdges(hidden);
  positionNodeBar();
}

// Render text inside a node, turning http(s)://… URLs into clickable links.
const URL_RE = /(https?:\/\/[^\s<>"'`)]+)/g;
function appendTextWithLinks(container, text){
  let last=0, m;
  URL_RE.lastIndex=0;
  while((m=URL_RE.exec(text))!==null){
    if(m.index>last) container.appendChild(document.createTextNode(text.slice(last,m.index)));
    const a=document.createElement('a');
    a.href=m[0]; a.target='_blank'; a.rel='noopener noreferrer';
    a.textContent=m[0]; a.className='node-link';
    a.addEventListener('mousedown',e=>e.stopPropagation());
    a.addEventListener('click',e=>{
      e.stopPropagation();
      if(container.isContentEditable || container.closest('.node.editing')) e.preventDefault();
    });
    container.appendChild(a);
    last=m.index+m[0].length;
  }
  if(last<text.length) container.appendChild(document.createTextNode(text.slice(last)));
}
function renderNodeText(container, text, listType){
  container.textContent='';
  if(!listType){ appendTextWithLinks(container, text); return; }
  // List mode: split on newlines, prefix each line with a bullet or number
  const lines = text.split('\n');
  lines.forEach((line, i)=>{
    if(i>0) container.appendChild(document.createElement('br'));
    const prefix = document.createElement('span');
    prefix.className='list-marker';
    prefix.textContent = listType==='ol' ? `${i+1}.\u00A0` : '•\u00A0';
    container.appendChild(prefix);
    appendTextWithLinks(container, line);
  });
}

function colorFor(hex){ // root gradient
  return `linear-gradient(135deg, ${hex}, ${shade(hex,-22)})`;
}
function shade(hex,amt){
  const n=parseInt(hex.slice(1),16);
  let r=(n>>16)+amt,g=((n>>8)&255)+amt,b=(n&255)+amt;
  r=Math.max(0,Math.min(255,r));g=Math.max(0,Math.min(255,g));b=Math.max(0,Math.min(255,b));
  return '#'+((r<<16)|(g<<8)|b).toString(16).padStart(6,'0');
}
function drawEdges(hidden){
  const style=map.style||'modern';
  const layout=map.layout||'balanced';
  let path='';
  for(const id in map.nodes){
    const n=map.nodes[id]; if(!n.parent||hidden.has(id)||hidden.has(n.parent)) continue;
    const p=map.nodes[n.parent]; if(!p) continue;
    // Choose attach points based on layout orientation
    let x1,y1,x2,y2,horizontal=true,leftSide=(n.side==='left');
    if(layout==='down'){
      horizontal=false;
      x1=p.x+(p.w||0)/2; y1=p.y+(p.h||0);
      x2=n.x+(n.w||0)/2; y2=n.y;
    } else {
      x1=leftSide ? p.x : p.x+(p.w||0);
      y1=p.y+(p.h||0)/2;
      x2=leftSide ? n.x+(n.w||0) : n.x;
      y2=n.y+(n.h||0)/2;
    }
    path += edgePath(x1,y1,x2,y2,leftSide,horizontal,style)+' ';
  }
  edges.innerHTML=`<path d="${path}" fill="none" stroke="var(--edge-color, var(--line-2))" stroke-width="var(--edge-width, 2.2)" stroke-linecap="round"/>`;
}
function edgePath(x1,y1,x2,y2,leftSide,horizontal,style){
  switch(style){
    case 'classic': {                                   // step / right-angle elbow
      if(horizontal){
        const mid=(x1+x2)/2;
        return `M${x1},${y1} L${mid},${y1} L${mid},${y2} L${x2},${y2}`;
      } else {
        const mid=(y1+y2)/2;
        return `M${x1},${y1} L${x1},${mid} L${x2},${mid} L${x2},${y2}`;
      }
    }
    case 'sketch': return `M${x1},${y1} L${x2},${y2}`;  // straight line
    case 'bubble':                                       // same path as modern but CSS makes it thicker
    case 'modern':
    default: {                                           // smooth bezier
      if(horizontal){
        const dx=Math.abs(x2-x1)*0.5;
        return `M${x1},${y1} C${x1+(leftSide?-dx:dx)},${y1} ${x2+(leftSide?dx:-dx)},${y2} ${x2},${y2}`;
      } else {
        const dy=Math.abs(y2-y1)*0.5;
        return `M${x1},${y1} C${x1},${y1+dy} ${x2},${y2-dy} ${x2},${y2}`;
      }
    }
  }
}

/* ---------- tree helpers ---------- */
const childrenOf=id=>Object.values(map.nodes).filter(n=>n.parent===id).map(n=>n.id);
function countDesc(id){let c=0;const walk=i=>childrenOf(i).forEach(k=>{c++;walk(k)});walk(id);return c;}
function hiddenSet(){
  const h=new Set();
  const walk=(id, hide)=>{
    // If this node is collapsed (or we're already under a collapsed ancestor),
    // hide all its descendants — starting with its direct children.
    const newHide = hide || !!map.nodes[id]?.collapsed;
    childrenOf(id).forEach(c=>{
      if(newHide) h.add(c);
      walk(c, newHide);
    });
  };
  walk(map.rootId,false);
  return h;
}

/* ============================================================
   LAYOUT — tidy tree, supports balanced / right / down
   ============================================================ */
const HGAP=70, VGAP=22, DOWN_HGAP=38, DOWN_VGAP=70;
function autoLayout(){
  if(!map) return;
  // ensure sizes
  render();
  const root=map.nodes[map.rootId];
  root.side='root';
  const layout = map.layout || 'balanced';

  // ----- TOP-DOWN (org-chart) layout -----
  if(layout==='down'){
    const widthOf = id => {
      const n=map.nodes[id]; const cs=childrenOf(id);
      if(!cs.length||n.collapsed) return n.w||120;
      let s=0; cs.forEach((c,i)=>{ s+=widthOf(c)+(i?DOWN_HGAP:0); });
      return Math.max(n.w||120, s);
    };
    const place = (id, leftX, topY) => {
      const n=map.nodes[id];
      const tw=widthOf(id);
      n.x = leftX + (tw - (n.w||120))/2;
      n.y = topY;
      const cs=childrenOf(id); if(!cs.length||n.collapsed) return;
      let cx=leftX;
      const childY = topY + (n.h||40) + DOWN_VGAP;
      cs.forEach(c=>{ const cw=widthOf(c); place(c, cx, childY); cx += cw + DOWN_HGAP; });
    };
    const assign = id => { map.nodes[id].side='down'; childrenOf(id).forEach(assign); };
    childrenOf(map.rootId).forEach(assign);
    place(map.rootId, 0, 0);
    render(); scheduleSave(); return;
  }

  const kids=childrenOf(map.rootId);
  // ----- RIGHT-ONLY: all root children go to the right -----
  let leftSet=[], rightSet=[];
  if(layout==='right'){
    rightSet = kids.slice();
  } else {
    // BALANCED: split children by subtree weight, left vs right
    const weights=kids.map(k=>({k,w:countDesc(k)+1}));
    let L=0,R=0;
    weights.sort((a,b)=>b.w-a.w).forEach(o=>{ if(R<=L){rightSet.push(o.k);R+=o.w}else{leftSet.push(o.k);L+=o.w} });
  }
  const assign=(id,side)=>{ map.nodes[id].side=side; childrenOf(id).forEach(c=>assign(c,side)); };
  rightSet.forEach(k=>assign(k,'right')); leftSet.forEach(k=>assign(k,'left'));

  // subtree height in px
  const heightOf=id=>{
    const n=map.nodes[id]; const cs=childrenOf(id);
    if(!cs.length||n.collapsed) return n.h||40;
    let s=0; cs.forEach((c,i)=>{ s+=heightOf(c)+(i?VGAP:0); });
    return Math.max(n.h||40, s);
  };
  // place a side
  const place=(id,x,topY,dir)=>{
    const n=map.nodes[id];
    const th=heightOf(id);
    n.x=x; n.y=topY+(th-(n.h||40))/2;
    const cs=childrenOf(id);
    if(!cs.length||n.collapsed) return;
    let cy=topY;
    cs.forEach(c=>{
      const ch=heightOf(c);
      const cx = dir>0 ? n.x+(n.w||120)+HGAP : n.x-((map.nodes[c].w)||120)-HGAP;
      place(c,cx,cy,dir);
      cy+=ch+VGAP;
    });
  };
  // root centered
  root.x=0; root.y=0;
  const rootMid=(root.h||50)/2;
  let rTop=-(rightSet.reduce((s,k,i)=>s+heightOf(k)+(i?VGAP:0),0))/2 + rootMid;
  rightSet.forEach(k=>{ const h=heightOf(k); place(k, root.x+(root.w||120)+HGAP, rTop, 1); rTop+=h+VGAP; });
  let lTop=-(leftSet.reduce((s,k,i)=>s+heightOf(k)+(i?VGAP:0),0))/2 + rootMid;
  leftSet.forEach(k=>{ const h=heightOf(k); const w=map.nodes[k].w||120; place(k, root.x-w-HGAP, lTop, -1); lTop+=h+VGAP; });

  render(); scheduleSave();
}

/* ============================================================
   NODE OPERATIONS
   ============================================================ */
function pushHistory(){
  history=history.slice(0,hpos+1);
  history.push(JSON.stringify({nodes:map.nodes,rootId:map.rootId,title:map.title,color:map.color}));
  if(history.length>60) history.shift();
  hpos=history.length-1;
  updateUndo();
  scheduleSave();                              // any change to history persists
}
function updateUndo(){ $('#undo').disabled=hpos<=0; $('#redo').disabled=hpos>=history.length-1; }
function restore(s){ const o=JSON.parse(s); map.nodes=o.nodes; map.rootId=o.rootId; map.title=o.title; map.color=o.color; $('#mapTitle').value=map.title; render(); scheduleSave(); }
function undo(){ if(hpos>0){hpos--;restore(history[hpos]);updateUndo();} }
function redo(){ if(hpos<history.length-1){hpos++;restore(history[hpos]);updateUndo();} }

function addNode(parentId,asSibling){
  let parent=parentId;
  if(asSibling){ const p=map.nodes[parentId]; parent=p.parent||map.rootId; if(parentId===map.rootId) parent=map.rootId; }
  const pn=map.nodes[parent]||map.nodes[map.rootId];
  const side = parent===map.rootId ? (childrenOf(map.rootId).length%2? 'left':'right') : (pn.side||'right');
  const id=uid();
  // Pick a random soft color from the palette (skip plain white at index 0)
  const palette=NODE_COLORS.slice(1);
  const color=palette[Math.floor(Math.random()*palette.length)];
  map.nodes[id]={id,text:'New topic',parent,
    x:pn.x+(side==='left'?-180:180),y:pn.y+40,side, color};
  if(pn.collapsed) pn.collapsed=false;
  pushHistory(); autoLayout(); select(id,true);
}
function deleteNode(id){
  if(id===map.rootId) return;
  const rm=[id]; const walk=i=>childrenOf(i).forEach(c=>{rm.push(c);walk(c)}); walk(id);
  const parent=map.nodes[id].parent;
  rm.forEach(r=>delete map.nodes[r]);
  pushHistory(); sel=parent; autoLayout();
}
function select(id,edit){
  // Toggle .sel class on existing elements rather than re-rendering — so the
  // DOM element identity is preserved across clicks (required for dblclick).
  document.querySelectorAll('.node.sel').forEach(n=>n.classList.remove('sel'));
  sel=id;
  if(id){
    const el=document.querySelector(`.node[data-id="${id}"]`);
    if(el) el.classList.add('sel');
  }
  positionNodeBar();
  if(edit) setTimeout(()=>startEdit(id),0);
}

/* ---------- inline editing ---------- */
function startEdit(id){
  const el=document.querySelector(`.node[data-id="${id}"]`); if(!el) return;
  const textEl=el.querySelector('.node-text')||el;
  // Strip any link rendering so the user edits the raw text
  textEl.textContent = (map.nodes[id]?.text||'');
  el.classList.add('editing');
  textEl.contentEditable='true';
  $('#nodebar')?.remove();
  textEl.focus();
  // select all text so typing replaces it
  const range=document.createRange(); range.selectNodeContents(textEl);
  const s=getSelection(); s.removeAllRanges(); s.addRange(range);
  const finish=(commit)=>{
    textEl.contentEditable='false'; el.classList.remove('editing');
    textEl.removeEventListener('blur',onBlur); textEl.removeEventListener('keydown',onKey);
    if(commit){
      const newText=textEl.textContent.trim()||'Untitled';
      map.nodes[id].text=newText;
      // If this is the root and the user hasn't manually renamed the map,
      // mirror the root's text to the map title.
      if(id===map.rootId && map.titleAuto===true){
        map.title=newText;
        $('#mapTitle').value=newText;
        refreshList();
      }
      pushHistory();
    }
    autoLayout();
  };
  const onBlur=()=>finish(true);
  const onKey=e=>{
    e.stopPropagation();
    if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();finish(true);textEl.blur();}
    if(e.key==='Escape'){e.preventDefault();textEl.textContent=map.nodes[id].text;finish(false);textEl.blur();}
  };
  textEl.addEventListener('blur',onBlur); textEl.addEventListener('keydown',onKey);
}

/* ---------- node context toolbar ---------- */
const FONT_SIZES = [12,14,15,16,18,20,24,28,32];
const TEXT_COLORS = ['#23201b','#5b5447','#b8451f','#c98a1a','#5a7d3a','#2f6f6a','#3a6ea5','#9b4f96'];
const HILITES = ['#fff59d','#ffcdd2','#c8e6c9','#b3e5fc','#e1bee7','#ffe0b2'];
let activePicker = null;

function showPicker(anchor, kind, current, onPick){
  // Toggle off if the same anchor's picker is already open
  if(activePicker && activePicker._anchor===anchor){
    activePicker.remove(); activePicker=null; return;
  }
  if(activePicker){ activePicker.remove(); activePicker=null; }
  const p=document.createElement('div');
  p.className='picker '+kind; p._anchor=anchor;
  if(kind==='size'){
    p.innerHTML=FONT_SIZES.map(s=>
      `<button data-v="${s}" class="${s==current?'on':''}">${s}</button>`).join('');
  }else if(kind==='align'){
    const opts=[
      {v:'left',  ic:'⫷', t:'Align left'},
      {v:'center',ic:'≡', t:'Align centre'},
      {v:'right', ic:'⫸', t:'Align right'}
    ];
    p.innerHTML=opts.map(o=>
      `<button data-v="${o.v}" class="${o.v===current?'on':''}" title="${o.t}"><span class="align-icon align-${o.v}">${o.ic}</span></button>`).join('');
  }else{
    const list = kind==='text' ? TEXT_COLORS : HILITES;
    const label = kind==='text' ? 'Default' : 'None';
    p.innerHTML =
      `<button class="p-default" data-v="">${label}</button>`+
      list.map(c=>`<button class="p-sw ${c==current?'on':''}" data-v="${c}" style="background:${c}" title="${c}"></button>`).join('');
  }
  const r=anchor.getBoundingClientRect();
  p.style.position='fixed';
  p.style.left=r.left+'px';
  p.style.top=(r.bottom+6)+'px';
  document.body.appendChild(p);
  activePicker=p;
  p.addEventListener('mousedown',e=>e.stopPropagation());
  p.querySelectorAll('button').forEach(b=>{
    b.addEventListener('click',e=>{
      e.stopPropagation();
      const v=b.dataset.v;
      onPick(kind==='size' ? parseInt(v) : (v||null));
      p.remove(); if(activePicker===p) activePicker=null;
    });
  });
}
// global click closes any open picker
document.addEventListener('click',e=>{
  if(activePicker && !activePicker.contains(e.target) && !e.target.closest('.fmt-btn')){
    activePicker.remove(); activePicker=null;
  }
});

function positionNodeBar(){
  $('#nodebar')?.remove();
  if(activePicker){ activePicker.remove(); activePicker=null; }
  if(!sel||!map.nodes[sel]) return;
  const el=document.querySelector(`.node[data-id="${sel}"]`); if(!el) return;
  const n=map.nodes[sel];
  const isRoot=sel===map.rootId;
  const hasKids=childrenOf(sel).length>0;
  const fs = n.fontSize || (isRoot?19:15);
  const tc = n.textColor || (isRoot?'#ffffff':'#23201b');
  const hl = n.highlight || 'transparent';

  const bar=document.createElement('div'); bar.className='nodebar'; bar.id='nodebar';
  bar.style.left=(n.x+(n.w||0)/2)+'px';
  bar.style.top=(n.y+(n.h||40)+10)+'px';
  bar.style.transform='translateX(-50%)';
  bar.innerHTML=`
    <div class="nb-group">
      <button data-a="child" title="Add child (Tab)">＋</button>
      ${!isRoot?'<button data-a="sibling" title="Add sibling (Enter)">⤵</button>':''}
      ${hasKids?`<button data-a="collapse" title="Collapse/expand (Space)">${n.collapsed?'⊕':'⊖'}</button>`:''}
      <button data-a="edit" title="Edit (F2)">✎</button>
      <button data-a="notes" class="${(n.notes||'').trim()?'on':''}" title="${(n.notes||'').trim()?'Edit notes':'Add notes'}">📝</button>
      ${!isRoot?'<button data-a="del" title="Delete (Del)">🗑</button>':''}
    </div>
    <div class="nb-div"></div>
    <div class="nb-group">
      <button data-a="size" class="fmt-btn size-btn" title="Font size"><span>${fs}</span><span class="caret">▾</span></button>
      <button data-a="bold" class="${n.bold?'on':''}" title="Bold"><b>B</b></button>
      <button data-a="italic" class="${n.italic?'on':''}" title="Italic"><i>I</i></button>
      <button data-a="strike" class="${n.strike?'on':''}" title="Strikethrough"><s>S</s></button>
      <button data-a="underline" class="${n.underline?'on':''}" title="Underline"><u>U</u></button>
      <button data-a="ul" class="${n.listType==='ul'?'on':''}" title="Bullet list (use Shift+Enter for new items)">•≡</button>
      <button data-a="ol" class="${n.listType==='ol'?'on':''}" title="Numbered list (use Shift+Enter for new items)">1≡</button>
      <button data-a="align" class="fmt-btn align-btn" title="Text alignment"><span class="align-icon align-${n.align||'center'}">≡</span><span class="caret">▾</span></button>
      <button data-a="textColor" class="fmt-btn color-btn" title="Text color"><span class="A-mark" style="border-bottom:3px solid ${tc}">A</span><span class="caret">▾</span></button>
      <button data-a="highlight" class="fmt-btn color-btn" title="Highlight"><span class="A-mark" style="background:${hl};padding:0 2px;border-radius:2px">A</span><span class="caret">▾</span></button>
    </div>
    <div class="nb-div"></div>
    <span class="swatches" title="Card color">${(isRoot?PALETTE:NODE_COLORS).map(c=>`<span class="sw" data-c="${c}" style="background:${c};${c==='#ffffff'?'border-color:var(--line)':''}"></span>`).join('')}</span>`;
  viewport.appendChild(bar);
  bar.addEventListener('mousedown',e=>e.stopPropagation());

  const toggle=(prop)=>{ map.nodes[sel][prop]=!map.nodes[sel][prop]; pushHistory(); render(); };
  const toggleList=(kind)=>{ const cur=map.nodes[sel].listType; map.nodes[sel].listType = (cur===kind ? null : kind); pushHistory(); render(); };
  bar.querySelectorAll('button').forEach(b=>{
    b.onclick=(ev)=>{
      ev.stopPropagation();
      const a=b.dataset.a;
      if(a==='child') addNode(sel,false);
      else if(a==='sibling') addNode(sel,true);
      else if(a==='edit') startEdit(sel);
      else if(a==='del') deleteNode(sel);
      else if(a==='collapse'){ map.nodes[sel].collapsed=!map.nodes[sel].collapsed; pushHistory(); autoLayout(); }
      else if(a==='bold') toggle('bold');
      else if(a==='italic') toggle('italic');
      else if(a==='strike') toggle('strike');
      else if(a==='underline') toggle('underline');
      else if(a==='ul') toggleList('ul');
      else if(a==='ol') toggleList('ol');
      else if(a==='notes') showNotesEditor(sel);
      else if(a==='size') showPicker(b,'size',fs,v=>{ map.nodes[sel].fontSize=v; pushHistory(); render(); });
      else if(a==='align') showPicker(b,'align',n.align||'center',v=>{ map.nodes[sel].align=v; pushHistory(); render(); });
      else if(a==='textColor') showPicker(b,'text',n.textColor,v=>{ map.nodes[sel].textColor=v; pushHistory(); render(); });
      else if(a==='highlight') showPicker(b,'hilite',n.highlight,v=>{ map.nodes[sel].highlight=v; pushHistory(); render(); });
    };
  });
  bar.querySelectorAll('.sw').forEach(s=>s.onclick=(ev)=>{
    ev.stopPropagation();
    if(isRoot) map.color=s.dataset.c; else map.nodes[sel].color=s.dataset.c;
    pushHistory(); render();
  });
}

/* ============================================================
   INTERACTION — pan / zoom / drag
   ============================================================ */
let dragNode=null,dragStart=null,panning=false,panStart=null,moved=false;
let resizing=null;     // {id, sx, sy, sw, sh}
let dropTarget=null;   // id of node currently hovered as a reparent target

// Used by render() to attach mousedown to the resize grip
function startResize(id, ev){
  const n=map.nodes[id];
  resizing={id, sx:ev.clientX, sy:ev.clientY, sw:n.width||n.w||120, sh:n.height||n.h||40};
}
// Walks up parents; true if `id` is a descendant of `ancestorId` (or equal)
function isDescendant(id, ancestorId){
  let cur=id;
  while(cur){ if(cur===ancestorId) return true; cur=map.nodes[cur]?.parent; }
  return false;
}
// Find the node under (x,y) that's a valid drop target for the currently-dragged node.
function findDropTarget(x,y){
  if(!dragNode) return null;
  // The dragged node has pointer-events disabled during drag, so it won't be returned here.
  const els=document.elementsFromPoint(x,y);
  for(const el of els){
    const node=el.closest && el.closest('.node');
    if(node && node.dataset && node.dataset.id){
      const tid=node.dataset.id;
      if(tid===dragNode) continue;
      // Don't allow reparenting a node onto its own subtree (would create a cycle)
      if(isDescendant(tid, dragNode)) continue;
      return tid;
    }
  }
  return null;
}
function setDropTarget(id){
  if(id===dropTarget) return;
  document.querySelectorAll('.node.drop-target').forEach(n=>n.classList.remove('drop-target'));
  dropTarget=id;
  if(id){
    const el=document.querySelector(`.node[data-id="${id}"]`);
    if(el) el.classList.add('drop-target');
  }
}
// Re-parent a node and propagate the new side down its subtree
function reparent(childId, newParentId){
  if(childId===map.rootId) return;       // can't re-parent the root
  if(childId===newParentId) return;
  if(isDescendant(newParentId, childId)) return;
  const child=map.nodes[childId];
  if(!child || child.parent===newParentId) return;
  child.parent=newParentId;
  // Recompute side: root alternates left/right, otherwise inherit parent's side
  let newSide;
  if(newParentId===map.rootId){
    const others=childrenOf(map.rootId).filter(c=>c!==childId).length;
    newSide = others%2 ? 'left' : 'right';
  } else {
    newSide = map.nodes[newParentId].side || 'right';
  }
  const propagate=(id,side)=>{
    map.nodes[id].side=side;
    childrenOf(id).forEach(c=>propagate(c,side));
  };
  propagate(childId, newSide);
  // Preserve the user's manually arranged layout — just re-render with the
  // new parent relationship. The dropped node stays where the user dropped it.
  pushHistory(); render();
  toast('Re-parented to "'+(map.nodes[newParentId].text||'…')+'"');
}

stage.addEventListener('mousedown',e=>{
  // Don't intercept clicks on the chrome / overlay UI.
  if(e.target.closest('.topbar, .zoombar, .hint, .toast, .nodebar, .empty, .search-wrap, .save-pill, .tb-group, .side, .picker')) return;
  const nodeEl=e.target.closest('.node');
  if(nodeEl && !nodeEl.classList.contains('editing')){
    const id=nodeEl.dataset.id;
    select(id,false);
    dragNode=id; moved=false;
    dragStart={mx:e.clientX,my:e.clientY,nx:map.nodes[id].x,ny:map.nodes[id].y};
  } else {
    panning=true; panStart={x:e.clientX,y:e.clientY,vx:view.x,vy:view.y};
    if(sel){
      sel=null;
      document.querySelectorAll('.node.sel').forEach(n=>n.classList.remove('sel'));
      $('#nodebar')?.remove();
    }
  }
});
window.addEventListener('mousemove',e=>{
  if(resizing){
    const dx=(e.clientX-resizing.sx)/view.k, dy=(e.clientY-resizing.sy)/view.k;
    const n=map.nodes[resizing.id];
    n.width=Math.max(60, Math.round(resizing.sw+dx));
    n.height=Math.max(30, Math.round(resizing.sh+dy));
    const el=document.querySelector(`.node[data-id="${resizing.id}"]`);
    if(el){ el.style.width=n.width+'px'; el.style.maxWidth='none'; el.style.height=n.height+'px'; n.w=n.width; n.h=n.height; }
    drawEdges(hiddenSet());
    positionNodeBar();
  } else if(dragNode){
    const dx=(e.clientX-dragStart.mx)/view.k, dy=(e.clientY-dragStart.my)/view.k;
    if(Math.abs(dx)+Math.abs(dy)>2) moved=true;
    const n=map.nodes[dragNode];
    n.x=dragStart.nx+dx; n.y=dragStart.ny+dy;
    const el=document.querySelector(`.node[data-id="${dragNode}"]`);
    if(el){ el.style.left=n.x+'px'; el.style.top=n.y+'px'; }
    drawEdges(hiddenSet());
    positionNodeBar();
    // Detect a drop target under the cursor (only after a real drag has started)
    if(moved && dragNode!==map.rootId) setDropTarget(findDropTarget(e.clientX, e.clientY));
  } else if(panning){
    view.x=panStart.vx+(e.clientX-panStart.x); view.y=panStart.vy+(e.clientY-panStart.y);
    applyView();
  }
});
window.addEventListener('mouseup',()=>{
  if(resizing){ pushHistory(); resizing=null; }
  if(dragNode){
    if(dropTarget){
      reparent(dragNode, dropTarget);
    } else if(moved){
      pushHistory();
    }
    setDropTarget(null);
    dragNode=null;
  }
  panning=false;
});

/* ============================================================
   TOUCH SUPPORT — mirrors the mouse handlers, plus pinch-zoom.
   Single finger: pan the canvas, or drag a node, or tap to select.
   Two fingers: pinch to zoom.
   ============================================================ */
let pinch=null;  // {d0, k0, cx, cy} while pinch-zooming
function tPt(t){ return {clientX:t.clientX, clientY:t.clientY}; }

stage.addEventListener('touchstart', e=>{
  if(!e.touches) return;
  // Pinch starts: two fingers down anywhere on the stage
  if(e.touches.length===2){
    const a=e.touches[0], b=e.touches[1];
    const dx=b.clientX-a.clientX, dy=b.clientY-a.clientY;
    pinch={ d0:Math.hypot(dx,dy), k0:view.k, cx:(a.clientX+b.clientX)/2, cy:(a.clientY+b.clientY)/2 };
    dragNode=null; panning=false; resizing=null;
    e.preventDefault();
    return;
  }
  if(e.touches.length!==1) return;
  const t=e.touches[0];
  // Don't intercept taps on the chrome / overlay UI
  if(t.target && t.target.closest && t.target.closest('.topbar, .zoombar, .hint, .toast, .nodebar, .empty, .search-wrap, .save-pill, .tb-group, .side, .picker, .notes-popup, .donate-modal, .theme-panel, .login-overlay, .user-pill')) return;
  const nodeEl=t.target.closest?.('.node');
  if(nodeEl && !nodeEl.classList.contains('editing')){
    const id=nodeEl.dataset.id;
    select(id,false);
    dragNode=id; moved=false;
    dragStart={mx:t.clientX,my:t.clientY,nx:map.nodes[id].x,ny:map.nodes[id].y};
  } else {
    panning=true; panStart={x:t.clientX,y:t.clientY,vx:view.x,vy:view.y};
    if(sel){ sel=null; document.querySelectorAll('.node.sel').forEach(n=>n.classList.remove('sel')); $('#nodebar')?.remove(); }
  }
}, {passive:false});

window.addEventListener('touchmove', e=>{
  if(!e.touches) return;
  if(pinch && e.touches.length===2){
    const a=e.touches[0], b=e.touches[1];
    const d=Math.hypot(b.clientX-a.clientX, b.clientY-a.clientY);
    const k=Math.min(3, Math.max(0.1, pinch.k0 * (d/pinch.d0)));
    const r=stage.getBoundingClientRect();
    const px=pinch.cx-r.left, py=pinch.cy-r.top;
    const old=view.k;
    view.x = px-(px-view.x)*(k/old); view.y = py-(py-view.y)*(k/old); view.k = k;
    applyView();
    e.preventDefault(); return;
  }
  if(e.touches.length!==1) return;
  const t=e.touches[0];
  if(dragNode){
    const dx=(t.clientX-dragStart.mx)/view.k, dy=(t.clientY-dragStart.my)/view.k;
    if(Math.abs(dx)+Math.abs(dy)>2) moved=true;
    const n=map.nodes[dragNode];
    n.x=dragStart.nx+dx; n.y=dragStart.ny+dy;
    const el=document.querySelector(`.node[data-id="${dragNode}"]`);
    if(el){ el.style.left=n.x+'px'; el.style.top=n.y+'px'; }
    drawEdges(hiddenSet());
    positionNodeBar();
    if(moved && dragNode!==map.rootId) setDropTarget(findDropTarget(t.clientX, t.clientY));
    e.preventDefault();
  } else if(panning){
    view.x=panStart.vx+(t.clientX-panStart.x); view.y=panStart.vy+(t.clientY-panStart.y);
    applyView();
    e.preventDefault();
  }
}, {passive:false});

window.addEventListener('touchend', e=>{
  if(!e.touches) return;
  if(pinch && e.touches.length<2){ pinch=null; }
  if(e.touches.length>0) return;       // still touching
  if(dragNode){
    if(dropTarget){ reparent(dragNode, dropTarget); }
    else if(moved){ pushHistory(); }
    setDropTarget(null);
    dragNode=null;
  }
  panning=false;
});

// Double-tap to edit (since dblclick doesn't fire reliably on touch)
let lastTap=0, lastTapId=null;
stage.addEventListener('touchend', e=>{
  const t=e.changedTouches?.[0]; if(!t) return;
  const nodeEl=t.target.closest?.('.node');
  if(!nodeEl) { lastTap=0; return; }
  const id=nodeEl.dataset.id, now=Date.now();
  if(id===lastTapId && now-lastTap<350){ startEdit(id); lastTap=0; }
  else { lastTap=now; lastTapId=id; }
});

stage.addEventListener('wheel',e=>{
  e.preventDefault();
  const r=stage.getBoundingClientRect();
  const px=e.clientX-r.left, py=e.clientY-r.top;
  const old=view.k;
  const k=Math.min(3,Math.max(.1, view.k*(e.deltaY<0?1.12:.89)));
  view.x=px-(px-view.x)*(k/old); view.y=py-(py-view.y)*(k/old); view.k=k;
  applyView();
},{passive:false});

function zoom(f){ const r=stage.getBoundingClientRect();const px=r.width/2,py=r.height/2;const old=view.k;
  const k=Math.min(3,Math.max(.1,view.k*f));view.x=px-(px-view.x)*(k/old);view.y=py-(py-view.y)*(k/old);view.k=k;applyView();}
function setZoom(percent){
  const r=stage.getBoundingClientRect();const px=r.width/2,py=r.height/2;const old=view.k;
  const k=Math.min(3,Math.max(.1, percent/100));
  view.x=px-(px-view.x)*(k/old); view.y=py-(py-view.y)*(k/old); view.k=k; applyView();
}
function fit(){
  if(!map)return;
  const xs=[],ys=[],xe=[],ye=[];
  const hidden=hiddenSet();
  for(const id in map.nodes){ if(hidden.has(id))continue; const n=map.nodes[id];xs.push(n.x);ys.push(n.y);xe.push(n.x+(n.w||120));ye.push(n.y+(n.h||40)); }
  if(!xs.length)return;
  const minx=Math.min(...xs),miny=Math.min(...ys),maxx=Math.max(...xe),maxy=Math.max(...ye);
  const r=stage.getBoundingClientRect();
  // Snap to 100% and centre the content's bounding box
  view.k=1;
  view.x=(r.width  - (maxx-minx))/2 - minx;
  view.y=(r.height - (maxy-miny))/2 - miny;
  applyView();
}

/* ============================================================
   KEYBOARD
   ============================================================ */
// Navigate from `id` in the direction of an arrow key, respecting current layout.
function navTarget(id, key){
  if(!map||!map.nodes[id]) return null;
  const n=map.nodes[id];
  const layout=map.layout||'balanced';
  const kids=childrenOf(id);
  const parent=n.parent;
  const siblings=parent ? childrenOf(parent) : [];
  const idxInSiblings=siblings.indexOf(id);
  const firstVisible=cs=>(cs.length && !n.collapsed) ? cs[0] : null;
  const sibAt=delta=>{
    const i=idxInSiblings+delta;
    return (i>=0 && i<siblings.length) ? siblings[i] : null;
  };
  if(layout==='down'){
    if(key==='ArrowDown')  return firstVisible(kids) || sibAt(1);
    if(key==='ArrowUp')    return parent || sibAt(-1);
    if(key==='ArrowLeft')  return sibAt(-1);
    if(key==='ArrowRight') return sibAt(1);
  } else {
    const side=n.side; // 'root', 'left', 'right'
    if(key==='ArrowLeft'){
      if(id===map.rootId){
        const lk=kids.filter(k=>map.nodes[k].side==='left');
        if(lk.length && !n.collapsed) return lk[0];
      }
      if(side==='right'||side==='root') return parent;
      if(side==='left') return firstVisible(kids);
    }
    if(key==='ArrowRight'){
      if(id===map.rootId){
        const rk=kids.filter(k=>map.nodes[k].side!=='left');
        if(rk.length && !n.collapsed) return rk[0];
      }
      if(side==='left'||side==='root') return parent;
      if(side==='right') return firstVisible(kids);
    }
    if(key==='ArrowUp')   return sibAt(-1);
    if(key==='ArrowDown') return sibAt(1);
  }
  return null;
}

window.addEventListener('keydown',e=>{
  if(['INPUT','TEXTAREA'].includes(e.target.tagName)||e.target.isContentEditable||document.querySelector('.node.editing')) return;
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?redo():undo();return;}
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='y'){e.preventDefault();redo();return;}
  if(!sel||!map) return;
  if(e.key==='Tab'){e.preventDefault();addNode(sel,false);}
  else if(e.key==='Enter'){e.preventDefault();addNode(sel,true);}
  else if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();deleteNode(sel);}
  else if(e.key==='F2'){e.preventDefault();startEdit(sel);}
  else if(e.key===' '){e.preventDefault();const n=map.nodes[sel];if(childrenOf(sel).length){n.collapsed=!n.collapsed;pushHistory();autoLayout();}}
  else if(e.key==='ArrowLeft'||e.key==='ArrowRight'||e.key==='ArrowUp'||e.key==='ArrowDown'){
    e.preventDefault();
    const next=navTarget(sel, e.key);
    if(next) select(next, false);
  }
  else if(e.key.length===1&&!e.ctrlKey&&!e.metaKey){
    // Replace mode: set the text to the typed key and enter edit with cursor at end.
    e.preventDefault();
    map.nodes[sel].text=e.key;
    const tEl=document.querySelector(`.node[data-id="${sel}"] .node-text`);
    if(tEl) tEl.textContent=e.key;
    startEdit(sel);
    requestAnimationFrame(()=>{
      const t2=document.querySelector(`.node[data-id="${sel}"] .node-text`);
      if(!t2) return;
      const r=document.createRange(); r.selectNodeContents(t2); r.collapse(false);
      const s=getSelection(); s.removeAllRanges(); s.addRange(r);
    });
  }
});
stage.addEventListener('dblclick',e=>{const n=e.target.closest('.node');if(n)startEdit(n.dataset.id);});

/* ============================================================
   SEARCH
   ============================================================ */
$('#searchBtn').onclick=()=>{ const w=$('#searchWrap'); w.classList.toggle('open'); if(w.classList.contains('open'))$('#search').focus(); else {$('#search').value='';doSearch('');} };
$('#search').addEventListener('input',e=>doSearch(e.target.value));
function doSearch(q){
  q=q.trim().toLowerCase();
  document.querySelectorAll('.node').forEach(el=>{
    el.classList.remove('dim','match');
    if(!q)return;
    if((map.nodes[el.dataset.id].text||'').toLowerCase().includes(q)) el.classList.add('match');
    else el.classList.add('dim');
  });
}

/* ============================================================
   MAPS — list / create / load / delete
   ============================================================ */
async function refreshList(){
  let idx=[];
  try{ idx=await Store.list(); }catch(e){ idx=[]; }
  // Merge the current in-memory map so title edits / new maps appear immediately
  // (don't wait for the debounced save to hit the database).
  if(map){
    const local={id:map.id, title:map.title, color:map.color, updated:map.updated||Date.now()};
    const at=idx.findIndex(m=>m.id===map.id);
    if(at>=0) idx[at]={...idx[at], ...local};
    else idx.unshift(local);
    idx.sort((a,b)=>(b.updated||0)-(a.updated||0));
  }
  const list=$('#mapList'); list.innerHTML='';
  (idx||[]).forEach(m=>{
    const el=document.createElement('div');
    el.className='map-item'+(map&&m.id===map.id?' active':'');
    el.innerHTML=`<span class="dot" style="background:${m.color||'#e0613a'}"></span><span class="nm">${escapeHtml(m.title||'Untitled')}</span><button class="x" title="Delete">×</button>`;
    el.querySelector('.nm').onclick=()=>loadMap(m.id);
    el.querySelector('.dot').onclick=()=>loadMap(m.id);
    el.querySelector('.x').onclick=async ev=>{ev.stopPropagation();
      if(!confirm('Delete "'+(m.title||'Untitled')+'"?'))return;
      await Store.remove(m.id);
      if(map&&map.id===m.id){map=null;render();}
      refreshList(); toast('Map deleted');
    };
    list.appendChild(el);
  });
}
function escapeHtml(s){return (s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}

/* ---------- Rich-text Notes editor popup ---------- */
function showNotesEditor(nodeId){
  document.querySelectorAll('.notes-popup').forEach(p=>p.remove());
  if(!map||!map.nodes[nodeId]) return;
  const n=map.nodes[nodeId];
  const popup=document.createElement('div');
  popup.className='notes-popup';
  const has=(n.notes||'').replace(/<[^>]*>/g,'').trim().length>0;
  popup.innerHTML=`
    <div class="np-toolbar">
      <button data-c="bold"          title="Bold"><b>B</b></button>
      <button data-c="italic"        title="Italic"><i>i</i></button>
      <button data-c="strikeThrough" title="Strikethrough"><s>S</s></button>
      <div class="np-div"></div>
      <button data-c="h1"            title="Heading 1">H1</button>
      <button data-c="h2"            title="Heading 2">H2</button>
      <div class="np-div"></div>
      <button data-c="insertUnorderedList" title="Bullet list">•≡</button>
      <button data-c="insertOrderedList"   title="Numbered list">1≡</button>
      <div class="np-div"></div>
      <button data-c="createLink"  title="Insert link">🔗</button>
      <button data-c="unlink"      title="Remove link">⊘🔗</button>
      <button data-c="removeFormat" title="Clear formatting">⨯</button>
    </div>
    <div class="np-editor" contenteditable="true" data-placeholder="Type your notes — Markdown-style formatting available via the toolbar.">${n.notes||''}</div>
    <div class="np-actions">
      ${has?'<button class="np-clear">Remove</button>':''}
      <button class="np-cancel">Cancel</button>
      <button class="np-save primary">Save</button>
    </div>`;
  const r=stage.getBoundingClientRect();
  popup.style.left = (r.left + r.width/2 - 240) + 'px';
  popup.style.top  = (r.top  + 70) + 'px';
  document.body.appendChild(popup);
  popup.addEventListener('mousedown',e=>e.stopPropagation());
  const editor=popup.querySelector('.np-editor');
  editor.focus();
  // Place cursor at end
  const range=document.createRange(); range.selectNodeContents(editor); range.collapse(false);
  const s=getSelection(); s.removeAllRanges(); s.addRange(range);

  popup.querySelectorAll('.np-toolbar button').forEach(btn=>{
    btn.addEventListener('mousedown',e=>e.preventDefault());  // keep selection
    btn.addEventListener('click',e=>{
      e.stopPropagation();
      const c=btn.dataset.c;
      if(c==='h1'||c==='h2'){ document.execCommand('formatBlock', false, '<'+c+'>'); }
      else if(c==='createLink'){
        const url=prompt('Enter URL (https://…):'); if(url) document.execCommand('createLink',false,url);
      }
      else { document.execCommand(c, false, null); }
      editor.focus();
    });
  });

  const close=()=>popup.remove();
  const save=()=>{
    // Sanitize: strip <script>/<style>, on*= handlers — fine for self-hosted, kept defensive
    const html=editor.innerHTML
      .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi,'')
      .replace(/\son\w+\s*=\s*"[^"]*"/gi,'')
      .replace(/\son\w+\s*=\s*'[^']*'/gi,'');
    const plain=html.replace(/<[^>]*>/g,'').trim();
    if(plain) map.nodes[nodeId].notes=html; else delete map.nodes[nodeId].notes;
    pushHistory(); render(); close();
  };
  popup.querySelector('.np-save').onclick=save;
  popup.querySelector('.np-cancel').onclick=close;
  popup.querySelector('.np-clear')?.addEventListener('click',()=>{
    delete map.nodes[nodeId].notes; pushHistory(); render(); close();
  });
  editor.addEventListener('keydown',e=>{
    e.stopPropagation();
    if(e.key==='Escape'){ e.preventDefault(); close(); }
    if(e.key==='Enter' && (e.ctrlKey||e.metaKey)){ e.preventDefault(); save(); }
  });
}

function createMap(){
  const id=uid(); const rid=uid();
  const rootText='Central Idea';
  const m={id,title:rootText,titleAuto:true,color:PALETTE[Math.floor(Math.random()*PALETTE.length)],rootId:rid,
    nodes:{[rid]:{id:rid,text:rootText,parent:null,x:0,y:0,side:'root',color:'#fff'}}};
  // Show it immediately — never wait on the network to render the UI.
  map=m; sel=rid; history=[]; hpos=-1; pushHistory();
  $('#mapTitle').value=map.title;
  autoLayout();
  // Default new maps to 100% zoom, centred on the root
  view.k=1;
  const r=stage.getBoundingClientRect();
  const rn=map.nodes[rid];
  view.x = r.width/2 - (rn.x + (rn.w||120)/2);
  view.y = r.height/2 - (rn.y + (rn.h||50)/2);
  applyView();
  scheduleSave();          // persist to the database in the background
  refreshList();
  setTimeout(()=>startEdit(rid),120);
}
async function loadMap(id){
  let m=null;
  try{ m=await Store.get(id); }catch(e){ toast('Could not load map'); return false; }
  if(!m){ toast('Map not found'); return false; }
  // Legacy migration: old maps may still store `comment` — promote it to `notes`
  for(const n of Object.values(m.nodes||{})){
    if(n.comment && !n.notes){
      n.notes = '<p>'+escapeHtml(n.comment).replace(/\n/g,'<br>')+'</p>';
      delete n.comment;
    }
  }
  map=m; sel=map.rootId;
  // Initialise history WITHOUT triggering a save — loading is not a change,
  // so the sidebar order (sorted by `updated`) must not be reshuffled.
  history=[JSON.stringify({nodes:map.nodes,rootId:map.rootId,title:map.title,color:map.color})];
  hpos=0; updateUndo();
  $('#mapTitle').value=map.title;
  render(); fit(); refreshList();   // render directly (autoLayout would save)
  return true;
}

/* ---------- title ---------- */
$('#mapTitle').addEventListener('input',e=>{
  if(!map) return;
  map.title=e.target.value;
  map.titleAuto=false;          // user took control — stop mirroring the root text
  scheduleSave(); refreshList();
});

/* ---------- autosave ---------- */
function scheduleSave(){
  if(!map)return;
  $('#savePill').classList.add('saving'); $('#saveText').textContent='Saving…';
  clearTimeout(saveTimer);
  // Cloud mode talks to GitHub — debounce longer to stay well under 5000 req/h
  const delay = (MODE==='cloud') ? 1500 : 600;
  saveTimer=setTimeout(async()=>{
    try{
      await Store.save(map);
      $('#savePill').classList.remove('saving'); $('#saveText').textContent='Saved';
    }catch(e){
      $('#savePill').classList.remove('saving'); $('#saveText').textContent='Save failed';
      toast((MODE==='cloud') ? ('GitHub save failed — '+(e.message||e)) : 'Could not save to the server — is it still running?');
    }
  },delay);
}

/* ============================================================
   EXPORT  (JSON + PNG via manual canvas render)
   ============================================================ */
function exportMenu(){
  const choice=prompt('Export as:\n1 = PNG image\n2 = JSON file\n3 = Import JSON','1');
  if(choice==='1')exportPNG();
  else if(choice==='2')exportJSON();
  else if(choice==='3')importJSON();
}
function exportJSON(){
  const blob=new Blob([JSON.stringify(map,null,2)],{type:'application/json'});
  download(blob,(map.title||'mindmap')+'.json'); toast('JSON exported');
}
function importJSON(){
  const inp=document.createElement('input');inp.type='file';inp.accept='.json';
  inp.onchange=async()=>{const f=inp.files[0];if(!f)return;const t=await f.text();
    try{const m=JSON.parse(t);m.id=uid();await Store.save(m);await loadMap(m.id);refreshList();toast('Imported');}catch(e){alert('Invalid file');}};
  inp.click();
}
function exportPNG(){
  render();
  const hidden=hiddenSet(); const ids=Object.keys(map.nodes).filter(i=>!hidden.has(i));
  let minx=1e9,miny=1e9,maxx=-1e9,maxy=-1e9;
  ids.forEach(i=>{const n=map.nodes[i];minx=Math.min(minx,n.x);miny=Math.min(miny,n.y);maxx=Math.max(maxx,n.x+(n.w||120));maxy=Math.max(maxy,n.y+(n.h||40));});
  const pad=50,scale=2;
  const W=(maxx-minx+pad*2),H=(maxy-miny+pad*2);
  const cv=document.createElement('canvas');cv.width=W*scale;cv.height=H*scale;
  const ctx=cv.getContext('2d');ctx.scale(scale,scale);
  ctx.fillStyle='#f4efe6';ctx.fillRect(0,0,W,H);
  ctx.translate(-minx+pad,-miny+pad);
  // edges
  ctx.strokeStyle='#c8bda8';ctx.lineWidth=2.2;ctx.lineCap='round';
  ids.forEach(i=>{const n=map.nodes[i];if(!n.parent||hidden.has(n.parent))return;const p=map.nodes[n.parent];if(!p)return;
    const left=n.side==='left';const x1=left?p.x:p.x+(p.w||0),y1=p.y+(p.h||0)/2,x2=left?n.x+(n.w||0):n.x,y2=n.y+(n.h||0)/2;const dx=Math.abs(x2-x1)*.5;
    ctx.beginPath();ctx.moveTo(x1,y1);ctx.bezierCurveTo(x1+(left?-dx:dx),y1,x2+(left?dx:-dx),y2,x2,y2);ctx.stroke();});
  // nodes
  ids.forEach(i=>{const n=map.nodes[i];const isRoot=i===map.rootId;
    const w=n.w||120,h=n.h||40;roundRect(ctx,n.x,n.y,w,h,12);
    ctx.fillStyle=isRoot?(map.color||'#e0613a'):(n.color||'#fff');ctx.fill();
    if(!isRoot){ctx.strokeStyle='#d8cfbf';ctx.lineWidth=1.5;ctx.stroke();}
    ctx.fillStyle=isRoot?'#fff':'#23201b';ctx.font=(isRoot?'600 19px ':'500 15px ')+'"Bricolage Grotesque",sans-serif';
    ctx.textBaseline='middle';
    wrapText(ctx,n.text||'',n.x+(isRoot?22:15),n.y+h/2,w-(isRoot?44:30),20);
  });
  cv.toBlob(b=>{download(b,(map.title||'mindmap')+'.png');toast('PNG exported');});
}
function roundRect(ctx,x,y,w,h,r){ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();}
function wrapText(ctx,text,x,y,maxW,lh){const words=text.split(/\s+/);let line='',lines=[];words.forEach(w=>{const t=line?line+' '+w:w;if(ctx.measureText(t).width>maxW&&line){lines.push(line);line=w;}else line=t;});if(line)lines.push(line);const startY=y-(lines.length-1)*lh/2;lines.forEach((l,i)=>ctx.fillText(l,x,startY+i*lh));}
function download(blob,name){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}

/* ---------- toast ---------- */
let toastT;function toast(msg){const t=$('#toast');t.textContent=msg;t.classList.add('show');clearTimeout(toastT);toastT=setTimeout(()=>t.classList.remove('show'),2000);}

/* ============================================================
   WIRE UP
   ============================================================ */
$('#newMap').onclick=createMap;
$('#emptyNew').onclick=createMap;
$('#addChild').onclick=()=>{ if(!map)return; addNode(sel||map.rootId,false); };
$('#layout').onclick=autoLayout;            // re-tidies node positions (does NOT move the camera)
$('#undo').onclick=undo; $('#redo').onclick=redo;
$('#zoomIn').onclick=()=>zoom(1.15); $('#zoomOut').onclick=()=>zoom(.87); $('#zoomFit').onclick=fit;
// Click the zoom % to enter a custom value
(function(){
  const zv=$('#zoomVal');
  zv.addEventListener('click',()=>{
    zv.contentEditable='true';
    zv.textContent=Math.round(view.k*100);   // strip the % for easier editing
    zv.focus();
    const r=document.createRange(); r.selectNodeContents(zv);
    const s=getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  const apply=()=>{
    zv.contentEditable='false';
    const v=parseFloat(String(zv.textContent).replace(/[^\d.]/g,''));
    if(Number.isFinite(v) && v>=10 && v<=300) setZoom(v); else applyView();
  };
  zv.addEventListener('blur',apply);
  zv.addEventListener('keydown',e=>{
    e.stopPropagation();
    if(e.key==='Enter'){ e.preventDefault(); zv.blur(); }
    if(e.key==='Escape'){ e.preventDefault(); applyView(); zv.blur(); }
  });
})();
$('#menuExport').onclick=exportMenu;
$('#toggleSide').onclick=()=>$('#side').classList.toggle('collapsed');
$('#hintClose').onclick=()=>$('#hint').style.display='none';

/* ---------- Themes ---------- */
const THEMES = [
  {id:'light',           name:'Light',           swatch:['#f4efe6','#ffffff','#e0613a']},
  {id:'dark',            name:'Dark',            swatch:['#1e1e1e','#2d2d2d','#3794ff']},
  {id:'dracula',         name:'Dracula',         swatch:['#282a36','#44475a','#ff79c6']},
  {id:'monokai',         name:'Monokai',         swatch:['#272822','#3e3d32','#f92672']},
  {id:'nord',            name:'Nord',            swatch:['#2e3440','#434c5e','#88c0d0']},
  {id:'tokyo-night',     name:'Tokyo Night',     swatch:['#1a1b26','#24283b','#7aa2f7']},
  {id:'solarized-light', name:'Solarized Light', swatch:['#fdf6e3','#ffffff','#268bd2']},
  {id:'solarized-dark',  name:'Solarized Dark',  swatch:['#002b36','#073642','#268bd2']}
];
const MAP_STYLES = [
  {id:'modern',  name:'Modern',  desc:'Soft cards, curved branches'},
  {id:'classic', name:'Classic', desc:'Rectangles, right-angle branches'},
  {id:'bubble',  name:'Bubble',  desc:'Pill cards, thick curves'},
  {id:'sketch',  name:'Sketch',  desc:'Outlined cards, straight lines'}
];
const MAP_LAYOUTS = [
  {id:'balanced', name:'Balanced', desc:'Branches split left & right'},
  {id:'right',    name:'Right',    desc:'All branches grow right'},
  {id:'down',     name:'Down',     desc:'Org-chart, top to bottom'}
];

function applyTheme(id){
  if(id && id!=='light') document.documentElement.setAttribute('data-theme', id);
  else document.documentElement.removeAttribute('data-theme');
  try{ localStorage.setItem('mindspark:theme', id||'light'); }catch(e){}
}
function applyMapStyle(id){
  if(!map) return;
  map.style = id;
  pushHistory(); render();
}
function applyMapLayout(id){
  if(!map) return;
  map.layout = id;
  pushHistory(); autoLayout(); fit();
}

let themePanel=null;
function closeThemePanel(){ if(themePanel){ themePanel.remove(); themePanel=null; } }
function buildSwatchHTML(t){
  return `<span class="theme-thumb" style="background:${t.swatch[0]}">
            <span class="t1" style="background:${t.swatch[1]}"></span>
            <span class="t2" style="background:${t.swatch[2]}"></span>
          </span>`;
}
function buildStyleThumb(id){
  // Small SVG preview showing two nodes + the branch style
  let path;
  if(id==='classic') path='M30,30 L45,30 L45,12 L60,12 M30,30 L45,30 L45,48 L60,48';
  else if(id==='sketch') path='M30,30 L60,12 M30,30 L60,48';
  else path='M30,30 C40,30 50,12 60,12 M30,30 C40,30 50,48 60,48';
  const radius = id==='bubble'? 8 : id==='classic'? 2 : id==='sketch'? 2 : 4;
  const stroke = id==='bubble'? 2.2 : 1.4;
  return `<span class="style-thumb">
    <svg viewBox="0 0 70 60" width="70" height="40">
      <rect x="12" y="22" width="22" height="16" rx="${radius}" fill="var(--accent)"/>
      <rect x="56" y="6"  width="14" height="12" rx="${radius}" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
      <rect x="56" y="42" width="14" height="12" rx="${radius}" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
      <path d="${path}" fill="none" stroke="var(--ink-soft)" stroke-width="${stroke}"/>
    </svg>
  </span>`;
}
function buildLayoutThumb(id){
  let svg;
  if(id==='down') svg=`<svg viewBox="0 0 70 60" width="70" height="40">
    <rect x="28" y="6"  width="14" height="10" rx="2" fill="var(--accent)"/>
    <rect x="8"  y="36" width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="28" y="36" width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="48" y="36" width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <path d="M35,16 L35,26 L15,26 L15,36 M35,26 L35,36 M35,26 L55,26 L55,36" fill="none" stroke="var(--ink-soft)" stroke-width="1.2"/>
  </svg>`;
  else if(id==='right') svg=`<svg viewBox="0 0 70 60" width="70" height="40">
    <rect x="6"  y="22" width="14" height="12" rx="2" fill="var(--accent)"/>
    <rect x="48" y="6"  width="16" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="48" y="22" width="16" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="48" y="38" width="16" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <path d="M20,28 C32,28 40,11 48,11 M20,28 L48,27 M20,28 C32,28 40,43 48,43" fill="none" stroke="var(--ink-soft)" stroke-width="1.2"/>
  </svg>`;
  else svg=`<svg viewBox="0 0 70 60" width="70" height="40">
    <rect x="28" y="22" width="14" height="12" rx="2" fill="var(--accent)"/>
    <rect x="2"  y="8"  width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="2"  y="38" width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="52" y="8"  width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="52" y="38" width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <path d="M28,28 C22,28 22,13 16,13 M28,28 C22,28 22,43 16,43 M42,28 C48,28 48,13 52,13 M42,28 C48,28 48,43 52,43" fill="none" stroke="var(--ink-soft)" stroke-width="1.2"/>
  </svg>`;
  return `<span class="style-thumb">${svg}</span>`;
}

$('#themeBtn').onclick=(e)=>{
  e.stopPropagation();
  if(themePanel){ closeThemePanel(); return; }
  const curTheme  = document.documentElement.getAttribute('data-theme') || 'light';
  const curStyle  = (map && map.style)  || 'modern';
  const curLayout = (map && map.layout) || 'balanced';
  themePanel=document.createElement('div');
  themePanel.className='theme-panel theme-panel-large';
  themePanel.innerHTML = `
    <div class="tp-section">
      <div class="tp-label">Colour theme</div>
      <div class="tp-grid">
        ${THEMES.map(t=>`
          <button class="theme-opt${t.id===curTheme?' active':''}" data-cat="theme" data-id="${t.id}">
            ${buildSwatchHTML(t)}<span class="theme-name">${t.name}</span>
          </button>`).join('')}
      </div>
    </div>
    <div class="tp-section">
      <div class="tp-label">Map style</div>
      <div class="tp-grid">
        ${MAP_STYLES.map(s=>`
          <button class="theme-opt${s.id===curStyle?' active':''}" data-cat="style" data-id="${s.id}" title="${s.desc}">
            ${buildStyleThumb(s.id)}<span class="theme-name">${s.name}</span>
          </button>`).join('')}
      </div>
    </div>
    <div class="tp-section">
      <div class="tp-label">Layout</div>
      <div class="tp-grid">
        ${MAP_LAYOUTS.map(l=>`
          <button class="theme-opt${l.id===curLayout?' active':''}" data-cat="layout" data-id="${l.id}" title="${l.desc}">
            ${buildLayoutThumb(l.id)}<span class="theme-name">${l.name}</span>
          </button>`).join('')}
      </div>
    </div>`;
  const r=$('#themeBtn').getBoundingClientRect();
  themePanel.style.position='fixed';
  themePanel.style.top=(r.bottom+6)+'px';
  themePanel.style.right=(window.innerWidth - r.right)+'px';
  document.body.appendChild(themePanel);
  themePanel.addEventListener('mousedown',ev=>ev.stopPropagation());
  themePanel.querySelectorAll('.theme-opt').forEach(opt=>{
    opt.onclick=ev=>{
      ev.stopPropagation();
      const cat=opt.dataset.cat, id=opt.dataset.id;
      if(cat==='theme') applyTheme(id);
      else if(cat==='style') applyMapStyle(id);
      else if(cat==='layout') applyMapLayout(id);
      // Update active state within the same section
      const sec=opt.closest('.tp-section');
      sec.querySelectorAll('.theme-opt').forEach(o=>o.classList.remove('active'));
      opt.classList.add('active');
    };
  });
};
document.addEventListener('click',e=>{
  if(themePanel && !themePanel.contains(e.target) && e.target.id!=='themeBtn') closeThemePanel();
});
// Apply saved theme at boot
try{ applyTheme(localStorage.getItem('mindspark:theme')||'light'); }catch(e){}

applyView();

/* ============================================================
   DONATE — quick-amount picker. Edit DONATE_CONFIG below to
   point at your own payment links. Set any line to null/'' to
   hide that provider in the modal.
   ============================================================ */
const DONATE_CONFIG = {
  // Buy Me a Coffee — works globally. Replace USERNAME with yours.
  bmac:    'https://www.buymeacoffee.com/YOUR_USERNAME',
  // Ko-fi — works globally.
  kofi:    'https://ko-fi.com/YOUR_USERNAME',
  // PayPal.me — supports embedding the amount in the URL: paypal.me/YOU/5
  paypal:  'https://www.paypal.com/paypalme/YOUR_USERNAME',
  // UPI (India) — use a UPI deep-link. Replace with your VPA.
  // Example: 'upi://pay?pa=yourname@okicici&pn=MindSpark&cu=INR'
  upi:     null,
  // GitHub Sponsors
  github:  null
};
const DONATE_AMOUNTS = [3, 5, 10, 25];

function showDonateModal(){
  document.querySelectorAll('.donate-modal').forEach(m=>m.remove());
  const m=document.createElement('div');
  m.className='donate-modal';
  const has = k => DONATE_CONFIG[k] && !DONATE_CONFIG[k].includes('YOUR_USERNAME');
  const providers = [
    has('bmac')   && {k:'bmac',   label:'Buy Me a Coffee', icon:'☕', url:DONATE_CONFIG.bmac,   color:'#ffdd00', supportsAmount:false},
    has('kofi')   && {k:'kofi',   label:'Ko-fi',           icon:'♥', url:DONATE_CONFIG.kofi,   color:'#ff5e5b', supportsAmount:false},
    has('paypal') && {k:'paypal', label:'PayPal',          icon:'P', url:DONATE_CONFIG.paypal, color:'#0070ba', supportsAmount:true},
    has('upi')    && {k:'upi',    label:'UPI (India)',     icon:'₹', url:DONATE_CONFIG.upi,    color:'#5f259f', supportsAmount:true},
    has('github') && {k:'github', label:'GitHub Sponsors', icon:'♥', url:DONATE_CONFIG.github, color:'#bf3989', supportsAmount:false}
  ].filter(Boolean);
  const configured = providers.length>0;
  m.innerHTML = `
    <div class="donate-backdrop"></div>
    <div class="donate-card">
      <button class="donate-close" aria-label="Close">×</button>
      <div class="donate-head">
        <div class="donate-icon">♥</div>
        <h2>Support MindSpark</h2>
        <p>MindSpark is free and open source. If it's useful to you, a small contribution helps keep it that way.</p>
      </div>
      ${configured ? `
        <div class="donate-amounts">
          <div class="donate-label">Pick an amount</div>
          <div class="donate-amount-row">
            ${DONATE_AMOUNTS.map(a=>`<button class="donate-amt" data-amt="${a}">$${a}</button>`).join('')}
            <div class="donate-custom">
              <span>$</span><input type="number" id="donateCustomAmt" min="1" placeholder="other" />
            </div>
          </div>
        </div>
        <div class="donate-providers">
          <div class="donate-label">Donate via</div>
          ${providers.map(p=>`
            <button class="donate-provider" data-k="${p.k}" style="--p-color:${p.color}">
              <span class="dp-icon">${p.icon}</span>
              <span class="dp-label">${p.label}</span>
              <span class="dp-arrow">→</span>
            </button>`).join('')}
        </div>
      ` : `
        <div class="donate-empty">
          <p><b>Donations aren't configured yet.</b></p>
          <p class="small">If you're the host of this MindSpark instance, open <code>public/app.js</code>, scroll to <code>DONATE_CONFIG</code>, and add your Buy Me a Coffee / Ko-fi / PayPal / UPI links. The button will go live the next time you redeploy.</p>
        </div>
      `}
      <div class="donate-foot">
        <a href="#" id="shareLink">↗ Share MindSpark</a>
      </div>
    </div>`;
  document.body.appendChild(m);

  let chosenAmount = null;
  const amtBtns = m.querySelectorAll('.donate-amt');
  const customInput = m.querySelector('#donateCustomAmt');
  amtBtns.forEach(b=>b.addEventListener('click',()=>{
    chosenAmount = +b.dataset.amt;
    amtBtns.forEach(x=>x.classList.toggle('on', x===b));
    if(customInput) customInput.value='';
  }));
  if(customInput) customInput.addEventListener('input',()=>{
    const v=parseFloat(customInput.value);
    if(v>0){ chosenAmount=v; amtBtns.forEach(b=>b.classList.remove('on')); }
  });
  m.querySelectorAll('.donate-provider').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const p = providers.find(x=>x.k===btn.dataset.k);
      let url = p.url;
      if(p.supportsAmount && chosenAmount){
        if(p.k==='paypal') url = url.replace(/\/?$/, '/'+chosenAmount);
        else if(p.k==='upi') url = url + (url.includes('?')?'&':'?') + 'am='+chosenAmount;
      }
      window.open(url, '_blank', 'noopener');
    });
  });
  const close = () => m.remove();
  m.querySelector('.donate-close').onclick = close;
  m.querySelector('.donate-backdrop').onclick = close;
  m.querySelector('#shareLink')?.addEventListener('click',e=>{
    e.preventDefault();
    const url = location.origin + location.pathname;
    if(navigator.share) navigator.share({title:'MindSpark', text:'A free, open mind-mapping app', url}).catch(()=>{});
    else { navigator.clipboard?.writeText(url); toast('Link copied'); }
  });
  document.addEventListener('keydown', function esc(e){
    if(e.key==='Escape'){ close(); document.removeEventListener('keydown', esc); }
  });
}
$('#donateBtn')?.addEventListener('click', showDonateModal);
async function proceedBoot(){
  let idx=[];
  try{ idx=await Store.list(); }catch(e){}
  if(idx && idx.length){
    const ok=await loadMap(idx[0].id);
    if(!ok) createMap();
  } else {
    createMap();
  }
}

function showUserPill(){
  const pill=$('#userPill'); if(!pill) return;
  pill.style.display='flex';
  $('#userAvatar').src = CloudStore.user.avatar_url;
  $('#userName').textContent = CloudStore.user.login;
  $('#userSignOut').onclick = ()=>{
    if(confirm('Sign out of MindSpark? Your maps stay safely in your GitHub repo.')){
      CloudStore.logout();
      location.reload();
    }
  };
}

function showLoginOverlay(){
  const ov=$('#loginOverlay'); if(!ov) return;
  ov.style.display='flex';
  const sign=$('#ghSignIn'), pat=$('#ghPat'), err=$('#ghError');
  const doLogin=async()=>{
    const tok=(pat.value||'').trim();
    if(!tok){ err.textContent='Paste your token first.'; return; }
    err.textContent=''; sign.disabled=true; sign.textContent='Signing in…';
    try{
      await CloudStore.login(tok);
      ov.style.display='none';
      showUserPill();
      await proceedBoot();
    }catch(e){
      err.textContent = e.message || String(e);
      sign.disabled=false; sign.textContent='Sign in';
    }
  };
  sign.onclick = doLogin;
  pat.addEventListener('keydown', e=>{ if(e.key==='Enter') doLogin(); });
  pat.focus();
}

(async()=>{
  const {mode, loggedIn} = await initStore();
  if(mode==='cloud'){
    if(loggedIn){ showUserPill(); await proceedBoot(); }
    else { showLoginOverlay(); }
  } else {
    await proceedBoot();
  }
})().catch(e=>{ console.error(e); if(!map) createMap(); });
