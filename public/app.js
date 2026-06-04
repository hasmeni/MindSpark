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
// Wrap document.execCommand so missing-method environments (older Safari without
// the legacy API, jsdom-based tests, etc.) silently no-op instead of throwing.
// All inline-formatting toolbar buttons funnel through here.
function execCmd(cmd, value){
  if(typeof document.execCommand !== 'function') return false;
  try { return document.execCommand(cmd, false, value); }
  catch(e){ console.warn('execCommand failed:', cmd, e); return false; }
}

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
  // Keep the (in-viewport) node toolbar at constant screen size as zoom changes
  const bar=$('#nodebar');
  if(bar) bar.style.transform=`translateX(-50%) scale(${1/view.k})`;
  updateMinimapViewport();
}
function clearNodes(){ document.querySelectorAll('.node').forEach(n=>n.remove()); }

function render(){
  clearNodes(); edges.innerHTML='';
  if(!map){
    $('#empty').style.display='grid';
    $('#nodebar')?.remove();              // no node toolbar on a blank canvas
    if(activePicker){ activePicker.remove(); activePicker=null; }
    $('#mapTitle').value='';              // reset title field
    viewport.removeAttribute('data-style');
    viewport.removeAttribute('data-layout');   // reset style/background
    sel=null;
    updateBreadcrumb();                   // hides (no map)
    updateMinimap();                      // clears + hides the overview box
    return;
  }
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
    // Reference/citation nodes get a distinct class
    if(n.ref) el.classList.add('ref-node');
    // Attached image renders as a thumbnail above the text (node goes column)
    if(n.image){
      el.classList.add('has-image');
      const img=document.createElement('img');
      img.className='node-image'; img.src=n.image; img.alt='attachment';
      img.addEventListener('mousedown',ev=>ev.stopPropagation());
      img.addEventListener('dblclick',ev=>{ ev.stopPropagation(); window.open(n.image,'_blank'); });
      el.appendChild(img);
    }
    // Task checkbox — click to advance todo → doing → done
    if(n.task){
      el.classList.add('task-node','task-'+n.task);
      const cb=document.createElement('span');
      cb.className='task-check task-'+n.task;
      cb.title='Task: '+n.task+' (click to change)';
      cb.textContent = n.task==='done' ? '✓' : (n.task==='doing' ? '◐' : '');
      cb.addEventListener('mousedown',ev=>ev.stopPropagation());
      cb.addEventListener('click',ev=>{ ev.stopPropagation(); cycleTask(id); });
      el.appendChild(cb);
    }
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
    // Citation/reference indicator
    if(n.ref){
      const cb=document.createElement('span');
      cb.className='ref-mark'; cb.textContent='📖';
      cb.title='Reference — click to edit citation';
      cb.addEventListener('mousedown',ev=>ev.stopPropagation());
      cb.addEventListener('click',ev=>{ ev.stopPropagation(); showCitationForm(id); });
      el.appendChild(cb);
    }
    // Task progress roll-up — shown on nodes that have task-bearing descendants
    const prog = taskProgress(id);
    if(prog.total > 0 && !n.task){
      const pb=document.createElement('span');
      pb.className='task-progress'+(prog.done===prog.total?' complete':'');
      pb.textContent=`✓ ${prog.done}/${prog.total}`;
      pb.title=`${prog.done} of ${prog.total} tasks done in this branch`;
      pb.addEventListener('mousedown',ev=>ev.stopPropagation());
      pb.addEventListener('click',ev=>ev.stopPropagation());
      el.appendChild(pb);
    }
    // Token-count badge — shown for nodes whose text + notes are non-trivial.
    // Rough ~4 chars/token estimate (matches Anthropic & OpenAI tokenizer averages
    // for English; treat as ±20%). Helps when building prompts to keep an eye on
    // token budgets.
    const tokens = estimateTokens(n.text, n.notes);
    if(tokens >= 25){
      const tb = document.createElement('span');
      tb.className = 'token-badge';
      tb.textContent = '~'+tokens+'t';
      tb.title = `Approximately ${tokens} tokens (text${noteText?' + notes':''}). Rough estimate using ~4 chars/token.`;
      tb.addEventListener('mousedown',ev=>ev.stopPropagation());
      tb.addEventListener('click',ev=>ev.stopPropagation());
      el.appendChild(tb);
    }
    viewport.appendChild(el);
    // measure & store size for layout/edges
    const r=el.getBoundingClientRect();
    n.w=r.width/view.k; n.h=r.height/view.k;
  }
  drawEdges(hidden);
  positionNodeBar();
  updateTokenTotal();
  updateMinimap();
  updateBreadcrumb();
  // Re-apply multi-selection outlines (render rebuilds node elements)
  if(typeof multiSel !== 'undefined' && multiSel.size){
    multiSel.forEach(id=>document.querySelector(`.node[data-id="${id}"]`)?.classList.add('multi-sel'));
  }
}

// Sum estimated tokens across every node (text + notes) and show in the topbar.
function updateTokenTotal(){
  const el = $('#tokenTotal');
  if(!el || !map || !map.nodes){ if(el) el.textContent=''; return; }
  let total = 0;
  Object.values(map.nodes).forEach(n => { total += estimateTokens(n.text, n.notes); });
  el.textContent = total > 0 ? `~${total.toLocaleString()} tokens` : '';
  el.style.display = total > 0 ? '' : 'none';
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
// Wrap the current selection in a <ul>/<ol> where each <br>-separated line
// becomes its own <li>. Falls back to native execCommand when no selection.
function applyListToSelection(kind){
  const wsel = window.getSelection();
  if(!wsel || wsel.rangeCount === 0){
    return execCmd(kind==='ul' ? 'insertUnorderedList' : 'insertOrderedList');
  }
  const range = wsel.getRangeAt(0);
  if(range.collapsed){
    return execCmd(kind==='ul' ? 'insertUnorderedList' : 'insertOrderedList');
  }
  // Extract the selected contents into a fragment, then walk it to build lines.
  const frag = range.extractContents();
  const lines = fragmentToLines(frag);
  // Build a <ul>/<ol> with one <li> per line
  const listTag = (kind==='ul') ? 'ul' : 'ol';
  const listEl = document.createElement(listTag);
  lines.forEach(lineHTML => {
    const li = document.createElement('li');
    // Empty lines get a <br> so the <li> has visible height
    li.innerHTML = lineHTML.trim() || '<br>';
    listEl.appendChild(li);
  });
  // Insert the list back where the selection was
  range.insertNode(listEl);
  // Place the cursor at the end of the last list item
  const lastLi = listEl.lastElementChild;
  if(lastLi){
    const after = document.createRange();
    after.selectNodeContents(lastLi);
    after.collapse(false);
    wsel.removeAllRanges();
    wsel.addRange(after);
  }
  return true;
}
// Walk a DocumentFragment, splitting into lines on <br>/<div>/<p>/<li> boundaries,
// preserving any inline formatting (b/i/u/s/a/span) inside each line.
function fragmentToLines(frag){
  const lines = [];
  let current = '';
  const flush = () => { lines.push(current); current = ''; };
  const serialize = (el) => {
    const tmp = document.createElement('div');
    tmp.appendChild(el.cloneNode(true));
    return tmp.innerHTML;
  };
  const walk = (node) => {
    node.childNodes.forEach(child => {
      if(child.nodeType === 3){
        // Text node — split on any literal \n
        const parts = (child.nodeValue || '').split('\n');
        parts.forEach((part, i) => {
          if(i>0) flush();
          current += escapeHtml(part);
        });
      } else if(child.nodeType === 1){
        const tag = child.tagName.toLowerCase();
        if(tag === 'br'){ flush(); }
        else if(tag === 'div' || tag === 'p' || tag === 'li'){
          if(current) flush();
          walk(child);
          if(current) flush();
        } else {
          // Inline element — keep its formatting intact within the line
          current += serialize(child);
        }
      }
    });
  };
  walk(frag);
  if(current) flush();
  return lines.filter(l => l !== undefined);
}
const INLINE_HTML_RE = /<(b|i|u|s|strong|em|br|a|span|font|div|ul|ol|li|p)\b/i;
// Sanitize HTML: keep only a small inline-formatting whitelist; strip everything else
const SAFE_TAGS = new Set(['b','i','u','s','strong','em','br','a','span','font','div','ul','ol','li','p']);
function sanitizeInlineHTML(html){
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const walk = (node) => {
    [...node.childNodes].forEach(child => {
      if(child.nodeType === 1){
        const tag = child.tagName.toLowerCase();
        if(!SAFE_TAGS.has(tag)){
          // Unwrap unknown elements — keep their text children inline
          while(child.firstChild) node.insertBefore(child.firstChild, child);
          node.removeChild(child);
          return;
        }
        [...child.attributes].forEach(attr => {
          const n = attr.name.toLowerCase();
          if(n.startsWith('on')) child.removeAttribute(attr.name);
          else if(tag==='a' && n==='href'){
            if(!/^https?:\/\//i.test(attr.value)) child.removeAttribute(attr.name);
          }
          else if(n==='style'){
            // Allow only color / background-color / font-weight / font-style / text-decoration
            const safe = attr.value
              .split(';').map(s=>s.trim()).filter(Boolean)
              .filter(s=>/^(color|background-color|font-weight|font-style|text-decoration)\s*:/i.test(s))
              .join('; ');
            if(safe) child.setAttribute('style', safe); else child.removeAttribute('style');
          }
          else if(!['href','target','rel','class','color','face','size'].includes(n)) child.removeAttribute(attr.name);
        });
        if(tag==='a'){ child.setAttribute('target','_blank'); child.setAttribute('rel','noopener noreferrer'); }
        walk(child);
      } else if(child.nodeType === 8){
        node.removeChild(child);  // comments
      }
    });
  };
  walk(tmp);
  return tmp.innerHTML;
}
function renderNodeText(container, text, listType){
  container.textContent='';
  const isHTML = INLINE_HTML_RE.test(text||'');
  if(!listType){
    if(isHTML){
      container.innerHTML = sanitizeInlineHTML(text);
      // Auto-link any remaining plain-text URLs inside (skip text already inside <a>)
      autoLinkPlainTextNodes(container);
    } else {
      appendTextWithLinks(container, text);
    }
    return;
  }
  // List mode: split on newlines (or <br> if HTML), one bullet per line
  let lines;
  if(isHTML){
    // Normalize <br> to \n for splitting; strip tags for prefixing purposes
    const tmp=document.createElement('div'); tmp.innerHTML=sanitizeInlineHTML(text);
    // Replace <br> with \n
    tmp.querySelectorAll('br').forEach(br=>br.replaceWith(document.createTextNode('\n')));
    lines = tmp.innerHTML.split(/\n+/);
  } else {
    lines = (text||'').split('\n');
  }
  lines.forEach((line, i)=>{
    if(i>0) container.appendChild(document.createElement('br'));
    const prefix = document.createElement('span');
    prefix.className='list-marker';
    prefix.textContent = listType==='ol' ? `${i+1}.\u00A0` : '•\u00A0';
    container.appendChild(prefix);
    if(isHTML){
      const span=document.createElement('span'); span.innerHTML=sanitizeInlineHTML(line);
      container.appendChild(span);
      autoLinkPlainTextNodes(span);
    } else {
      appendTextWithLinks(container, line);
    }
  });
}
// Walk text nodes inside `root` and convert any bare URLs into <a> links.
// Skips text already inside an <a>, so we don't double-link.
function autoLinkPlainTextNodes(root){
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const toReplace=[];
  let node;
  while((node = walker.nextNode())){
    if(node.parentElement && node.parentElement.closest('a')) continue;
    if(URL_RE.test(node.nodeValue||'')) toReplace.push(node);
  }
  toReplace.forEach(t=>{
    const frag=document.createDocumentFragment();
    appendTextWithLinks(frag, t.nodeValue||'');
    t.parentNode.replaceChild(frag, t);
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
  // Cross-links: non-tree edges (references / dependencies). Drawn as separate
  // dotted paths so they read differently from the structural tree edges.
  let linkPath='';
  const linkMarkers=[];
  (map.links||[]).forEach(lk=>{
    const a=map.nodes[lk.from], b=map.nodes[lk.to];
    if(!a||!b) return;
    if(hidden.has(lk.from)||hidden.has(lk.to)) return;
    const ax=a.x+(a.w||120)/2, ay=a.y+(a.h||40)/2;
    const bx=b.x+(b.w||120)/2, by=b.y+(b.h||40)/2;
    // Gentle curve so overlapping links are distinguishable
    const mx=(ax+bx)/2, my=(ay+by)/2;
    const dx=bx-ax, dy=by-ay;
    const len=Math.hypot(dx,dy)||1;
    const off=Math.min(60, len*0.18);
    const cx=mx - (dy/len)*off, cy=my + (dx/len)*off;
    linkPath += `M${ax},${ay} Q${cx},${cy} ${bx},${by} `;
    linkMarkers.push({x:bx,y:by,cx,cy});
  });
  edges.innerHTML =
    `<path d="${path}" fill="none" stroke="var(--edge-color, var(--line-2))" stroke-width="var(--edge-width, 2.2)" stroke-linecap="round"/>` +
    (linkPath ? `<path d="${linkPath}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="2 6" stroke-linecap="round" opacity="0.85"/>` : '');
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

// ===== Global overlap avoidance =====
// Nudge overlapping nodes apart with minimum displacement, moving whole
// subtrees so branch structure stays intact. The `anchorId` subtree is held
// fixed (the node just added / moved); everything overlapping it is pushed away.
// Preserves manual arrangement — only acts where boxes actually collide.
function _nbox(id){ const n=map.nodes[id]; return {x:n.x, y:n.y, w:n.w||120, h:n.h||40}; }
function _overlap(a,b,gap){
  return a.x < b.x+b.w+gap && a.x+a.w+gap > b.x && a.y < b.y+b.h+gap && a.y+a.h+gap > b.y;
}
function _subtreeSet(id){ const s=new Set([id]); const w=i=>childrenOf(i).forEach(c=>{s.add(c);w(c);}); w(id); return s; }
function shiftSubtreeBy(id,dx,dy){ const n=map.nodes[id]; if(!n) return; n.x+=dx; n.y+=dy; childrenOf(id).forEach(c=>shiftSubtreeBy(c,dx,dy)); }
function resolveOverlaps(anchorId){
  if(!map) return;
  const GAP=16;
  const vertical = (map.layout||'balanced')!=='down';
  const hidden=hiddenSet();
  const ids=Object.keys(map.nodes).filter(id=>!hidden.has(id));
  const anchorSet = anchorId ? _subtreeSet(anchorId) : new Set();
  let iterations=0;
  while(iterations++ < 80){
    let movedAny=false;
    for(let i=0;i<ids.length;i++){
      for(let j=i+1;j<ids.length;j++){
        const A=ids[i], B=ids[j];
        if(map.nodes[A].parent===B || map.nodes[B].parent===A) continue;
        const a=_nbox(A), b=_nbox(B);
        if(!_overlap(a,b,GAP)) continue;
        let mover;
        if(anchorSet.has(A) && !anchorSet.has(B)) mover=B;
        else if(anchorSet.has(B) && !anchorSet.has(A)) mover=A;
        else mover = vertical ? (a.y<=b.y?B:A) : (a.x<=b.x?B:A);
        const other = (mover===A)?B:A;
        const mb=_nbox(mover), ob=_nbox(other);
        if(vertical){
          const dir = (mb.y >= ob.y) ? 1 : -1;
          const push = dir>0 ? (ob.y+ob.h+GAP - mb.y) : (mb.y+mb.h+GAP - ob.y);
          if(push>0){ shiftSubtreeBy(mover, 0, dir*push); movedAny=true; }
        } else {
          const dir = (mb.x >= ob.x) ? 1 : -1;
          const push = dir>0 ? (ob.x+ob.w+GAP - mb.x) : (mb.x+mb.w+GAP - ob.x);
          if(push>0){ shiftSubtreeBy(mover, dir*push, 0); movedAny=true; }
        }
      }
    }
    if(!movedAny) break;
  }
}

// After a node has been resized, push any siblings whose subtree-bounds now
// overlap the resized node (or each other) just enough to restore the default
// gap. We move whole subtrees (children follow), and only nudge — we don't do
// a full relayout, so the user's manual arrangement is preserved.
function resolveResizeCollisions(resizedId){
  if(!map || !map.nodes[resizedId]) return;
  const r = map.nodes[resizedId];
  if(!r.parent) return;                       // root: no siblings to nudge
  const layout = map.layout || 'balanced';
  const vertical = (layout === 'down');       // down layout stacks horizontally
  const gap = vertical ? DOWN_HGAP : VGAP;

  // Helper: bounding box of a single node
  const box = id => {
    const n = map.nodes[id];
    return { x: n.x, y: n.y, w: n.w||120, h: n.h||40 };
  };
  // Helper: bounding box of a whole subtree (for cleaner collision avoidance —
  // a node + its descendants behave as one block).
  const subtreeBox = id => {
    const ids = [id]; const collect = i => { childrenOf(i).forEach(c => { ids.push(c); collect(c); }); };
    collect(id);
    let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
    ids.forEach(i => {
      const b = box(i);
      if(b.x < minX) minX = b.x;
      if(b.y < minY) minY = b.y;
      if(b.x + b.w > maxX) maxX = b.x + b.w;
      if(b.y + b.h > maxY) maxY = b.y + b.h;
    });
    return { x:minX, y:minY, w:maxX-minX, h:maxY-minY };
  };
  // Helper: shift a whole subtree
  const shift = (id, dx, dy) => {
    const n = map.nodes[id]; n.x += dx; n.y += dy;
    childrenOf(id).forEach(c => shift(c, dx, dy));
  };

  // Only consider siblings on the same side of the parent — those are the
  // ones that are stacked next to the resized node in the layout direction.
  const siblings = childrenOf(r.parent).filter(c => c !== resizedId && map.nodes[c].side === r.side);
  if(!siblings.length) return;

  // Resized-node centre on the stacking axis (y for horizontal layouts, x for down)
  const rb = box(resizedId);
  const rCentre = vertical ? rb.x + rb.w/2 : rb.y + rb.h/2;
  // Separate siblings into "before" (lower coord) and "after" (higher coord) on
  // the stacking axis. Sort each so we can cascade nudges.
  const before = [], after = [];
  siblings.forEach(s => {
    const sb = subtreeBox(s);
    const sc = vertical ? sb.x + sb.w/2 : sb.y + sb.h/2;
    (sc < rCentre ? before : after).push(s);
  });
  if(vertical){
    before.sort((a,b) => subtreeBox(b).x - subtreeBox(a).x);  // closest-to-resized first
    after.sort((a,b) => subtreeBox(a).x - subtreeBox(b).x);
  } else {
    before.sort((a,b) => subtreeBox(b).y - subtreeBox(a).y);
    after.sort((a,b) => subtreeBox(a).y - subtreeBox(b).y);
  }

  // "After" pass: ensure each successive sibling sits at least `gap` past the
  // previous block on the stacking axis. The first comparison uses the resized
  // node's actual box; subsequent ones use the previous subtree-bounds.
  let prevEnd = vertical ? (rb.x + rb.w) : (rb.y + rb.h);
  after.forEach(s => {
    const sb = subtreeBox(s);
    const start = vertical ? sb.x : sb.y;
    const need  = prevEnd + gap;
    if(start < need){
      const delta = need - start;
      if(vertical) shift(s, delta, 0);
      else         shift(s, 0, delta);
    }
    const newSB = subtreeBox(s);
    prevEnd = vertical ? (newSB.x + newSB.w) : (newSB.y + newSB.h);
  });
  // "Before" pass: mirror image — push earlier siblings backwards if they
  // would overlap with the resized node now (because it grew upward/leftward).
  let prevStart = vertical ? rb.x : rb.y;
  before.forEach(s => {
    const sb = subtreeBox(s);
    const end = vertical ? (sb.x + sb.w) : (sb.y + sb.h);
    const need = prevStart - gap;
    if(end > need){
      const delta = end - need;
      if(vertical) shift(s, -delta, 0);
      else         shift(s, 0, -delta);
    }
    const newSB = subtreeBox(s);
    prevStart = vertical ? newSB.x : newSB.y;
  });

  render();
}

// Assign root children to left/right by subtree weight for a balanced split.
// Used when first building a map (templates) or when explicitly re-balancing;
// stable autoLayout then preserves the assignment.
function balanceRootSides(){
  if(!map) return;
  const kids=childrenOf(map.rootId);
  const weights=kids.map(k=>({k,w:countDesc(k)+1}));
  let L=0,R=0;
  weights.sort((a,b)=>b.w-a.w).forEach(o=>{
    if(R<=L){ map.nodes[o.k].side='right'; R+=o.w; }
    else { map.nodes[o.k].side='left'; L+=o.w; }
  });
}
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
    // BALANCED — but STABLE. Keep whatever side each child is already on so the
    // map never reshuffles on an unrelated edit; only freshly-added children
    // (no side yet) are assigned, choosing whichever side is lighter. This is
    // what makes auto-layout feel consistent rather than like a "reset".
    kids.forEach(k=>{
      const s=map.nodes[k].side;
      if(s==='left') leftSet.push(k);
      else if(s==='right') rightSet.push(k);
    });
    kids.forEach(k=>{
      const s=map.nodes[k].side;
      if(s!=='left' && s!=='right'){
        if(rightSet.length<=leftSet.length){ rightSet.push(k); map.nodes[k].side='right'; }
        else { leftSet.push(k); map.nodes[k].side='left'; }
      }
    });
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
function restore(s){ const o=JSON.parse(s); map.nodes=o.nodes; map.rootId=o.rootId; map.title=o.title; map.color=o.color; $('#mapTitle').value=map.title; autoLayout(); }
function undo(){ if(hpos>0){hpos--;restore(history[hpos]);updateUndo();} }
function redo(){ if(hpos<history.length-1){hpos++;restore(history[hpos]);updateUndo();} }

function addNode(parentId,asSibling){
  if(READONLY) return;
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
  pushHistory();
  // Stable auto-layout tidies the tree (the new node is inserted in order and
  // everything stays non-overlapping). Because layout is stable, existing
  // branches keep their side/order — it tidies, it doesn't reshuffle.
  autoLayout();
  select(id,true);
}
// Position a freshly-added node relative to its existing siblings without
// moving any other node. Keeps insertion order (new node goes last) and
// preserves the user's manual arrangement of the rest of the map.
function placeNewNodeNear(id){
  const n=map.nodes[id]; if(!n) return;
  const parent=map.nodes[n.parent]; if(!parent) return;
  const layout=map.layout||'balanced';
  // Only stack against siblings on the SAME side. Root children can be split
  // left/right, and a left-side node must be placed on the left (so its edge
  // leaves the root's left edge) rather than next to a right-side sibling —
  // otherwise the connector stretches all the way across the canvas.
  const sibs=childrenOf(n.parent).filter(c=>c!==id && map.nodes[c].side===n.side);
  const nw=n.w||120, nh=n.h||40;
  if(layout==='down'){
    // Horizontal stacking: new node goes to the right of the rightmost sibling
    const childY=parent.y+(parent.h||40)+DOWN_VGAP;
    if(sibs.length){
      let maxRight=-Infinity, y=childY;
      sibs.forEach(s=>{ const sn=map.nodes[s]; maxRight=Math.max(maxRight, sn.x+(sn.w||120)); y=sn.y; });
      n.x=maxRight+DOWN_HGAP; n.y=y;
    } else {
      n.x=parent.x+((parent.w||120)-nw)/2; n.y=childY;
    }
  } else {
    // Vertical stacking: new node goes below the lowest SAME-SIDE sibling
    const dir=n.side==='left'?-1:1;
    if(sibs.length){
      let maxBottom=-Infinity, colX=null;
      sibs.forEach(s=>{ const sn=map.nodes[s]; const b=sn.y+(sn.h||40); if(b>maxBottom){maxBottom=b;} colX=sn.x; });
      n.y=maxBottom+VGAP;
      n.x=(colX!=null)?colX:(dir>0?parent.x+(parent.w||120)+HGAP:parent.x-nw-HGAP);
    } else {
      // First node on this side — sit it beside the parent on the matching side
      n.x=dir>0?parent.x+(parent.w||120)+HGAP:parent.x-nw-HGAP;
      n.y=parent.y+((parent.h||40)-nh)/2;
    }
  }
}
function deleteNode(id){
  if(id===map.rootId) return;
  const rm=[id]; const walk=i=>childrenOf(i).forEach(c=>{rm.push(c);walk(c)}); walk(id);
  const parent=map.nodes[id].parent;
  rm.forEach(r=>delete map.nodes[r]);
  pruneLinks(rm);
  sel=parent;
  autoLayout();      // re-tidy first…
  pushHistory();     // …then snapshot the clean, balanced state
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
  updateBreadcrumb();
  if(edit) setTimeout(()=>startEdit(id),0);
}

/* ============================================================
   MULTI-SELECT — shift-click to build a selection set, then
   bulk delete / recolor / re-parent.
   ============================================================ */
let multiSel = new Set();
let reparentMode = false;

function toggleMultiSelect(id){
  // First shift-click seeds the set with the current primary selection so the
  // node you already had selected is included.
  if(multiSel.size === 0 && sel && sel !== id) multiSel.add(sel);
  if(multiSel.has(id)) multiSel.delete(id);
  else multiSel.add(id);
  updateMultiSelUI();
}
function clearMultiSelect(){
  multiSel.clear();
  reparentMode = false;
  updateMultiSelUI();
}
function updateMultiSelUI(){
  document.querySelectorAll('.node.multi-sel').forEach(n=>n.classList.remove('multi-sel'));
  multiSel.forEach(id=>{
    document.querySelector(`.node[data-id="${id}"]`)?.classList.add('multi-sel');
  });
  if(multiSel.size >= 2){
    $('#nodebar')?.remove();   // hide the single-node format toolbar
    showBulkBar();
  } else {
    hideBulkBar();
  }
}
function hideBulkBar(){ $('#bulkBar')?.remove(); }
function showBulkBar(prompt){
  hideBulkBar();
  const bar = document.createElement('div');
  bar.id = 'bulkBar'; bar.className = 'bulk-bar';
  if(prompt){
    bar.innerHTML = `<span class="bulk-count">${prompt}</span>
      <button class="bulk-cancel" data-a="cancel">Cancel</button>`;
  } else {
    bar.innerHTML = `
      <span class="bulk-count">${multiSel.size} selected</span>
      <div class="bulk-sep"></div>
      <button data-a="bold" title="Bold all"><b>B</b></button>
      <button data-a="italic" title="Italic all"><i>I</i></button>
      <button data-a="underline" title="Underline all"><u>U</u></button>
      <button data-a="strike" title="Strikethrough all"><s>S</s></button>
      <div class="bulk-sep"></div>
      <button data-a="size" title="Font size">A<span style="font-size:9px">▾</span></button>
      <button data-a="align" title="Text alignment">⇆</button>
      <button data-a="textcolor" title="Text color"><span style="border-bottom:2px solid var(--accent)">A</span></button>
      <button data-a="highlight" title="Highlight">▦</button>
      <button data-a="color" title="Node background">🎨</button>
      <div class="bulk-sep"></div>
      <button data-a="reparent" title="Move all under a new parent">⤷</button>
      <button data-a="delete" class="bulk-danger" title="Delete all">🗑</button>
      <button class="bulk-cancel" data-a="cancel" title="Clear selection">✕</button>`;
  }
  document.body.appendChild(bar);
  bar.addEventListener('mousedown', e=>e.stopPropagation());
  bar.querySelectorAll('button').forEach(b=> b.onclick = (ev)=>{
    ev.stopPropagation();
    const a = b.dataset.a;
    if(a==='delete') bulkDelete();
    else if(a==='color') showBulkColorPicker(b, 'bg');
    else if(a==='reparent') startBulkReparent();
    else if(a==='cancel') clearMultiSelect();
    else if(a==='bold') bulkFormat('bold');
    else if(a==='italic') bulkFormat('italic');
    else if(a==='underline') bulkFormat('underline');
    else if(a==='strike') bulkFormat('strike');
    else if(a==='size') showBulkSizePicker(b);
    else if(a==='align') bulkCycleAlign();
    else if(a==='textcolor') showBulkColorPicker(b, 'text');
    else if(a==='highlight') showBulkColorPicker(b, 'highlight');
  });
}
// Toggle a boolean style across all selected nodes (on if any are off).
function bulkFormat(prop){
  const ids = [...multiSel].filter(id=>map.nodes[id]);
  const anyOff = ids.some(id => !map.nodes[id][prop]);
  ids.forEach(id => { map.nodes[id][prop] = anyOff; });
  pushHistory(); render(); updateMultiSelUI();
}
function bulkSetProp(prop, value){
  [...multiSel].forEach(id=>{ if(map.nodes[id]) map.nodes[id][prop] = value; });
  pushHistory(); render(); updateMultiSelUI();
}
function bulkCycleAlign(){
  const order = ['left','center','right'];
  const ids = [...multiSel].filter(id=>map.nodes[id]);
  // Use the first node's current alignment to decide the next in the cycle
  const cur = map.nodes[ids[0]]?.align || 'left';
  const next = order[(order.indexOf(cur)+1) % order.length];
  ids.forEach(id => { map.nodes[id].align = next; });
  pushHistory(); render(); updateMultiSelUI();
  toast('Aligned '+next);
}
function showBulkSizePicker(anchorBtn){
  document.querySelectorAll('.picker').forEach(p=>p.remove());
  const pk = document.createElement('div');
  pk.className = 'picker size';
  pk.innerHTML = FONT_SIZES.map(s=>`<button data-s="${s}">${s}px</button>`).join('');
  document.body.appendChild(pk);
  const r = anchorBtn.getBoundingClientRect();
  pk.style.position='fixed';
  pk.style.left = Math.max(8, r.left)+'px';
  pk.style.top = Math.max(8, r.top - pk.offsetHeight - 8)+'px';
  pk.addEventListener('mousedown', e=>e.stopPropagation());
  pk.querySelectorAll('button').forEach(b=> b.onclick=()=>{ bulkSetProp('fontSize', +b.dataset.s); pk.remove(); });
  setTimeout(()=>document.addEventListener('click', function cl(e){
    if(!pk.contains(e.target)){ pk.remove(); document.removeEventListener('click', cl); }
  }), 0);
}
function showBulkColorPicker(anchorBtn, kind){
  document.querySelectorAll('.picker').forEach(p=>p.remove());
  let colors, prop, allowNone=false;
  if(kind==='text'){ colors = TEXT_COLORS; prop='textColor'; }
  else if(kind==='highlight'){ colors = HILITES; prop='highlight'; allowNone=true; }
  else { colors = ['#fff','#ffd9c2','#ffe9a8','#d6f0c8','#c5e8e4','#cfe0f5','#e6d4f2','#f5d0dd','#e0e0e0']; prop='color'; }
  const pk = document.createElement('div');
  pk.className = 'picker';
  pk.innerHTML =
    (allowNone ? `<button class="p-sw" style="background:transparent;position:relative" data-c="" title="None">∅</button>` : '') +
    colors.map(c=>`<button class="p-sw" style="background:${c}" data-c="${c}"></button>`).join('');
  document.body.appendChild(pk);
  const r = anchorBtn.getBoundingClientRect();
  pk.style.position='fixed';
  pk.style.left = Math.max(8, r.left)+'px';
  pk.style.top = Math.max(8, r.top - pk.offsetHeight - 8)+'px';
  pk.addEventListener('mousedown', e=>e.stopPropagation());
  pk.querySelectorAll('button').forEach(b=> b.onclick=()=>{
    const v = b.dataset.c;
    bulkSetProp(prop, v || null);
    pk.remove();
  });
  setTimeout(()=>document.addEventListener('click', function cl(e){
    if(!pk.contains(e.target)){ pk.remove(); document.removeEventListener('click', cl); }
  }), 0);
}
function bulkColor(color){
  multiSel.forEach(id=>{ if(map.nodes[id] && id!==map.rootId) map.nodes[id].color = color; });
  pushHistory(); render(); updateMultiSelUI();
  toast(`Recolored ${multiSel.size} nodes`);
}
function bulkDelete(){
  const targets = [...multiSel].filter(id => id !== map.rootId);
  if(!targets.length){ toast('Can’t delete the root'); return; }
  const removed = new Set();
  targets.forEach(id=>{
    if(!map.nodes[id]) return;
    const rm=[id]; const walk=i=>childrenOf(i).forEach(c=>{rm.push(c);walk(c)}); walk(id);
    rm.forEach(r=>{ delete map.nodes[r]; removed.add(r); });
  });
  if(sel && removed.has(sel)) sel = map.rootId;
  pruneLinks(removed);
  clearMultiSelect();
  pushHistory(); autoLayout();
  toast(`Deleted ${removed.size} node${removed.size===1?'':'s'}`);
}
function startBulkReparent(){
  reparentMode = true;
  showBulkBar('Click a target node to move ' + multiSel.size + ' nodes under it…');
}
function bulkReparent(targetId){
  let count = 0;
  multiSel.forEach(id=>{
    if(id===map.rootId) return;                 // can't reparent root
    if(id===targetId) return;                    // skip self
    if(isDescendant(targetId, id)) return;       // would create a cycle
    const child = map.nodes[id]; if(!child) return;
    child.parent = targetId;
    // Inherit side from the new parent
    let side;
    if(targetId===map.rootId){ side = (count%2) ? 'left' : 'right'; }
    else side = map.nodes[targetId].side || 'right';
    const propagate=(nid,s)=>{ map.nodes[nid].side=s; childrenOf(nid).forEach(c=>propagate(c,s)); };
    propagate(id, side);
    count++;
  });
  reparentMode = false;
  clearMultiSelect();
  pushHistory(); autoLayout();
  toast(count ? `Moved ${count} node${count===1?'':'s'}` : 'Nothing moved');
}

/* ============================================================
   CROSS-LINKS — non-tree edges between any two nodes.
   Press L on a selected node, then click another to link them.
   ============================================================ */
let linkMode = false, linkSource = null;
function startLinkMode(sourceId){
  if(!sourceId){ return; }
  linkMode = true; linkSource = sourceId;
  document.querySelector(`.node[data-id="${sourceId}"]`)?.classList.add('link-source');
  toast('Link mode — click another node (Esc to cancel)');
}
function cancelLinkMode(){
  linkMode = false; linkSource = null;
  document.querySelectorAll('.node.link-source').forEach(n=>n.classList.remove('link-source'));
}
function completeLink(targetId){
  const from = linkSource;
  cancelLinkMode();
  if(!from || !targetId || from===targetId) return;
  if(!map.links) map.links = [];
  // Toggle: if this exact link already exists (either direction), remove it
  const existsIdx = map.links.findIndex(l =>
    (l.from===from && l.to===targetId) || (l.from===targetId && l.to===from));
  if(existsIdx >= 0){
    map.links.splice(existsIdx, 1);
    toast('Cross-link removed');
  } else {
    map.links.push({ from, to: targetId });
    toast('Cross-link added');
  }
  pushHistory(); render(); scheduleSave();
}
// Remove any cross-links that reference a node (called when a node is deleted)
function pruneLinks(removedIds){
  if(!map.links || !map.links.length) return;
  const gone = removedIds instanceof Set ? removedIds : new Set(removedIds);
  map.links = map.links.filter(l => !gone.has(l.from) && !gone.has(l.to));
}

/* ============================================================
   TASK STATE — todo → doing → done, with parent roll-up
   ============================================================ */
function cycleTask(id){
  const n=map.nodes[id]; if(!n) return;
  const order=[null,'todo','doing','done'];
  const cur=order.indexOf(n.task||null);
  const next=order[(cur+1)%order.length];
  if(next) n.task=next; else delete n.task;
  pushHistory(); render();
}
// Count done / total task-bearing nodes within a subtree (excluding the node itself)
function taskProgress(id){
  let done=0,total=0;
  const walk=i=>childrenOf(i).forEach(c=>{
    const t=map.nodes[c].task;
    if(t){ total++; if(t==='done') done++; }
    walk(c);
  });
  walk(id);
  return {done,total};
}

/* ============================================================
   CITATION / REFERENCE NODES
   ============================================================ */
function formatCitation(c){
  if(!c) return '';
  if(typeof c==='string') return c;
  const parts=[];
  if(c.authors) parts.push(c.authors);
  if(c.year) parts.push('('+c.year+')');
  let s=parts.join(' ');
  if(c.title) s+=(s?'. ':'')+c.title;
  if(c.source) s+=(s?'. ':'')+c.source;
  if(c.doi) s+=(s?'. ':'')+(/^https?:/.test(c.doi)?c.doi:'doi:'+c.doi);
  return s.trim();
}
function showCitationForm(id){
  const n=map.nodes[id]; if(!n) return;
  document.querySelectorAll('.var-form').forEach(p=>p.remove());
  const c = (n.citation && typeof n.citation==='object') ? n.citation : {};
  const m=document.createElement('div'); m.className='var-form';
  m.innerHTML=`
    <div class="vf-backdrop"></div>
    <div class="vf-card">
      <button class="vf-close" aria-label="Close">×</button>
      <h2>Reference / citation</h2>
      <p class="vf-sub">Fill the fields, or paste a full citation into "Authors". The node will show the formatted reference and be included in <b>Export → References</b>.</p>
      <div class="vf-fields">
        <label class="vf-row"><span class="vf-name">Authors</span><textarea class="vf-input" data-f="authors" rows="1" placeholder="Smith, J. & Doe, A.">${escapeHtml(c.authors||'')}</textarea></label>
        <label class="vf-row"><span class="vf-name">Title</span><textarea class="vf-input" data-f="title" rows="1" placeholder="A study of …">${escapeHtml(c.title||'')}</textarea></label>
        <label class="vf-row"><span class="vf-name">Year</span><textarea class="vf-input" data-f="year" rows="1" placeholder="2026">${escapeHtml(c.year||'')}</textarea></label>
        <label class="vf-row"><span class="vf-name">Source / venue</span><textarea class="vf-input" data-f="source" rows="1" placeholder="Journal / Conference">${escapeHtml(c.source||'')}</textarea></label>
        <label class="vf-row"><span class="vf-name">DOI / URL</span><textarea class="vf-input" data-f="doi" rows="1" placeholder="10.1109/… or https://…">${escapeHtml(c.doi||'')}</textarea></label>
      </div>
      <div class="vf-actions">
        ${n.ref?'<button class="vf-unref">Remove reference</button>':''}
        <button class="vf-cancel">Cancel</button>
        <button class="vf-go primary">Save reference</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  m.addEventListener('mousedown',e=>e.stopPropagation());
  m.querySelectorAll('.vf-input').forEach(ta=>{ const g=()=>{ta.style.height='auto';ta.style.height=Math.min(ta.scrollHeight,120)+'px';}; ta.addEventListener('input',g); g(); });
  m.querySelector('.vf-input')?.focus();
  const close=()=>m.remove();
  m.querySelector('.vf-go').onclick=()=>{
    const cit={}; m.querySelectorAll('.vf-input').forEach(ta=>{ if(ta.value.trim()) cit[ta.dataset.f]=ta.value.trim(); });
    n.citation=cit; n.ref=true;
    const formatted=formatCitation(cit);
    if(formatted) n.text=formatted;
    pushHistory(); render(); close(); toast('Reference saved');
  };
  m.querySelector('.vf-unref')?.addEventListener('click',()=>{ delete n.ref; delete n.citation; pushHistory(); render(); close(); toast('Reference removed'); });
  m.querySelector('.vf-cancel').onclick=close;
  m.querySelector('.vf-close').onclick=close;
  m.querySelector('.vf-backdrop').onclick=close;
  m.addEventListener('keydown',e=>{ if(e.key==='Escape'){e.preventDefault();close();} });
}
// Collect every reference node and copy a formatted list to the clipboard.
function exportReferences(){
  if(!map) return;
  const refs=Object.values(map.nodes).filter(n=>n.ref).map(n=>formatCitation(n.citation)||nodeTextPlain(n.text));
  if(!refs.length){ toast('No reference nodes yet — mark a node with 📖'); return; }
  refs.sort((a,b)=>a.localeCompare(b));
  const text='References\n\n'+refs.map((r,i)=>`[${i+1}] ${r}`).join('\n')+'\n';
  if(navigator.clipboard?.writeText){
    navigator.clipboard.writeText(text).then(()=>toast(`${refs.length} references copied`),
      ()=>{ download(new Blob([text],{type:'text/plain'}),(map.title||'references')+'.txt'); toast('Downloaded references'); });
  } else { download(new Blob([text],{type:'text/plain'}),(map.title||'references')+'.txt'); toast('Downloaded references'); }
}

/* ============================================================
   IMAGE ATTACHMENTS — stored as down-scaled data-URLs on the node
   ============================================================ */
function attachImageToNode(id){
  const inp=document.createElement('input'); inp.type='file'; inp.accept='image/*';
  inp.onchange=()=>{ const f=inp.files[0]; if(f) readImageFile(f,id); };
  inp.click();
}
function readImageFile(file,id){
  if(!file.type.startsWith('image/')){ toast('Not an image file'); return; }
  const reader=new FileReader();
  reader.onload=()=>{
    const img=new Image();
    img.onload=()=>{
      // Down-scale to a sane max so the data-URL stays small (esp. for cloud/GitHub storage)
      const MAX=360;
      let w=img.width,h=img.height;
      if(w>MAX){ h=Math.round(h*MAX/w); w=MAX; }
      const cv=document.createElement('canvas'); cv.width=w; cv.height=h;
      cv.getContext('2d').drawImage(img,0,0,w,h);
      let data;
      try{ data=cv.toDataURL('image/jpeg',0.82); }catch(e){ data=reader.result; }
      map.nodes[id].image=data;
      pushHistory(); render();
      const kb=Math.round(data.length/1024);
      toast(`Image attached (~${kb} KB)`+(kb>500 && MODE==='cloud'?' — large images slow cloud sync':''));
    };
    img.onerror=()=>toast('Could not read image');
    img.src=reader.result;
  };
  reader.readAsDataURL(file);
}

/* ============================================================
   SEARCH ACROSS ALL MAPS
   ============================================================ */
async function searchAllMaps(query){
  const q=(query||'').trim().toLowerCase();
  if(!q) return [];
  let idx=[]; try{ idx=await Store.list(); }catch(e){ idx=[]; }
  const results=[];
  for(const meta of idx){
    let m=null;
    try{ m = (meta.id===(map&&map.id)) ? map : await Store.get(meta.id); }catch(e){ continue; }
    if(!m||!m.nodes) continue;
    for(const n of Object.values(m.nodes)){
      const plain=nodeTextPlain(n.text||'').toLowerCase();
      const notes=(n.notes||'').replace(/<[^>]*>/g,' ').toLowerCase();
      if(plain.includes(q) || notes.includes(q)){
        const src=plain.includes(q)?nodeTextPlain(n.text||''):(n.notes||'').replace(/<[^>]*>/g,' ');
        const at=src.toLowerCase().indexOf(q);
        const snippet=(at>30?'…':'')+src.slice(Math.max(0,at-30), at+q.length+40).trim()+'…';
        results.push({ mapId:m.id, mapTitle:m.title||'Untitled', nodeId:n.id, snippet });
        if(results.length>=200) return results;
      }
    }
  }
  return results;
}

// Debounced global search → render results panel
let _globalSearchT=null, _globalSearchSeq=0;
function runGlobalSearch(query){
  clearTimeout(_globalSearchT);
  const q=(query||'').trim();
  if(q.length<2){ hideGlobalResults(); return; }
  const seq=++_globalSearchSeq;
  _globalSearchT=setTimeout(async ()=>{
    const panel=ensureGlobalResults();
    panel.innerHTML='<div class="gs-status">Searching all maps…</div>';
    const results=await searchAllMaps(q);
    if(seq!==_globalSearchSeq) return;   // a newer search superseded this one
    renderGlobalResults(results, q);
  }, 220);
}
function ensureGlobalResults(){
  let panel=$('#globalResults');
  if(!panel){
    panel=document.createElement('div');
    panel.id='globalResults'; panel.className='global-results';
    panel.addEventListener('mousedown',e=>e.stopPropagation());
    document.body.appendChild(panel);
  }
  // Anchor under the search strip
  const sw=$('#searchWrap').getBoundingClientRect();
  panel.style.top=(sw.bottom+6)+'px';
  panel.style.right=(window.innerWidth - sw.right)+'px';
  panel.style.display='block';
  return panel;
}
function hideGlobalResults(){ const p=$('#globalResults'); if(p) p.style.display='none'; }
function renderGlobalResults(results, q){
  const panel=ensureGlobalResults();
  if(!results.length){ panel.innerHTML=`<div class="gs-status">No matches for “${escapeHtml(q)}”.</div>`; return; }
  // Group by map
  const byMap={};
  results.forEach(r=>{ (byMap[r.mapId]=byMap[r.mapId]||{title:r.mapTitle, items:[]}).items.push(r); });
  const re=new RegExp('('+q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+')','ig');
  panel.innerHTML=`<div class="gs-head">${results.length} match${results.length===1?'':'es'} across ${Object.keys(byMap).length} map${Object.keys(byMap).length===1?'':'s'}</div>`+
    Object.entries(byMap).map(([mid,g])=>`
      <div class="gs-group">
        <div class="gs-map">${escapeHtml(g.title)}${mid===(map&&map.id)?' <span class="gs-cur">(current)</span>':''}</div>
        ${g.items.slice(0,8).map(it=>`
          <button class="gs-item" data-map="${mid}" data-node="${it.nodeId}">
            ${escapeHtml(it.snippet).replace(re,'<mark>$1</mark>')}
          </button>`).join('')}
        ${g.items.length>8?`<div class="gs-more">+${g.items.length-8} more…</div>`:''}
      </div>`).join('');
  panel.querySelectorAll('.gs-item').forEach(b=> b.onclick=async ()=>{
    const mid=b.dataset.map, nid=b.dataset.node;
    if(!map || map.id!==mid){ await loadMap(mid); }
    select(nid,false);
    centreOn(nid);
    hideGlobalResults();
  });
}

/* ---------- inline editing ---------- */
// Live markdown shortcuts while editing: typing the closing delimiter of
// **bold**, *italic*, or ~~strike~~ converts the span in place (Notion/Linear
// style). Runs on each input event; processes one completed pattern at a time.
function tryMarkdownShortcut(){
  const wsel = window.getSelection();
  if(!wsel || !wsel.rangeCount) return false;
  const range = wsel.getRangeAt(0);
  const node = range.startContainer;
  if(node.nodeType !== 3) return false;            // text nodes only
  const offset = range.startOffset;
  const upto = node.nodeValue.slice(0, offset);
  // Order matters: bold (**) must be tested before italic (*).
  const patterns = [
    [/\*\*([^*]+?)\*\*$/, 'b'],
    [/\*([^*]+?)\*$/,     'i'],
    [/~~([^~]+?)~~$/,     's'],
  ];
  for(const [re, tag] of patterns){
    const m = upto.match(re);
    if(!m || !m[1].trim()) continue;
    const inner = m[1];
    const matchStart = offset - m[0].length;
    const before = node.nodeValue.slice(0, matchStart);
    const after  = node.nodeValue.slice(offset);
    const parent = node.parentNode;
    const frag = document.createDocumentFragment();
    if(before) frag.appendChild(document.createTextNode(before));
    const fmt = document.createElement(tag);
    fmt.textContent = inner;
    frag.appendChild(fmt);
    const afterNode = document.createTextNode(after.length ? after : '\u00A0');
    frag.appendChild(afterNode);
    parent.replaceChild(frag, node);
    // Put the cursor right after the formatted span so further typing is normal
    const nr = document.createRange();
    if(after.length){ nr.setStart(afterNode, 0); }
    else { nr.setStart(afterNode, 1); }   // past the nbsp placeholder
    nr.collapse(true);
    wsel.removeAllRanges(); wsel.addRange(nr);
    return true;
  }
  return false;
}

function startEdit(id){
  if(READONLY) return;
  const el=document.querySelector(`.node[data-id="${id}"]`); if(!el) return;
  const textEl=el.querySelector('.node-text')||el;
  const raw = map.nodes[id]?.text || '';
  // Preserve any inline formatting (bold/italic/etc.) for the user to edit
  if(INLINE_HTML_RE.test(raw)) textEl.innerHTML = sanitizeInlineHTML(raw);
  else textEl.textContent = raw;
  el.classList.add('editing');
  textEl.contentEditable='true';
  // Keep the format toolbar visible — it's what makes inline B/I/U work
  textEl.focus();
  // select all text so typing replaces it
  const range=document.createRange(); range.selectNodeContents(textEl);
  const s=getSelection(); s.removeAllRanges(); s.addRange(range);
  const finish=(commit)=>{
    textEl.contentEditable='false'; el.classList.remove('editing');
    textEl.removeEventListener('blur',onBlur); textEl.removeEventListener('keydown',onKey);
    textEl.removeEventListener('input',onInput);
    if(commit){
      // Capture as HTML so the user's inline B/I/U is preserved.
      const html = textEl.innerHTML.trim();
      const plain = textEl.textContent.trim();
      // If the user only typed plain text, store plain; otherwise store sanitized HTML.
      const hasFormatting = INLINE_HTML_RE.test(html);
      const newText = !plain ? 'Untitled' : (hasFormatting ? sanitizeInlineHTML(html) : plain);
      map.nodes[id].text = newText;
      // Title sync — for the root and only when user hasn't renamed the map manually
      if(id===map.rootId && map.titleAuto===true){
        // Strip tags for the title
        const titleText = newText.replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').trim() || 'Untitled';
        map.title = titleText;
        $('#mapTitle').value = titleText;
        refreshList();
      }
      pushHistory();
    }
    // Re-render to reflect the edit, but do NOT autoLayout — that would reset
    // every node's position and reorder branches. Editing text leaves the rest
    // of the map exactly where the user put it.
    render();
  };
  const onBlur=()=>finish(true);
  const onInput=()=>{ tryMarkdownShortcut(); };
  const onKey=e=>{
    e.stopPropagation();
    // Standard contentEditable shortcuts: Ctrl/Cmd+B / I / U toggle inline
    if((e.ctrlKey||e.metaKey) && !e.shiftKey){
      const k=e.key.toLowerCase();
      if(k==='b'||k==='i'||k==='u'){ e.preventDefault(); execCmd(k==='b'?'bold':k==='i'?'italic':'underline'); return; }
    }
    if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();finish(true);textEl.blur();}
    if(e.key==='Escape'){e.preventDefault();textEl.textContent=map.nodes[id].text;finish(false);textEl.blur();}
  };
  textEl.addEventListener('blur',onBlur); textEl.addEventListener('keydown',onKey);
  textEl.addEventListener('input',onInput);
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
    // Keep contentEditable selection alive while picking
    b.addEventListener('mousedown', e => e.preventDefault());
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
  if(READONLY) return;            // read-only shared view shows no editing toolbar
  if(activePicker){ activePicker.remove(); activePicker=null; }
  // When 2+ nodes are multi-selected, the bottom bulk bar takes over — don't
  // also show the single-node toolbar.
  if(typeof multiSel !== 'undefined' && multiSel.size >= 2) return;
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
  bar.style.transformOrigin='top center';
  // The bar lives inside the zoomable viewport, so counter-scale it by 1/zoom
  // to keep it a constant on-screen size no matter how far the map is zoomed.
  bar.style.transform=`translateX(-50%) scale(${1/view.k})`;
  bar.innerHTML=`
    <div class="nb-group">
      <button data-a="child" title="Add child (Tab)">＋</button>
      ${!isRoot?'<button data-a="sibling" title="Add sibling (Enter)">⤵</button>':''}
      ${hasKids?`<button data-a="collapse" title="Collapse/expand (Space)">${n.collapsed?'⊕':'⊖'}</button>`:''}
      <button data-a="edit" title="Edit (F2)">✎</button>
      <button data-a="notes" class="${(n.notes||'').trim()?'on':''}" title="${(n.notes||'').trim()?'Edit notes':'Add notes'}">📝</button>
      <button data-a="task" class="${n.task?'on':''}" title="Task state (todo / doing / done)">☑</button>
      <button data-a="cite" class="${n.ref?'on':''}" title="Reference / citation">📖</button>
      <button data-a="image" class="${n.image?'on':''}" title="Attach image">🖼</button>
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
  // Prevent toolbar clicks from stealing focus from a node being edited,
  // so the contentEditable text-selection survives execCommand calls.
  bar.querySelectorAll('button').forEach(b => b.addEventListener('mousedown', e => e.preventDefault()));

  // Inline formatting when a node is in edit mode → applies to the current
  // text selection via execCommand. Outside edit mode → falls back to the
  // node-wide toggle (existing behaviour, kept for back-compat).
  const editingNode = () => {
    const ed = document.querySelector('.node.editing');
    return (ed && ed.dataset.id === sel) ? ed : null;
  };
  const inlineOrToggle = (prop, cmd) => {
    const ed = editingNode();
    if(ed){
      execCmd(cmd);
      ed.querySelector('.node-text')?.focus();
    } else {
      map.nodes[sel][prop] = !map.nodes[sel][prop];
      pushHistory(); render();
    }
  };
  const toggleList = (kind) => {
    const ed = editingNode();
    if(ed){
      // Selection-aware list: split the selection on <br>/newlines and turn
      // each line into its own <li>. We can't use the browser's built-in
      // execCommand here — Chrome/WebKit collapse multi-line selections into
      // a single <li>, which isn't what the user wants.
      applyListToSelection(kind);
      if(map.nodes[sel].listType) map.nodes[sel].listType = null;
      ed.querySelector('.node-text')?.focus();
    } else {
      // Whole-node toggle (legacy behaviour, kept for users who haven't entered edit mode)
      const cur = map.nodes[sel].listType;
      map.nodes[sel].listType = (cur===kind ? null : kind);
      pushHistory(); render();
    }
  };
  bar.querySelectorAll('button').forEach(b=>{
    b.onclick=(ev)=>{
      ev.stopPropagation();
      const a=b.dataset.a;
      if(a==='child') addNode(sel,false);
      else if(a==='sibling') addNode(sel,true);
      else if(a==='edit') startEdit(sel);
      else if(a==='del') deleteNode(sel);
      else if(a==='collapse'){ map.nodes[sel].collapsed=!map.nodes[sel].collapsed; pushHistory(); autoLayout(); }
      else if(a==='bold')      inlineOrToggle('bold',      'bold');
      else if(a==='italic')    inlineOrToggle('italic',    'italic');
      else if(a==='strike')    inlineOrToggle('strike',    'strikeThrough');
      else if(a==='underline') inlineOrToggle('underline', 'underline');
      else if(a==='ul') toggleList('ul');
      else if(a==='ol') toggleList('ol');
      else if(a==='notes') showNotesEditor(sel);
      else if(a==='task') cycleTask(sel);
      else if(a==='cite') showCitationForm(sel);
      else if(a==='image'){
        if(map.nodes[sel].image){
          if(confirm('Remove the attached image? (OK removes · Cancel lets you pick a new one)')){ delete map.nodes[sel].image; pushHistory(); render(); }
          else attachImageToNode(sel);
        } else attachImageToNode(sel);
      }
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

// Snapshot positions of `id` and all its descendants so the whole subtree
// can move together during a drag, then reset cleanly on cancel.
function beginSubtreeDrag(id, mx, my){
  const subtree={};
  const collect = i => {
    subtree[i] = { x: map.nodes[i].x, y: map.nodes[i].y };
    childrenOf(i).forEach(collect);
  };
  collect(id);
  return { mx, my, root:id, subtree };
}
// Apply (dx,dy) delta to the whole subtree captured in start.subtree.
function applySubtreeDelta(start, dx, dy){
  for(const id in start.subtree){
    const base = start.subtree[id];
    const n = map.nodes[id]; if(!n) continue;
    n.x = base.x + dx; n.y = base.y + dy;
    const el = document.querySelector(`.node[data-id="${id}"]`);
    if(el){ el.style.left = n.x+'px'; el.style.top = n.y+'px'; }
  }
}

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
  // The tree changed shape — re-tidy. Stable layout keeps every other branch
  // exactly where it was and just slots the moved subtree cleanly into its new
  // parent, guaranteeing nothing overlaps.
  pushHistory(); autoLayout();
  toast('Re-parented to "'+(map.nodes[newParentId].text||'…')+'"');
}
// Reposition an existing subtree to sit cleanly as a child of `parentId`,
// shifting the whole subtree rigidly (preserves its internal arrangement).
function placeReparentedSubtree(childId, parentId){
  const child=map.nodes[childId], parent=map.nodes[parentId];
  if(!child||!parent) return;
  const layout=map.layout||'balanced';
  const sibs=childrenOf(parentId).filter(c=>c!==childId && map.nodes[c].side===child.side);
  const cw=child.w||120, ch=child.h||40;
  let tx, ty;
  if(layout==='down'){
    const childY=parent.y+(parent.h||40)+DOWN_VGAP;
    if(sibs.length){
      let maxRight=-Infinity, y=childY;
      sibs.forEach(s=>{ const sn=map.nodes[s]; maxRight=Math.max(maxRight,sn.x+(sn.w||120)); y=sn.y; });
      tx=maxRight+DOWN_HGAP; ty=y;
    } else { tx=parent.x+((parent.w||120)-cw)/2; ty=childY; }
  } else {
    const dir=child.side==='left'?-1:1;
    if(sibs.length){
      let maxBottom=-Infinity, colX=null;
      sibs.forEach(s=>{ const sn=map.nodes[s]; const b=sn.y+(sn.h||40); if(b>maxBottom)maxBottom=b; colX=sn.x; });
      ty=maxBottom+VGAP;
      tx=(colX!=null)?colX:(dir>0?parent.x+(parent.w||120)+HGAP:parent.x-cw-HGAP);
    } else {
      tx=dir>0?parent.x+(parent.w||120)+HGAP:parent.x-cw-HGAP;
      ty=parent.y+((parent.h||40)-ch)/2;
    }
  }
  shiftSubtreeBy(childId, tx-child.x, ty-child.y);
}

stage.addEventListener('mousedown',e=>{
  // Don't intercept clicks on the chrome / overlay UI.
  if(e.target.closest('.topbar, .zoombar, .hint, .toast, .nodebar, .empty, .search-wrap, .save-pill, .tb-group, .side, .picker, .minimap, .breadcrumb')) return;
  const nodeEl=e.target.closest('.node');
  // If the click lands inside a node that's currently being edited, let
  // contentEditable handle it natively (text selection, cursor placement).
  // Stage MUST NOT start panning here — that would clear the selection and
  // tear down the format toolbar.
  if(nodeEl && nodeEl.classList.contains('editing')) return;
  if(nodeEl){
    const id=nodeEl.dataset.id;
    // Link mode: the next node click completes (or toggles) a cross-link
    if(linkMode && !e.shiftKey){
      completeLink(id);
      return;
    }
    // Re-parent mode: the next plain node click chooses the new parent
    if(reparentMode && !e.shiftKey){
      bulkReparent(id);
      return;
    }
    // Shift-click toggles multi-selection (no drag, keep primary sel intact)
    if(e.shiftKey){
      toggleMultiSelect(id);
      return;
    }
    // Normal click clears any multi-selection
    if(multiSel.size) clearMultiSelect();
    select(id,false);
    if(READONLY) return;          // view-only: allow selection, no dragging/editing
    dragNode=id; moved=false;
    dragStart=beginSubtreeDrag(id, e.clientX, e.clientY);
  } else {
    if(reparentMode){ reparentMode=false; hideBulkBar(); updateMultiSelUI(); }
    if(linkMode) cancelLinkMode();
    panning=true; panStart={x:e.clientX,y:e.clientY,vx:view.x,vy:view.y};
    if(sel){
      sel=null;
      document.querySelectorAll('.node.sel').forEach(n=>n.classList.remove('sel'));
      $('#nodebar')?.remove();
    }
    if(multiSel.size) clearMultiSelect();
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
    applySubtreeDelta(dragStart, dx, dy);
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
  if(resizing){
    resizing = null;
    // Re-tidy so the resized node's new footprint doesn't overlap its neighbours.
    autoLayout();
    pushHistory();
  }
  if(dragNode){
    if(dropTarget && dragNode!==map.rootId){
      reparent(dragNode, dropTarget);     // attach to the highlighted parent + tidy
    } else if(moved){
      // Dropped in empty space (no new parent). Standard mind-map behaviour:
      // snap the tree back into its clean, non-overlapping arrangement.
      autoLayout();
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
  if(t.target && t.target.closest && t.target.closest('.topbar, .zoombar, .hint, .toast, .nodebar, .empty, .search-wrap, .save-pill, .tb-group, .side, .picker, .notes-popup, .donate-modal, .theme-panel, .login-overlay, .user-pill, .minimap, .breadcrumb')) return;
  const nodeEl=t.target.closest?.('.node');
  // Don't pan / drag when tapping inside a node that's being edited —
  // contentEditable needs to handle the touch for caret placement and selection.
  if(nodeEl && nodeEl.classList.contains('editing')) return;
  if(nodeEl){
    const id=nodeEl.dataset.id;
    select(id,false);
    dragNode=id; moved=false;
    dragStart=beginSubtreeDrag(id, t.clientX, t.clientY);
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
    applySubtreeDelta(dragStart, dx, dy);
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
    if(dropTarget && dragNode!==map.rootId){ reparent(dragNode, dropTarget); }
    else if(moved){ autoLayout(); pushHistory(); }
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
  const cw=Math.max(1,maxx-minx), ch=Math.max(1,maxy-miny);
  // Scale the map's bounding box to fit the viewport with a margin. Cap at 100%
  // so a tiny map isn't magnified; this is what makes a big map auto-shrink to
  // fit a smaller screen instead of overflowing at full size.
  const margin=64;
  const availW=Math.max(120, r.width  - margin*2);
  const availH=Math.max(120, r.height - margin*2);
  const k=Math.max(0.1, Math.min(availW/cw, availH/ch, 1));
  view.k=k;
  view.x=r.width/2  - (minx+cw/2)*k;
  view.y=r.height/2 - (miny+ch/2)*k;
  applyView();
}
// Centre the map's bounding box in the current stage viewport WITHOUT changing
// zoom — used when the viewport size changes (e.g. entering/leaving focus mode)
// so the map doesn't appear to jump sideways.
function recenter(){
  if(!map) return;
  const hidden=hiddenSet();
  let minx=Infinity,miny=Infinity,maxx=-Infinity,maxy=-Infinity;
  for(const id in map.nodes){
    if(hidden.has(id)) continue;
    const n=map.nodes[id];
    minx=Math.min(minx,n.x); miny=Math.min(miny,n.y);
    maxx=Math.max(maxx,n.x+(n.w||120)); maxy=Math.max(maxy,n.y+(n.h||40));
  }
  if(!isFinite(minx)) return;
  const r=stage.getBoundingClientRect();
  const cx=(minx+maxx)/2, cy=(miny+maxy)/2;
  view.x = r.width/2  - cx*view.k;
  view.y = r.height/2 - cy*view.k;
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
  else if(e.key==='l'||e.key==='L'){
    // Cross-link mode: remember the source, next node click links to it
    e.preventDefault();
    startLinkMode(sel);
  }
  else if(e.key==='Escape' && linkMode){
    e.preventDefault();
    cancelLinkMode();
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
function openSearch(withReplace){
  const w=$('#searchWrap');
  w.classList.add('open');
  if(withReplace) w.classList.add('replace-mode');
  $('#search').focus(); $('#search').select();
}
function closeSearch(){
  const w=$('#searchWrap');
  w.classList.remove('open','replace-mode','all-mode');
  $('#search').value=''; $('#replace').value='';
  $('#searchCount').textContent='';
  $('#allMapsToggle')?.classList.remove('on');
  globalSearchMode=false;
  hideGlobalResults();
  doSearch('');
}
let globalSearchMode=false;
$('#allMapsToggle')?.addEventListener('click', ()=>{
  globalSearchMode = !globalSearchMode;
  const w=$('#searchWrap');
  w.classList.toggle('all-mode', globalSearchMode);
  $('#allMapsToggle').classList.toggle('on', globalSearchMode);
  $('#search').placeholder = globalSearchMode ? 'Search ALL maps…' : 'Find in nodes…';
  $('#search').focus();
  if(globalSearchMode){ runGlobalSearch($('#search').value); }
  else { hideGlobalResults(); doSearch($('#search').value); }
});
$('#searchBtn').onclick=()=>{
  const w=$('#searchWrap');
  if(w.classList.contains('open')) closeSearch(); else openSearch(false);
};
$('#replaceToggle').onclick=()=>{ $('#searchWrap').classList.toggle('replace-mode'); $('#replace').focus(); };
$('#search').addEventListener('input',e=>{ if(globalSearchMode) runGlobalSearch(e.target.value); else doSearch(e.target.value); });
$('#search').addEventListener('keydown',e=>{
  if(e.key==='Escape'){ e.preventDefault(); closeSearch(); }
  if(e.key==='Enter'){ e.preventDefault(); focusNextMatch(); }
});
$('#replace').addEventListener('keydown',e=>{
  if(e.key==='Escape'){ e.preventDefault(); closeSearch(); }
  if(e.key==='Enter'){ e.preventDefault(); e.shiftKey ? replaceAll() : replaceNext(); }
});
$('#replaceOne').onclick=replaceNext;
$('#replaceAll').onclick=replaceAll;

// Global shortcuts: Ctrl/⌘+F opens find, Ctrl/⌘+H opens find+replace.
// Registered separately so they fire even when a node is being edited.
window.addEventListener('keydown', e=>{
  if(!(e.ctrlKey||e.metaKey)) return;
  const k = e.key.toLowerCase();
  if(k === 'f'){
    e.preventDefault();
    // If we're editing a node, commit it first so search can highlight cleanly
    document.querySelector('.node.editing .node-text')?.blur();
    openSearch(false);
  } else if(k === 'h'){
    e.preventDefault();
    document.querySelector('.node.editing .node-text')?.blur();
    openSearch(true);
  }
}, true);  // capture phase — beat the browser's native find on Ctrl/⌘+F

let searchMatches=[], searchPos=-1;
function doSearch(q){
  q=q.trim().toLowerCase();
  searchMatches=[]; searchPos=-1;
  document.querySelectorAll('.node').forEach(el=>{
    el.classList.remove('dim','match','match-current');
    if(!q)return;
    const raw = map.nodes[el.dataset.id].text || '';
    const plain = INLINE_HTML_RE.test(raw) ? nodeTextPlain(raw) : raw;
    if(plain.toLowerCase().includes(q)){ el.classList.add('match'); searchMatches.push(el.dataset.id); }
    else el.classList.add('dim');
  });
  const cnt=$('#searchCount');
  if(cnt) cnt.textContent = q ? (searchMatches.length ? `${searchMatches.length} found` : 'none') : '';
}
function focusNextMatch(){
  if(!searchMatches.length) return;
  searchPos = (searchPos+1) % searchMatches.length;
  const id = searchMatches[searchPos];
  document.querySelectorAll('.node.match-current').forEach(n=>n.classList.remove('match-current'));
  const el=document.querySelector(`.node[data-id="${id}"]`);
  el?.classList.add('match-current');
  select(id,false);
  centreOn(id);
  $('#searchCount').textContent = `${searchPos+1} / ${searchMatches.length}`;
}
// Replace in a single node's text, HTML-aware (operates on the plain text, then
// re-stores; if the node had inline HTML we replace within text nodes only).
function replaceInNode(id, find, repl){
  const n=map.nodes[id]; if(!n) return 0;
  const flags='gi';
  const re=new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), flags);
  let count=0;
  if(INLINE_HTML_RE.test(n.text||'')){
    // Walk text nodes only, preserving tags
    const tmp=document.createElement('div'); tmp.innerHTML=n.text;
    const walker=document.createTreeWalker(tmp, NodeFilter.SHOW_TEXT);
    const texts=[]; let t; while((t=walker.nextNode())) texts.push(t);
    texts.forEach(tn=>{
      if(re.test(tn.nodeValue||'')){ re.lastIndex=0; tn.nodeValue=tn.nodeValue.replace(re, ()=>{count++;return repl;}); }
    });
    if(count) n.text=tmp.innerHTML;
  } else {
    const out=(n.text||'').replace(re, ()=>{count++; return repl;});
    if(count) n.text=out;
  }
  return count;
}
function replaceNext(){
  const find=$('#search').value.trim(); const repl=$('#replace').value;
  if(!find || !searchMatches.length) return;
  if(searchPos<0) searchPos=0;
  const id=searchMatches[searchPos] || searchMatches[0];
  const c=replaceInNode(id, find, repl);
  if(c){ pushHistory(); render(); toast(`Replaced ${c} in 1 node`); }
  doSearch(find);            // refresh matches (node may no longer match)
}
function replaceAll(){
  const find=$('#search').value.trim(); const repl=$('#replace').value;
  if(!find) return;
  let total=0, nodes=0;
  Object.keys(map.nodes).forEach(id=>{ const c=replaceInNode(id, find, repl); if(c){ total+=c; nodes++; } });
  if(total){ pushHistory(); render(); toast(`Replaced ${total} occurrence${total>1?'s':''} in ${nodes} node${nodes>1?'s':''}`); }
  else toast('No matches to replace');
  doSearch(find);
}
// Centre the viewport on a node (used by find-next)
function centreOn(id){
  const n=map.nodes[id]; if(!n) return;
  const r=stage.getBoundingClientRect();
  view.x = r.width/2 - (n.x + (n.w||120)/2)*view.k;
  view.y = r.height/2 - (n.y + (n.h||40)/2)*view.k;
  applyView();
}

/* ============================================================
   MINIMAP — scaled overview, click to jump
   ============================================================ */
const MM_W=168, MM_H=120;
function updateMinimap(){
  const mm=$('#minimap'); if(!mm) return;
  if(!map){ mm.innerHTML=''; mm._t=null; mm.style.display='none'; return; }
  const hidden=hiddenSet();
  const ids=Object.keys(map.nodes).filter(id=>!hidden.has(id));
  if(!ids.length){ mm.innerHTML=''; mm._t=null; mm.style.display='none'; return; }
  mm.style.display='';
  let minx=Infinity,miny=Infinity,maxx=-Infinity,maxy=-Infinity;
  ids.forEach(id=>{ const n=map.nodes[id];
    minx=Math.min(minx,n.x); miny=Math.min(miny,n.y);
    maxx=Math.max(maxx,n.x+(n.w||120)); maxy=Math.max(maxy,n.y+(n.h||40));
  });
  const pad=24; minx-=pad; miny-=pad; maxx+=pad; maxy+=pad;
  const cw=Math.max(1,maxx-minx), ch=Math.max(1,maxy-miny);
  const scale=Math.min(MM_W/cw, MM_H/ch);
  const ox=(MM_W-cw*scale)/2, oy=(MM_H-ch*scale)/2;
  mm._t={minx,miny,scale,ox,oy};
  const rects=ids.map(id=>{
    const n=map.nodes[id];
    const x=ox+(n.x-minx)*scale, y=oy+(n.y-miny)*scale;
    const w=Math.max(2,(n.w||120)*scale), h=Math.max(2,(n.h||40)*scale);
    const col = id===map.rootId ? (map.color||'#e0613a')
      : (n.color && n.color!=='#fff' && n.color!=='#ffffff') ? n.color : 'var(--line-2)';
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="${col}" ${id===sel?'class="mm-sel"':''}/>`;
  }).join('');
  mm.innerHTML=`<svg viewBox="0 0 ${MM_W} ${MM_H}" width="${MM_W}" height="${MM_H}">${rects}<rect id="mmView" fill="none"/></svg>`;
  updateMinimapViewport();
}
function updateMinimapViewport(){
  const mm=$('#minimap'); if(!mm||!mm._t) return;
  const v=mm.querySelector('#mmView'); if(!v) return;
  const {minx,miny,scale,ox,oy}=mm._t;
  const r=stage.getBoundingClientRect();
  const wx=-view.x/view.k, wy=-view.y/view.k, ww=r.width/view.k, wh=r.height/view.k;
  v.setAttribute('x',(ox+(wx-minx)*scale).toFixed(1));
  v.setAttribute('y',(oy+(wy-miny)*scale).toFixed(1));
  v.setAttribute('width', Math.max(4,ww*scale).toFixed(1));
  v.setAttribute('height',Math.max(4,wh*scale).toFixed(1));
}
function minimapJump(clientX, clientY){
  const mm=$('#minimap'); if(!mm||!mm._t) return;
  const rect=mm.getBoundingClientRect();
  const {minx,miny,scale,ox,oy}=mm._t;
  const wx=minx+((clientX-rect.left)-ox)/scale;
  const wy=miny+((clientY-rect.top)-oy)/scale;
  const r=stage.getBoundingClientRect();
  view.x=r.width/2 - wx*view.k;
  view.y=r.height/2 - wy*view.k;
  applyView();
}

/* ============================================================
   BREADCRUMB — clickable path from root to the selected node
   ============================================================ */
function updateBreadcrumb(){
  const bc=$('#breadcrumb'); if(!bc) return;
  if(!map || !sel || !map.nodes[sel]){ bc.style.display='none'; return; }
  const path=[]; let cur=sel, guard=0;
  while(cur && guard++<200){ path.unshift(cur); cur=map.nodes[cur]?.parent; }
  if(path.length<=1){ bc.style.display='none'; return; }   // nothing to show at the root
  bc.style.display='flex';
  bc.innerHTML=path.map((id,i)=>{
    const label=nodeTextPlain(map.nodes[id].text||'')||'(untitled)';
    const short=label.length>22 ? label.slice(0,22)+'…' : label;
    const crumb=`<button class="bc-crumb${id===sel?' current':''}" data-id="${id}" title="${escapeHtml(label)}">${escapeHtml(short)}</button>`;
    return crumb + (i<path.length-1 ? '<span class="bc-sep">›</span>' : '');
  }).join('');
  bc.querySelectorAll('.bc-crumb').forEach(b=>b.onclick=()=>{ select(b.dataset.id,false); centreOn(b.dataset.id); });
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
    el.innerHTML=`<span class="dot" style="background:${m.color||'#e0613a'}"></span><span class="nm">${escapeHtml(m.title||'Untitled')}</span><button class="dup" title="Duplicate">⎘</button><button class="x" title="Delete">×</button>`;
    el.querySelector('.nm').onclick=()=>loadMap(m.id);
    el.querySelector('.dot').onclick=()=>loadMap(m.id);
    el.querySelector('.dup').onclick=ev=>{ ev.stopPropagation(); duplicateMap(m.id); };
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
      if(c==='h1'||c==='h2'){ execCmd('formatBlock', '<'+c+'>'); }
      else if(c==='createLink'){
        const url=prompt('Enter URL (https://…):'); if(url) execCmd('createLink',url);
      }
      else { execCmd(c); }
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

/* ============================================================
   PROMPT TEMPLATES — pre-seeded mind-map structures for common
   LLM prompt patterns. Each template is a flat list of nodes
   referencing each other by a temporary key; we'll assign real
   ids when seeding.
   ============================================================ */
const TEMPLATES = {
  rtcce: {
    name: 'Role / Task / Context / Constraints / Examples',
    desc: 'Classic structured prompt — the bread-and-butter shape',
    color: '#5b8db2', group:'prompt', icon:'⊟',
    nodes: [
      { k:'root', text:'Prompt: [your task]' },
      { k:'r',   parent:'root', text:'Role' },
      { k:'r1',  parent:'r',    text:'You are a senior …' },
      { k:'t',   parent:'root', text:'Task' },
      { k:'t1',  parent:'t',    text:'[describe what to do]' },
      { k:'c',   parent:'root', text:'Context' },
      { k:'c1',  parent:'c',    text:'[background information]' },
      { k:'cn',  parent:'root', text:'Constraints' },
      { k:'cn1', parent:'cn',   text:'[what to avoid / formatting rules]' },
      { k:'e',   parent:'root', text:'Examples' },
      { k:'e1',  parent:'e',    text:'[input / expected output]' }
    ]
  },
  cot: {
    name: 'Chain-of-Thought',
    desc: 'Step-by-step reasoning prompt',
    color: '#6a8c3f', group:'prompt', icon:'⟶',
    nodes: [
      { k:'root', text:'Reasoning prompt' },
      { k:'q',   parent:'root', text:'Question' },
      { k:'q1',  parent:'q',    text:'[the question to solve]' },
      { k:'a',   parent:'root', text:'Approach' },
      { k:'a1',  parent:'a',    text:'Think step by step.' },
      { k:'a2',  parent:'a',    text:'Identify the sub-problems.' },
      { k:'a3',  parent:'a',    text:'Solve each sub-problem in order.' },
      { k:'a4',  parent:'a',    text:'Combine into a final answer.' },
      { k:'o',   parent:'root', text:'Output format' },
      { k:'o1',  parent:'o',    text:'Show your reasoning, then the final answer in <answer> tags.' }
    ]
  },
  fc: {
    name: 'Function-calling schema',
    desc: 'Tool / function definition outline',
    color: '#8c5da7', group:'prompt', icon:'ƒ',
    nodes: [
      { k:'root', text:'function_name' },
      { k:'d',   parent:'root', text:'Description' },
      { k:'d1',  parent:'d',    text:'[what this function does, when to call it]' },
      { k:'p',   parent:'root', text:'Parameters' },
      { k:'p1',  parent:'p',    text:'param_a (string, required)' },
      { k:'p2',  parent:'p',    text:'param_b (number, optional)' },
      { k:'p3',  parent:'p',    text:'param_c (enum: a | b | c)' },
      { k:'r',   parent:'root', text:'Returns' },
      { k:'r1',  parent:'r',    text:'[shape of the return value]' },
      { k:'e',   parent:'root', text:'Error modes' },
      { k:'e1',  parent:'e',    text:'[when it fails, what it returns]' }
    ]
  },
  fewshot: {
    name: 'Few-shot examples',
    desc: 'Pattern-by-example prompt',
    color: '#c2783c', group:'prompt', icon:'≡',
    nodes: [
      { k:'root', text:'Few-shot prompt' },
      { k:'i',   parent:'root', text:'Instructions' },
      { k:'i1',  parent:'i',    text:'[what to do, format, tone]' },
      { k:'x1',  parent:'root', text:'Example 1' },
      { k:'x1a', parent:'x1',   text:'Input: …' },
      { k:'x1b', parent:'x1',   text:'Output: …' },
      { k:'x2',  parent:'root', text:'Example 2' },
      { k:'x2a', parent:'x2',   text:'Input: …' },
      { k:'x2b', parent:'x2',   text:'Output: …' },
      { k:'q',   parent:'root', text:'Now your turn' },
      { k:'q1',  parent:'q',    text:'Input: [your real input]' }
    ]
  },

  /* ===== Research & academic writing ===== */
  imrad: {
    name: 'Research paper (IMRaD)',
    desc: 'Standard empirical paper skeleton',
    color: '#3a6ea5', group:'research', icon:'📄',
    nodes: [
      { k:'root', text:'Paper title' },
      { k:'ab',  parent:'root', text:'Abstract' },
      { k:'ab1', parent:'ab',   text:'Background' },
      { k:'ab2', parent:'ab',   text:'Methods' },
      { k:'ab3', parent:'ab',   text:'Results' },
      { k:'ab4', parent:'ab',   text:'Conclusion' },
      { k:'in',  parent:'root', text:'Introduction' },
      { k:'in1', parent:'in',   text:'Problem & motivation' },
      { k:'in2', parent:'in',   text:'Gap in the literature' },
      { k:'in3', parent:'in',   text:'Our contribution' },
      { k:'in4', parent:'in',   text:'Paper roadmap' },
      { k:'rw',  parent:'root', text:'Related work' },
      { k:'rw1', parent:'rw',   text:'Theme A' },
      { k:'rw2', parent:'rw',   text:'Theme B' },
      { k:'rw3', parent:'rw',   text:'How we differ' },
      { k:'me',  parent:'root', text:'Methodology' },
      { k:'me1', parent:'me',   text:'Setup' },
      { k:'me2', parent:'me',   text:'Data / dataset' },
      { k:'me3', parent:'me',   text:'Approach' },
      { k:'me4', parent:'me',   text:'Baselines' },
      { k:'re',  parent:'root', text:'Results' },
      { k:'re1', parent:'re',   text:'Main findings' },
      { k:'re2', parent:'re',   text:'Tables & figures' },
      { k:'re3', parent:'re',   text:'Ablations' },
      { k:'di',  parent:'root', text:'Discussion' },
      { k:'di1', parent:'di',   text:'Interpretation' },
      { k:'di2', parent:'di',   text:'Comparison to prior work' },
      { k:'di3', parent:'di',   text:'Limitations' },
      { k:'co',  parent:'root', text:'Conclusion' },
      { k:'co1', parent:'co',   text:'Summary' },
      { k:'co2', parent:'co',   text:'Future work' },
      { k:'rf',  parent:'root', text:'References' }
    ]
  },
  rebuttal: {
    name: 'Reviewer response / rebuttal',
    desc: 'Point-by-point reply for paper revisions',
    color: '#b8451f', group:'research', icon:'✍',
    nodes: [
      { k:'root', text:'Response to reviewers' },
      { k:'su',  parent:'root', text:'Summary of changes' },
      { k:'r1',  parent:'root', text:'Reviewer 1' },
      { k:'r1a', parent:'r1',   text:'Concern 1' },
      { k:'r1a1',parent:'r1a',  text:'Response' },
      { k:'r1a2',parent:'r1a',  text:'Edit made →' },
      { k:'r1b', parent:'r1',   text:'Concern 2' },
      { k:'r1b1',parent:'r1b',  text:'Response' },
      { k:'r2',  parent:'root', text:'Reviewer 2' },
      { k:'r2a', parent:'r2',   text:'Concern 1' },
      { k:'r2a1',parent:'r2a',  text:'Response' },
      { k:'r3',  parent:'root', text:'Reviewer 3' },
      { k:'r3a', parent:'r3',   text:'Concern 1' },
      { k:'r3a1',parent:'r3a',  text:'Response' },
      { k:'ne',  parent:'root', text:'New experiments added' },
      { k:'op',  parent:'root', text:'Open items' }
    ]
  },
  litreview: {
    name: 'Literature review synthesis',
    desc: 'Turn a pile of papers into structure',
    color: '#2f6f6a', group:'research', icon:'📚',
    nodes: [
      { k:'root', text:'Topic' },
      { k:'se',  parent:'root', text:'Seminal works' },
      { k:'cl',  parent:'root', text:'Theme clusters' },
      { k:'cl1', parent:'cl',   text:'Cluster 1 — key claim' },
      { k:'cl2', parent:'cl',   text:'Cluster 2 — key claim' },
      { k:'cl3', parent:'cl',   text:'Cluster 3 — key claim' },
      { k:'ml',  parent:'root', text:'Methods landscape' },
      { k:'gp',  parent:'root', text:'Gaps & open problems' },
      { k:'cn',  parent:'root', text:'Contradictions in the field' },
      { k:'po',  parent:'root', text:'My positioning / contribution' }
    ]
  },
  proposal: {
    name: 'Research proposal',
    desc: 'Grant, fellowship, or project scoping',
    color: '#8c5da7', group:'research', icon:'🎯',
    nodes: [
      { k:'root', text:'Proposal' },
      { k:'ps',  parent:'root', text:'Problem statement' },
      { k:'mo',  parent:'root', text:'Motivation & significance' },
      { k:'rq',  parent:'root', text:'Research questions / hypotheses' },
      { k:'ob',  parent:'root', text:'Objectives' },
      { k:'ob1', parent:'ob',   text:'Aim 1' },
      { k:'ob2', parent:'ob',   text:'Aim 2' },
      { k:'ob3', parent:'ob',   text:'Aim 3' },
      { k:'me',  parent:'root', text:'Methodology' },
      { k:'tl',  parent:'root', text:'Timeline & milestones' },
      { k:'eo',  parent:'root', text:'Expected outcomes' },
      { k:'rk',  parent:'root', text:'Risks & mitigations' }
    ]
  },
  experiment: {
    name: 'Experiment design',
    desc: 'Plan a study before you run it',
    color: '#6a8c3f', group:'research', icon:'🧪',
    nodes: [
      { k:'root', text:'Experiment' },
      { k:'hy',  parent:'root', text:'Hypothesis' },
      { k:'va',  parent:'root', text:'Variables' },
      { k:'va1', parent:'va',   text:'Independent' },
      { k:'va2', parent:'va',   text:'Dependent' },
      { k:'va3', parent:'va',   text:'Controlled' },
      { k:'st',  parent:'root', text:'Setup / apparatus' },
      { k:'pr',  parent:'root', text:'Procedure' },
      { k:'pr1', parent:'pr',   text:'Step 1' },
      { k:'pr2', parent:'pr',   text:'Step 2' },
      { k:'pr3', parent:'pr',   text:'Step 3' },
      { k:'dc',  parent:'root', text:'Data collection' },
      { k:'an',  parent:'root', text:'Analysis plan' },
      { k:'tv',  parent:'root', text:'Threats to validity' }
    ]
  },
  thesis: {
    name: 'Thesis / multi-paper arc',
    desc: 'How separate papers compose into a dissertation',
    color: '#c98a1a', group:'research', icon:'🎓',
    nodes: [
      { k:'root', text:'Central thesis contribution' },
      { k:'p1',  parent:'root', text:'Paper 1' },
      { k:'p1a', parent:'p1',   text:'Research question' },
      { k:'p1b', parent:'p1',   text:'Contribution' },
      { k:'p1c', parent:'p1',   text:'Venue & status' },
      { k:'p2',  parent:'root', text:'Paper 2' },
      { k:'p2a', parent:'p2',   text:'Research question' },
      { k:'p2b', parent:'p2',   text:'Contribution' },
      { k:'p3',  parent:'root', text:'Paper 3' },
      { k:'p3a', parent:'p3',   text:'Research question' },
      { k:'p3b', parent:'p3',   text:'Contribution' },
      { k:'ct',  parent:'root', text:'Cross-cutting theme' },
      { k:'gp',  parent:'root', text:'Gaps still to fill' },
      { k:'ch',  parent:'root', text:'Thesis chapter mapping' }
    ]
  },
  prisma: {
    name: 'Systematic review (PRISMA)',
    desc: 'Formal screening-based review',
    color: '#5b8db2', group:'research', icon:'🔍',
    nodes: [
      { k:'root', text:'Systematic review' },
      { k:'rq',  parent:'root', text:'Research questions' },
      { k:'ss',  parent:'root', text:'Search strategy' },
      { k:'ss1', parent:'ss',   text:'Databases' },
      { k:'ss2', parent:'ss',   text:'Keywords' },
      { k:'ss3', parent:'ss',   text:'Date range' },
      { k:'ic',  parent:'root', text:'Inclusion / exclusion criteria' },
      { k:'sc',  parent:'root', text:'Screening' },
      { k:'sc1', parent:'sc',   text:'Identified' },
      { k:'sc2', parent:'sc',   text:'Screened' },
      { k:'sc3', parent:'sc',   text:'Eligible' },
      { k:'sc4', parent:'sc',   text:'Included' },
      { k:'de',  parent:'root', text:'Data extraction fields' },
      { k:'sy',  parent:'root', text:'Synthesis' },
      { k:'qa',  parent:'root', text:'Quality assessment' }
    ]
  },
  talk: {
    name: 'Conference talk outline',
    desc: 'Structure a research presentation',
    color: '#c2783c', group:'research', icon:'🎤',
    nodes: [
      { k:'root', text:'Talk title' },
      { k:'ho',  parent:'root', text:'Hook' },
      { k:'pr',  parent:'root', text:'Problem' },
      { k:'id',  parent:'root', text:'One key idea' },
      { k:'rh',  parent:'root', text:'Result highlights' },
      { k:'rh1', parent:'rh',   text:'Result 1' },
      { k:'rh2', parent:'rh',   text:'Result 2' },
      { k:'ta',  parent:'root', text:'Takeaway' },
      { k:'bk',  parent:'root', text:'Backup slides' }
    ]
  },
  finer: {
    name: 'Research question (FINER)',
    desc: 'Pressure-test a question before committing',
    color: '#2f6f6a', group:'research', icon:'❓',
    nodes: [
      { k:'root', text:'Research question' },
      { k:'f',  parent:'root', text:'Feasible' },
      { k:'f1', parent:'f',    text:'Time, data, skills, funding?' },
      { k:'i',  parent:'root', text:'Interesting' },
      { k:'i1', parent:'i',    text:'Does the field care?' },
      { k:'n',  parent:'root', text:'Novel' },
      { k:'n1', parent:'n',    text:'What does it add that is new?' },
      { k:'e',  parent:'root', text:'Ethical' },
      { k:'e1', parent:'e',    text:'Approvals / consent / risks?' },
      { k:'r',  parent:'root', text:'Relevant' },
      { k:'r1', parent:'r',    text:'Impact on theory or practice?' }
    ]
  },

  /* ===== Students & educators ===== */
  study_revision: {
    name:'Study / revision map', desc:'Organize a topic for exams', color:'#6a8c3f', group:'study', icon:'📖',
    nodes:[
      { k:'root', text:'Topic' },
      { k:'kc', parent:'root', text:'Key concepts' },
      { k:'df', parent:'root', text:'Definitions' },
      { k:'ex', parent:'root', text:'Examples' },
      { k:'fm', parent:'root', text:'Formulas / rules' },
      { k:'mi', parent:'root', text:'Common mistakes' },
      { k:'eq', parent:'root', text:'Exam questions' },
      { k:'eq1',parent:'eq',   text:'Likely question 1' },
      { k:'eq2',parent:'eq',   text:'Likely question 2' }
    ]
  },
  essay_plan: {
    name:'Essay planner', desc:'Thesis, arguments, evidence', color:'#3a6ea5', group:'study', icon:'✏',
    nodes:[
      { k:'root', text:'Essay question' },
      { k:'th', parent:'root', text:'Thesis statement' },
      { k:'a1', parent:'root', text:'Argument 1' },
      { k:'a1e',parent:'a1',   text:'Evidence' },
      { k:'a2', parent:'root', text:'Argument 2' },
      { k:'a2e',parent:'a2',   text:'Evidence' },
      { k:'a3', parent:'root', text:'Argument 3' },
      { k:'a3e',parent:'a3',   text:'Evidence' },
      { k:'ca', parent:'root', text:'Counterargument' },
      { k:'cr', parent:'ca',   text:'Rebuttal' },
      { k:'co', parent:'root', text:'Conclusion' }
    ]
  },
  lesson_plan: {
    name:'Lesson plan', desc:'For teachers & instructors', color:'#c2783c', group:'study', icon:'🍎',
    nodes:[
      { k:'root', text:'Lesson title' },
      { k:'ob', parent:'root', text:'Learning objectives' },
      { k:'pk', parent:'root', text:'Prior knowledge' },
      { k:'ma', parent:'root', text:'Materials' },
      { k:'ac', parent:'root', text:'Activities' },
      { k:'ac1',parent:'ac',   text:'Warm-up' },
      { k:'ac2',parent:'ac',   text:'Main activity' },
      { k:'ac3',parent:'ac',   text:'Wrap-up' },
      { k:'as', parent:'root', text:'Assessment' },
      { k:'hw', parent:'root', text:'Homework' }
    ]
  },
  cornell: {
    name:'Cornell notes', desc:'Cues, notes, summary', color:'#2f6f6a', group:'study', icon:'🗒',
    nodes:[
      { k:'root', text:'Lecture / chapter' },
      { k:'cu', parent:'root', text:'Cues / questions' },
      { k:'cu1',parent:'cu',   text:'Cue 1' },
      { k:'cu2',parent:'cu',   text:'Cue 2' },
      { k:'no', parent:'root', text:'Notes' },
      { k:'no1',parent:'no',   text:'Main point 1' },
      { k:'no2',parent:'no',   text:'Main point 2' },
      { k:'su', parent:'root', text:'Summary' }
    ]
  },

  /* ===== Software & technical ===== */
  architecture: {
    name:'System architecture', desc:'Services, data, dependencies', color:'#8c5da7', group:'software', icon:'🧩',
    nodes:[
      { k:'root', text:'System name' },
      { k:'cl', parent:'root', text:'Clients' },
      { k:'sv', parent:'root', text:'Services' },
      { k:'sv1',parent:'sv',   text:'Service A' },
      { k:'sv2',parent:'sv',   text:'Service B' },
      { k:'ds', parent:'root', text:'Data stores' },
      { k:'ds1',parent:'ds',   text:'Database' },
      { k:'ds2',parent:'ds',   text:'Cache' },
      { k:'ap', parent:'root', text:'External APIs' },
      { k:'in', parent:'root', text:'Infra / deployment' }
    ]
  },
  sprint: {
    name:'Sprint / feature plan', desc:'Epic → stories → tasks', color:'#3a6ea5', group:'software', icon:'🏃',
    nodes:[
      { k:'root', text:'Epic' },
      { k:'s1', parent:'root', text:'User story 1' },
      { k:'s1t',parent:'s1',   text:'Tasks' },
      { k:'s1a',parent:'s1',   text:'Acceptance criteria' },
      { k:'s2', parent:'root', text:'User story 2' },
      { k:'s2t',parent:'s2',   text:'Tasks' },
      { k:'s2a',parent:'s2',   text:'Acceptance criteria' },
      { k:'de', parent:'root', text:'Definition of done' },
      { k:'ri', parent:'root', text:'Risks / blockers' }
    ]
  },
  postmortem: {
    name:'Incident post-mortem', desc:'Blameless RCA structure', color:'#b8451f', group:'software', icon:'🚨',
    nodes:[
      { k:'root', text:'Incident summary' },
      { k:'tl', parent:'root', text:'Timeline' },
      { k:'tl1',parent:'tl',   text:'Detection' },
      { k:'tl2',parent:'tl',   text:'Response' },
      { k:'tl3',parent:'tl',   text:'Resolution' },
      { k:'im', parent:'root', text:'Impact' },
      { k:'rc', parent:'root', text:'Root cause' },
      { k:'wt', parent:'root', text:'What went well' },
      { k:'ai', parent:'root', text:'Action items' }
    ]
  },
  rfc: {
    name:'Design doc / RFC', desc:'Technical proposal outline', color:'#2f6f6a', group:'software', icon:'📐',
    nodes:[
      { k:'root', text:'RFC title' },
      { k:'co', parent:'root', text:'Context & problem' },
      { k:'go', parent:'root', text:'Goals' },
      { k:'ng', parent:'root', text:'Non-goals' },
      { k:'pr', parent:'root', text:'Proposed design' },
      { k:'al', parent:'root', text:'Alternatives considered' },
      { k:'ri', parent:'root', text:'Risks & trade-offs' },
      { k:'ro', parent:'root', text:'Rollout plan' }
    ]
  },
  ddd: {
    name:'Domain-Driven Design', desc:'Bounded contexts, aggregates, events', color:'#3a6ea5', group:'software', icon:'🧱',
    nodes:[
      { k:'root', text:'Domain' },
      { k:'ul',  parent:'root', text:'Ubiquitous language' },
      { k:'ul1', parent:'ul',   text:'Key term → definition' },
      { k:'bc',  parent:'root', text:'Bounded contexts' },
      { k:'bc1', parent:'bc',   text:'Context A' },
      { k:'bc2', parent:'bc',   text:'Context B' },
      { k:'cm',  parent:'root', text:'Context map' },
      { k:'cm1', parent:'cm',   text:'Relationships (ACL, conformist, …)' },
      { k:'ag',  parent:'root', text:'Aggregates' },
      { k:'ag1', parent:'ag',   text:'Aggregate root' },
      { k:'ag2', parent:'ag',   text:'Invariants / consistency rules' },
      { k:'en',  parent:'root', text:'Entities' },
      { k:'vo',  parent:'root', text:'Value objects' },
      { k:'de',  parent:'root', text:'Domain events' },
      { k:'de1', parent:'de',   text:'Event → handler' },
      { k:'re',  parent:'root', text:'Repositories' },
      { k:'sv',  parent:'root', text:'Domain services' },
      { k:'as',  parent:'root', text:'Application services / use cases' }
    ]
  },

  /* ===== Product & founders ===== */
  prd: {
    name:'PRD (product requirements)', desc:'Problem, users, features, metrics', color:'#c2783c', group:'product', icon:'📝',
    nodes:[
      { k:'root', text:'Product / feature' },
      { k:'pb', parent:'root', text:'Problem' },
      { k:'us', parent:'root', text:'Target users' },
      { k:'go', parent:'root', text:'Goals' },
      { k:'ft', parent:'root', text:'Features' },
      { k:'ft1',parent:'ft',   text:'Must-have' },
      { k:'ft2',parent:'ft',   text:'Nice-to-have' },
      { k:'me', parent:'root', text:'Success metrics' },
      { k:'ri', parent:'root', text:'Risks & open questions' }
    ]
  },
  okr: {
    name:'OKRs', desc:'Objectives & key results', color:'#3a6ea5', group:'product', icon:'🎯',
    nodes:[
      { k:'root', text:'Quarter / theme' },
      { k:'o1', parent:'root', text:'Objective 1' },
      { k:'o1a',parent:'o1',   text:'Key result 1' },
      { k:'o1b',parent:'o1',   text:'Key result 2' },
      { k:'o1c',parent:'o1',   text:'Initiatives' },
      { k:'o2', parent:'root', text:'Objective 2' },
      { k:'o2a',parent:'o2',   text:'Key result 1' },
      { k:'o2b',parent:'o2',   text:'Key result 2' }
    ]
  },
  persona: {
    name:'User persona', desc:'Who you are building for', color:'#8c5da7', group:'product', icon:'👤',
    nodes:[
      { k:'root', text:'Persona name' },
      { k:'bg', parent:'root', text:'Background' },
      { k:'go', parent:'root', text:'Goals' },
      { k:'pa', parent:'root', text:'Pain points' },
      { k:'mo', parent:'root', text:'Motivations' },
      { k:'be', parent:'root', text:'Behaviors' },
      { k:'qu', parent:'root', text:'Favorite quote' }
    ]
  },
  gtm: {
    name:'Go-to-market plan', desc:'Launch & growth strategy', color:'#6a8c3f', group:'product', icon:'📣',
    nodes:[
      { k:'root', text:'Product launch' },
      { k:'ta', parent:'root', text:'Target market' },
      { k:'po', parent:'root', text:'Positioning' },
      { k:'pr', parent:'root', text:'Pricing' },
      { k:'ch', parent:'root', text:'Channels' },
      { k:'ms', parent:'root', text:'Messaging' },
      { k:'me', parent:'root', text:'Metrics' }
    ]
  },

  /* ===== Writers & creators ===== */
  novel: {
    name:'Novel / story plan', desc:'Premise, characters, plot, themes', color:'#b8451f', group:'writing', icon:'📕',
    nodes:[
      { k:'root', text:'Story title' },
      { k:'pr', parent:'root', text:'Premise' },
      { k:'ch', parent:'root', text:'Characters' },
      { k:'ch1',parent:'ch',   text:'Protagonist' },
      { k:'ch2',parent:'ch',   text:'Antagonist' },
      { k:'pl', parent:'root', text:'Plot arcs' },
      { k:'pl1',parent:'pl',   text:'Beginning' },
      { k:'pl2',parent:'pl',   text:'Middle' },
      { k:'pl3',parent:'pl',   text:'End' },
      { k:'se', parent:'root', text:'Setting' },
      { k:'th', parent:'root', text:'Themes' }
    ]
  },
  three_act: {
    name:'Three-act structure', desc:'Classic screenplay shape', color:'#c2783c', group:'writing', icon:'🎬',
    nodes:[
      { k:'root', text:'Story' },
      { k:'a1', parent:'root', text:'Act I — Setup' },
      { k:'a1a',parent:'a1',   text:'Inciting incident' },
      { k:'a1b',parent:'a1',   text:'Plot point 1' },
      { k:'a2', parent:'root', text:'Act II — Confrontation' },
      { k:'a2a',parent:'a2',   text:'Midpoint' },
      { k:'a2b',parent:'a2',   text:'Plot point 2' },
      { k:'a3', parent:'root', text:'Act III — Resolution' },
      { k:'a3a',parent:'a3',   text:'Climax' },
      { k:'a3b',parent:'a3',   text:'Denouement' }
    ]
  },
  article: {
    name:'Article / blog outline', desc:'Hook, sections, takeaways', color:'#2f6f6a', group:'writing', icon:'🖊',
    nodes:[
      { k:'root', text:'Article title' },
      { k:'ho', parent:'root', text:'Hook / intro' },
      { k:'s1', parent:'root', text:'Section 1' },
      { k:'s2', parent:'root', text:'Section 2' },
      { k:'s3', parent:'root', text:'Section 3' },
      { k:'ta', parent:'root', text:'Key takeaways' },
      { k:'cta',parent:'root', text:'Call to action' }
    ]
  },
  video_script: {
    name:'Video / podcast script', desc:'For YouTube & shows', color:'#8c5da7', group:'writing', icon:'🎙',
    nodes:[
      { k:'root', text:'Episode title' },
      { k:'ho', parent:'root', text:'Hook (first 10s)' },
      { k:'in', parent:'root', text:'Intro' },
      { k:'se', parent:'root', text:'Segments' },
      { k:'se1',parent:'se',   text:'Segment 1' },
      { k:'se2',parent:'se',   text:'Segment 2' },
      { k:'cta',parent:'root', text:'Call to action' },
      { k:'ou', parent:'root', text:'Outro' }
    ]
  },

  /* ===== Project management ===== */
  charter: {
    name:'Project charter', desc:'Scope, stakeholders, deliverables', color:'#2f6f6a', group:'pm', icon:'📜',
    nodes:[
      { k:'root', text:'Project name' },
      { k:'sc', parent:'root', text:'Scope' },
      { k:'ob', parent:'root', text:'Objectives' },
      { k:'st', parent:'root', text:'Stakeholders' },
      { k:'de', parent:'root', text:'Deliverables' },
      { k:'tl', parent:'root', text:'Timeline' },
      { k:'bu', parent:'root', text:'Budget' },
      { k:'ri', parent:'root', text:'Risks' }
    ]
  },
  wbs: {
    name:'Work breakdown structure', desc:'Phases → tasks → subtasks', color:'#3a6ea5', group:'pm', icon:'🗂',
    nodes:[
      { k:'root', text:'Project' },
      { k:'p1', parent:'root', text:'Phase 1' },
      { k:'p1a',parent:'p1',   text:'Task 1.1' },
      { k:'p1b',parent:'p1',   text:'Task 1.2' },
      { k:'p2', parent:'root', text:'Phase 2' },
      { k:'p2a',parent:'p2',   text:'Task 2.1' },
      { k:'p2b',parent:'p2',   text:'Task 2.2' },
      { k:'p3', parent:'root', text:'Phase 3' },
      { k:'p3a',parent:'p3',   text:'Task 3.1' }
    ]
  },
  swot: {
    name:'SWOT analysis', desc:'Strengths, weaknesses, etc.', color:'#c98a1a', group:'pm', icon:'⊞',
    nodes:[
      { k:'root', text:'Subject of analysis' },
      { k:'s', parent:'root', text:'Strengths' },
      { k:'w', parent:'root', text:'Weaknesses' },
      { k:'o', parent:'root', text:'Opportunities' },
      { k:'t', parent:'root', text:'Threats' }
    ]
  },
  meeting: {
    name:'Meeting agenda', desc:'Topics, decisions, actions', color:'#6a8c3f', group:'pm', icon:'👥',
    nodes:[
      { k:'root', text:'Meeting title' },
      { k:'ag', parent:'root', text:'Agenda' },
      { k:'ag1',parent:'ag',   text:'Topic 1' },
      { k:'ag2',parent:'ag',   text:'Topic 2' },
      { k:'de', parent:'root', text:'Decisions' },
      { k:'ai', parent:'root', text:'Action items' },
      { k:'fu', parent:'root', text:'Follow-ups' }
    ]
  },

  /* ===== Career & job search ===== */
  interview_prep: {
    name:'Interview prep', desc:'Research, stories, questions', color:'#c98a1a', group:'career', icon:'💬',
    nodes:[
      { k:'root', text:'Company / role' },
      { k:'re', parent:'root', text:'Company research' },
      { k:'st', parent:'root', text:'STAR stories' },
      { k:'st1',parent:'st',   text:'Leadership example' },
      { k:'st2',parent:'st',   text:'Conflict example' },
      { k:'st3',parent:'st',   text:'Failure & learning' },
      { k:'qa', parent:'root', text:'Questions to ask them' },
      { k:'ne', parent:'root', text:'Salary negotiation' }
    ]
  },
  resume: {
    name:'Résumé brainstorm', desc:'Surface your achievements', color:'#3a6ea5', group:'career', icon:'📄',
    nodes:[
      { k:'root', text:'Target role' },
      { k:'ex', parent:'root', text:'Experience' },
      { k:'ex1',parent:'ex',   text:'Achievement (with metric)' },
      { k:'sk', parent:'root', text:'Skills' },
      { k:'pr', parent:'root', text:'Projects' },
      { k:'ed', parent:'root', text:'Education' },
      { k:'ke', parent:'root', text:'Keywords from job post' }
    ]
  },
  career_decision: {
    name:'Career decision', desc:'Weigh options & priorities', color:'#8c5da7', group:'career', icon:'🧭',
    nodes:[
      { k:'root', text:'Decision' },
      { k:'o1', parent:'root', text:'Option A' },
      { k:'o1p',parent:'o1',   text:'Pros' },
      { k:'o1c',parent:'o1',   text:'Cons' },
      { k:'o2', parent:'root', text:'Option B' },
      { k:'o2p',parent:'o2',   text:'Pros' },
      { k:'o2c',parent:'o2',   text:'Cons' },
      { k:'va', parent:'root', text:'My priorities / values' }
    ]
  },

  /* ===== Design & UX ===== */
  design_brief: {
    name:'Design brief', desc:'Goals, audience, constraints', color:'#5b8db2', group:'design', icon:'🎨',
    nodes:[
      { k:'root', text:'Project' },
      { k:'go', parent:'root', text:'Goals' },
      { k:'au', parent:'root', text:'Audience' },
      { k:'br', parent:'root', text:'Brand / tone' },
      { k:'de', parent:'root', text:'Deliverables' },
      { k:'co', parent:'root', text:'Constraints' },
      { k:'in', parent:'root', text:'Inspiration' }
    ]
  },
  user_journey: {
    name:'User journey map', desc:'Stages, actions, emotions', color:'#6a8c3f', group:'design', icon:'🚶',
    nodes:[
      { k:'root', text:'Journey: [persona + goal]' },
      { k:'s1', parent:'root', text:'Awareness' },
      { k:'s1a',parent:'s1',   text:'Actions / emotions' },
      { k:'s2', parent:'root', text:'Consideration' },
      { k:'s2a',parent:'s2',   text:'Actions / emotions' },
      { k:'s3', parent:'root', text:'Decision' },
      { k:'s3a',parent:'s3',   text:'Actions / emotions' },
      { k:'s4', parent:'root', text:'Retention' },
      { k:'pa', parent:'root', text:'Pain points' }
    ]
  },
  usability_test: {
    name:'Usability test plan', desc:'Tasks, metrics, participants', color:'#c2783c', group:'design', icon:'🔬',
    nodes:[
      { k:'root', text:'Test plan' },
      { k:'go', parent:'root', text:'Research goals' },
      { k:'pa', parent:'root', text:'Participants' },
      { k:'ta', parent:'root', text:'Tasks' },
      { k:'ta1',parent:'ta',   text:'Task 1' },
      { k:'ta2',parent:'ta',   text:'Task 2' },
      { k:'me', parent:'root', text:'Metrics' },
      { k:'qu', parent:'root', text:'Post-test questions' }
    ]
  },

  /* ===== Event & personal ===== */
  event: {
    name:'Event planning', desc:'Venue, guests, schedule, budget', color:'#6a8c3f', group:'personal', icon:'🎉',
    nodes:[
      { k:'root', text:'Event name' },
      { k:'ve', parent:'root', text:'Venue' },
      { k:'gu', parent:'root', text:'Guests' },
      { k:'ca', parent:'root', text:'Catering' },
      { k:'sc', parent:'root', text:'Schedule' },
      { k:'bu', parent:'root', text:'Budget' },
      { k:'su', parent:'root', text:'Suppliers' },
      { k:'ch', parent:'root', text:'Checklist' }
    ]
  },
  trip: {
    name:'Trip planner', desc:'Destinations, logistics, budget', color:'#5b8db2', group:'personal', icon:'✈',
    nodes:[
      { k:'root', text:'Trip' },
      { k:'de', parent:'root', text:'Destinations' },
      { k:'da', parent:'root', text:'Dates' },
      { k:'tr', parent:'root', text:'Transport' },
      { k:'st', parent:'root', text:'Stay' },
      { k:'ac', parent:'root', text:'Activities' },
      { k:'bu', parent:'root', text:'Budget' },
      { k:'pa', parent:'root', text:'Packing list' }
    ]
  },
  decision_matrix: {
    name:'Decision matrix', desc:'Pros / cons / criteria', color:'#c98a1a', group:'personal', icon:'⚖',
    nodes:[
      { k:'root', text:'Decision' },
      { k:'cr', parent:'root', text:'Criteria' },
      { k:'o1', parent:'root', text:'Option A' },
      { k:'o1p',parent:'o1',   text:'Pros' },
      { k:'o1c',parent:'o1',   text:'Cons' },
      { k:'o2', parent:'root', text:'Option B' },
      { k:'o2p',parent:'o2',   text:'Pros' },
      { k:'o2c',parent:'o2',   text:'Cons' }
    ]
  },
  weekly_goals: {
    name:'Weekly goals', desc:'Plan your week by area', color:'#6a8c3f', group:'personal', icon:'🗓',
    nodes:[
      { k:'root', text:'This week' },
      { k:'wo', parent:'root', text:'Work' },
      { k:'he', parent:'root', text:'Health' },
      { k:'le', parent:'root', text:'Learning' },
      { k:'pe', parent:'root', text:'Personal' },
      { k:'pr', parent:'root', text:'Top 3 priorities' }
    ]
  },

  /* ===== Professional (use as documentation scaffolds) ===== */
  case_brief: {
    name:'Legal case brief', desc:'Facts, issue, rule, analysis', color:'#8c5da7', group:'pro', icon:'⚖',
    nodes:[
      { k:'root', text:'Case name & citation' },
      { k:'fa', parent:'root', text:'Facts' },
      { k:'is', parent:'root', text:'Issue' },
      { k:'ru', parent:'root', text:'Rule of law' },
      { k:'an', parent:'root', text:'Analysis / reasoning' },
      { k:'ho', parent:'root', text:'Holding' },
      { k:'di', parent:'root', text:'Dissent / notes' }
    ]
  },
  soap_note: {
    name:'SOAP note (clinical)', desc:'Documentation scaffold only', color:'#2f6f6a', group:'pro', icon:'🩺',
    nodes:[
      { k:'root', text:'Encounter' },
      { k:'s', parent:'root', text:'Subjective' },
      { k:'o', parent:'root', text:'Objective' },
      { k:'a', parent:'root', text:'Assessment' },
      { k:'p', parent:'root', text:'Plan' }
    ]
  }
};
// Template categories (ordered) for the drill-down menu.
const TEMPLATE_CATEGORIES = [
  { id:'prompt',   label:'Prompt engineering',  icon:'✦', color:'#5b8db2' },
  { id:'research', label:'Research & writing',   icon:'🔬', color:'#3a6ea5' },
  { id:'study',    label:'Students & educators', icon:'🎓', color:'#6a8c3f' },
  { id:'software', label:'Software & technical', icon:'💻', color:'#8c5da7' },
  { id:'product',  label:'Product & founders',   icon:'🚀', color:'#c2783c' },
  { id:'writing',  label:'Writers & creators',   icon:'✒', color:'#b8451f' },
  { id:'pm',       label:'Project management',   icon:'📋', color:'#2f6f6a' },
  { id:'career',   label:'Career & job search',  icon:'💼', color:'#c98a1a' },
  { id:'design',   label:'Design & UX',          icon:'🎨', color:'#5b8db2' },
  { id:'personal', label:'Event & personal',     icon:'🗓', color:'#6a8c3f' },
  { id:'pro',      label:'Professional',         icon:'⚖', color:'#8c5da7' }
];

// Seed a new map from a template. Mirrors createMap()'s lifecycle but uses
// the template's pre-built node graph instead of an empty root.
async function createMapFromTemplate(templateId){
  const tpl = TEMPLATES[templateId];
  if(!tpl){ createMap(); return; }
  const id = uid();
  const keyToId = {};      // template key -> real uid
  const nodes = {};
  let rootId = null;
  tpl.nodes.forEach(n => {
    const nid = uid();
    keyToId[n.k] = nid;
    if(!n.parent) rootId = nid;
  });
  tpl.nodes.forEach(n => {
    const nid = keyToId[n.k];
    nodes[nid] = {
      id: nid,
      text: n.text,
      parent: n.parent ? keyToId[n.parent] : null,
      x: 0, y: 0,
      side: n.parent ? null : 'root',   // unsided → balanced by weight below
      color: '#fff'
    };
    if(n.task) nodes[nid].task = n.task;   // carry task state from user templates
  });
  map = { id, title: tpl.name, titleAuto: false, color: tpl.color, layout: 'balanced', rootId, nodes };
  sel = rootId; history = []; hpos = -1;
  balanceRootSides();        // split top-level branches evenly left/right
  pushHistory();
  $('#mapTitle').value = map.title;
  autoLayout(); fit();
  scheduleSave(); refreshList();
}

// ===== Map duplication =====
async function duplicateMap(id){
  let src = (map && map.id===id) ? map : null;
  if(!src){ try{ src = await Store.get(id); }catch(e){} }
  if(!src){ toast('Could not duplicate'); return; }
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = uid();
  copy.title = (src.title||'Untitled') + ' (copy)';
  copy.titleAuto = false;
  copy.updated = Date.now();
  await Store.save(copy);
  await loadMap(copy.id);
  refreshList();
  toast('Map duplicated');
}

// ===== Save current map as a reusable template =====
function saveAsTemplate(){
  if(!map){ return; }
  const name = (prompt('Name this template:', map.title||'My template')||'').trim();
  if(!name) return;
  const idToK = {}; let i=0;
  Object.keys(map.nodes).forEach(nid=>{ idToK[nid] = (nid===map.rootId) ? 'root' : ('n'+(i++)); });
  const nodes = Object.values(map.nodes).map(n=>{
    const o = { k: idToK[n.id], text: nodeTextPlain(n.text)||'' };
    if(n.parent) o.parent = idToK[n.parent];
    if(n.task) o.task = n.task;
    return o;
  });
  const tpl = { id:'user_'+uid(), name, desc:'Your saved template', color: map.color||'#e0613a', group:'mine', icon:'⭐', nodes, _user:true };
  let store=[]; try{ store=JSON.parse(localStorage.getItem('mindspark:userTemplates')||'[]'); }catch(e){}
  store.push(tpl);
  try{ localStorage.setItem('mindspark:userTemplates', JSON.stringify(store)); }catch(e){ toast('Could not save (storage full?)'); return; }
  loadUserTemplates();
  toast('Saved to "My templates"');
}
function deleteUserTemplate(tid){
  let store=[]; try{ store=JSON.parse(localStorage.getItem('mindspark:userTemplates')||'[]'); }catch(e){}
  store = store.filter(t=>t.id!==tid);
  localStorage.setItem('mindspark:userTemplates', JSON.stringify(store));
  delete TEMPLATES[tid];
  if(!store.length){
    const idx=TEMPLATE_CATEGORIES.findIndex(c=>c.id==='mine');
    if(idx>=0) TEMPLATE_CATEGORIES.splice(idx,1);
  }
}
// Merge user templates from localStorage into the in-memory catalog.
function loadUserTemplates(){
  let store=[]; try{ store=JSON.parse(localStorage.getItem('mindspark:userTemplates')||'[]'); }catch(e){ store=[]; }
  // Drop any previously-merged user templates so we don't duplicate on re-call
  Object.keys(TEMPLATES).forEach(k=>{ if(TEMPLATES[k]&&TEMPLATES[k]._user) delete TEMPLATES[k]; });
  store.forEach(t=>{ TEMPLATES[t.id]=t; });
  const hasCat = TEMPLATE_CATEGORIES.some(c=>c.id==='mine');
  if(store.length && !hasCat){
    TEMPLATE_CATEGORIES.push({ id:'mine', label:'My templates', icon:'⭐', color:'#c98a1a' });
  } else if(!store.length && hasCat){
    const idx=TEMPLATE_CATEGORIES.findIndex(c=>c.id==='mine');
    if(idx>=0) TEMPLATE_CATEGORIES.splice(idx,1);
  }
}
function showTemplatesMenu(){
  document.querySelectorAll('.tpl-pop').forEach(p => p.remove());
  const pop = document.createElement('div');
  pop.className = 'tpl-pop';
  document.body.appendChild(pop);
  pop.addEventListener('mousedown', e => e.stopPropagation());
  // Stop clicks inside the popover from reaching the document-level
  // outside-click handler — otherwise drilling into a category (which
  // rebuilds innerHTML and detaches the clicked button) would be seen as
  // an "outside" click and close the menu.
  pop.addEventListener('click', e => e.stopPropagation());

  const place = () => {
    // Anchor under the "New mind map" row, constrained to the viewport.
    const row = document.querySelector('.new-map-row') || $('#newMapMenu');
    const r = row.getBoundingClientRect();
    pop.style.position = 'fixed';
    pop.style.maxHeight = '';   // measure natural height first
    pop.style.visibility = 'hidden';
    pop.style.left = '0px'; pop.style.top = '0px';
    const pw = pop.offsetWidth, ph = pop.offsetHeight, margin = 8;
    let left = r.left;
    if(left + pw > window.innerWidth - margin) left = window.innerWidth - pw - margin;
    if(left < margin) left = margin;
    // Prefer below the row; if it won't fit, use whichever side has more room.
    const spaceBelow = window.innerHeight - (r.bottom + 6) - margin;
    const spaceAbove = r.top - 6 - margin;
    let top;
    if(ph <= spaceBelow || spaceBelow >= spaceAbove){
      top = r.bottom + 6;
      pop.style.maxHeight = Math.max(120, window.innerHeight - top - margin) + 'px';
    } else {
      // place above, growing upward
      pop.style.maxHeight = Math.max(120, spaceAbove) + 'px';
      const cappedH = Math.min(ph, spaceAbove);
      top = Math.max(margin, r.top - 6 - cappedH);
    }
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
    pop.style.visibility = '';
  };
  const close = () => pop.remove();

  // ----- root view: blank + category list -----
  const renderRoot = () => {
    pop.innerHTML = `
      <div class="tpl-head">Start from a template</div>
      <button class="tpl-item" data-act="blank">
        <span class="tpl-ic" style="background:#e0613a">⊕</span>
        <span><b>Blank map</b><i>Just a root node</i></span>
      </button>
      <div class="tpl-divider"></div>
      ${TEMPLATE_CATEGORIES.map(c=>{
        const count = Object.values(TEMPLATES).filter(t=>(t.group||'prompt')===c.id).length;
        return `<button class="tpl-item tpl-cat" data-cat="${c.id}">
            <span class="tpl-ic" style="background:${c.color}">${c.icon}</span>
            <span><b>${escapeHtml(c.label)}</b><i>${count} template${count===1?'':'s'}</i></span>
            <span class="tpl-chev">›</span>
          </button>`;
      }).join('')}`;
    pop.querySelector('[data-act="blank"]').onclick = () => { close(); createMap(); };
    pop.querySelectorAll('.tpl-cat').forEach(b => b.onclick = () => renderCategory(b.dataset.cat));
    place();
  };

  // ----- category view: back + that category's templates -----
  const renderCategory = (catId) => {
    const cat = TEMPLATE_CATEGORIES.find(c=>c.id===catId);
    const entries = Object.entries(TEMPLATES).filter(([,t])=>(t.group||'prompt')===catId);
    pop.innerHTML = `
      <button class="tpl-back" data-act="back">‹ All categories</button>
      <div class="tpl-head" style="padding-top:2px">${escapeHtml(cat.label)}</div>
      ${entries.map(([id,t])=>`
        <button class="tpl-item" data-id="${id}">
          <span class="tpl-ic" style="background:${t.color}">${t.icon || '⊟'}</span>
          <span><b>${escapeHtml(t.name)}</b><i>${escapeHtml(t.desc)}</i></span>
          ${t._user?`<span class="tpl-del" data-del="${id}" title="Delete template">✕</span>`:''}
        </button>`).join('')}`;
    pop.querySelector('[data-act="back"]').onclick = renderRoot;
    pop.querySelectorAll('.tpl-item[data-id]').forEach(b => b.onclick = (e) => {
      if(e.target.classList.contains('tpl-del')){
        e.stopPropagation();
        deleteUserTemplate(e.target.dataset.del);
        renderCategory(catId);   // refresh; back to root if category now empty
        if(!TEMPLATE_CATEGORIES.some(c=>c.id===catId)) renderRoot();
        return;
      }
      close(); createMapFromTemplate(b.dataset.id);
    });
    place();
  };

  renderRoot();
  setTimeout(() => document.addEventListener('click', function cl(e){
    if(!pop.contains(e.target)){ close(); document.removeEventListener('click', cl); }
  }), 0);
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
  if(!map || READONLY)return;
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
  // Close existing popover if open
  document.querySelectorAll('.export-pop').forEach(p=>p.remove());
  const pop=document.createElement('div');
  pop.className='export-pop';
  pop.innerHTML=`
    <button data-a="share"><span class="ex-ic">🔗</span><span><b>Copy share link</b><i>Read-only view, no account needed</i></span></button>
    <div class="ex-div"></div>
    <button data-a="png"   ><span class="ex-ic">🖼</span><span><b>PNG image</b><i>Themed export, honors map style</i></span></button>
    <button data-a="prompt"><span class="ex-ic">⚡</span><span><b>Export as prompt</b><i>Fill variables, then copy clean text</i></span></button>
    <button data-a="md"    ><span class="ex-ic">📋</span><span><b>Markdown / text</b><i>Indented bullets — paste anywhere</i></span></button>
    <button data-a="copy"  ><span class="ex-ic">⎘</span><span><b>Copy as text (clipboard)</b><i>Same as Markdown, no download</i></span></button>
    <button data-a="word"  ><span class="ex-ic">📄</span><span><b>Word document (.doc)</b><i>Opens in Word, Google Docs, LibreOffice</i></span></button>
    <button data-a="mermaid"><span class="ex-ic">🧜</span><span><b>Mermaid diagram</b><i>Renders in GitHub, Notion, Obsidian</i></span></button>
    <button data-a="refs"><span class="ex-ic">📖</span><span><b>References list</b><i>All citation nodes, formatted</i></span></button>
    <div class="ex-div"></div>
    <button data-a="duplicate"><span class="ex-ic">⎘</span><span><b>Duplicate this map</b><i>Make an editable copy</i></span></button>
    <button data-a="astemplate"><span class="ex-ic">⭐</span><span><b>Save as template</b><i>Reuse this structure for new maps</i></span></button>
    <button data-a="json"  ><span class="ex-ic">{}</span><span><b>JSON file</b><i>Full backup, re-importable</i></span></button>
    <div class="ex-div"></div>
    <button data-a="import"><span class="ex-ic">↑</span><span><b>Import file</b><i>JSON, OPML, or Markdown outline</i></span></button>`;
  const r=$('#menuExport').getBoundingClientRect();
  pop.style.position='fixed';
  pop.style.top=(r.bottom+6)+'px';
  pop.style.right=(window.innerWidth - r.right)+'px';
  document.body.appendChild(pop);
  pop.addEventListener('mousedown',e=>e.stopPropagation());
  const close=()=>pop.remove();
  setTimeout(()=>document.addEventListener('click', function cl(e){
    if(!pop.contains(e.target)) { close(); document.removeEventListener('click', cl); }
  }), 0);
  pop.querySelectorAll('button').forEach(b=>b.onclick=()=>{
    const a=b.dataset.a; close();
    if(a==='share') copyShareLink();
    else if(a==='png') exportPNG();
    else if(a==='prompt') exportAsPrompt();
    else if(a==='md') exportMarkdown(false);
    else if(a==='copy') exportMarkdown(true);
    else if(a==='word') exportDoc();
    else if(a==='mermaid') exportMermaid();
    else if(a==='refs') exportReferences();
    else if(a==='duplicate') duplicateMap(map.id);
    else if(a==='astemplate') saveAsTemplate();
    else if(a==='json') exportJSON();
    else if(a==='import') importJSON();
  });
}
function exportJSON(){
  const blob=new Blob([JSON.stringify(map,null,2)],{type:'application/json'});
  download(blob,(map.title||'mindmap')+'.json'); toast('JSON exported');
}
function importJSON(){ importFile(); }   // back-compat alias
function importFile(){
  const inp=document.createElement('input');
  inp.type='file';
  inp.accept='.json,.opml,.xml,.md,.markdown,.txt';
  inp.onchange=async()=>{
    const f=inp.files[0]; if(!f) return;
    const t=await f.text();
    const name=(f.name||'').toLowerCase();
    try{
      let m;
      if(name.endsWith('.json')) { m=JSON.parse(t); }
      else if(name.endsWith('.opml')||name.endsWith('.xml')) { m=parseOPML(t, f.name); }
      else { m=parseMarkdownOutline(t, f.name); }   // .md, .markdown, .txt
      if(!m || !m.nodes || !m.rootId) throw new Error('No recognizable outline');
      // Start collapsed so the user sees a clean top-level overview of the import.
      Object.keys(m.nodes).forEach(id=>{
        if(id !== m.rootId) m.nodes[id].collapsed = true;
      });
      m.id=uid();
      await Store.save(m);
      await loadMap(m.id);
      // Imported nodes have no positions (all at 0,0) — lay them out into a
      // proper tree, then frame the result.
      autoLayout(); fit();
      refreshList();
      toast('Imported '+f.name+' (collapsed — click ＋ to expand)');
    }catch(e){ console.error(e); alert('Could not import this file:\n'+e.message); }
  };
  inp.click();
}
// Convert basic inline markdown (**bold**, *italic*, ~~strike~~) to our HTML.
function mdInlineToHtml(t){
  const hasMd = /\*\*[^*]+\*\*|(?:^|[^*])\*[^*]+\*|~~[^~]+~~|`[^`]+`/.test(t);
  if(!hasMd) return t;                       // keep plain text plain
  let s = escapeHtml(t);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>');
  s = s.replace(/~~([^~]+)~~/g, '<s>$1</s>');
  s = s.replace(/`([^`]+)`/g, '$1');
  return s;
}
// Parse an OPML document into a map.
function parseOPML(text, filename){
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if(doc.querySelector('parsererror')) throw new Error('Invalid OPML / XML');
  const body = doc.querySelector('body');
  if(!body) throw new Error('OPML has no <body>');
  const title = (doc.querySelector('head > title')?.textContent
               || (filename||'').replace(/\.[^.]+$/, '') || 'Imported').trim();
  const nodes = {};
  const rootId = uid();
  nodes[rootId] = { id:rootId, text:title, parent:null, side:'root', x:0, y:0 };
  const walk = (outline, parentId, side) => {
    const id = uid();
    const txt = outline.getAttribute('text') || outline.getAttribute('title') || '';
    nodes[id] = { id, text:mdInlineToHtml(txt.trim()), parent:parentId, side, x:0, y:0 };
    const note = outline.getAttribute('_note') || outline.getAttribute('note');
    if(note) nodes[id].notes = escapeHtml(note);
    [...outline.children]
      .filter(c => c.tagName && c.tagName.toLowerCase()==='outline')
      .forEach(child => walk(child, id, side));
  };
  const tops = [...body.children].filter(c => c.tagName && c.tagName.toLowerCase()==='outline');
  tops.forEach((o, i) => walk(o, rootId, i%2 ? 'left' : 'right'));
  return { id:uid(), title, titleAuto:false, color:'#e0613a', rootId, nodes };
}
// Parse a Markdown / plain-text outline (headings and/or nested bullets) into a map.
function parseMarkdownOutline(text, filename){
  const title = (filename||'').replace(/\.[^.]+$/, '') || 'Imported';
  const nodes = {};
  const rootId = uid();
  nodes[rootId] = { id:rootId, text:title, parent:null, side:'root', x:0, y:0 };
  const stack = [{ id:rootId, depth:0 }];
  let sideCounter = 0, lastHeadingDepth = 0;
  const add = (txt, depth) => {
    while(stack.length>1 && stack[stack.length-1].depth >= depth) stack.pop();
    const parentId = stack[stack.length-1].id;
    const id = uid();
    let side = 'right';
    if(parentId===rootId) side = (sideCounter++ % 2) ? 'left' : 'right';
    else side = nodes[parentId].side || 'right';
    nodes[id] = { id, text:mdInlineToHtml(txt), parent:parentId, side, x:0, y:0 };
    stack.push({ id, depth });
  };
  text.split('\n').forEach(line => {
    if(!line.trim()) return;
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if(h){ lastHeadingDepth = h[1].length; add(h[2].trim(), lastHeadingDepth); return; }
    const bullet = line.match(/^(\s*)(?:[-*+]|\d+\.)\s+(.*)$/);
    if(bullet){
      const indent = bullet[1].replace(/\t/g, '  ').length;
      add(bullet[2].trim(), lastHeadingDepth + 1 + Math.floor(indent/2));
      return;
    }
    // Plain paragraph: hang under the most recent heading
    add(line.trim(), lastHeadingDepth + 1);
  });
  return { id:uid(), title, titleAuto:false, color:'#e0613a', rootId, nodes };
}

// Strip HTML to plain text but keep newlines from <br> and block elements
function nodeTextPlain(text){
  if(!text) return '';
  if(!INLINE_HTML_RE.test(text)) return text;
  const tmp=document.createElement('div'); tmp.innerHTML=text;
  tmp.querySelectorAll('br').forEach(br=>br.replaceWith(document.createTextNode('\n')));
  return (tmp.textContent||'').replace(/\u00A0/g,' ').trim();
}
// Rough token count: ~4 chars per token (English avg for GPT/Claude tokenizers).
// Adds notes content to the total so the badge reflects what would actually be
// included if the user exports this node to a prompt.
function estimateTokens(text, notes){
  const tParts = nodeTextPlain(text||'');
  const nParts = notes ? (notes||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim() : '';
  const chars = tParts.length + nParts.length;
  if(chars === 0) return 0;
  return Math.max(1, Math.round(chars / 4));
}
// ===== Mermaid flowchart export =====
// Walk the tree and emit `parent --> child` edges plus node definitions.
// Renders natively in GitHub, GitLab, Notion, Obsidian, etc.
function buildMermaid(startId){
  const root = startId || map.rootId;
  const lines = ['flowchart TD'];
  // Stable short ids: n0, n1, … mapped from node ids
  const idMap = {}; let counter = 0;
  const mid = id => (idMap[id] || (idMap[id] = 'n' + (counter++)));
  // Escape text for a Mermaid node label inside ["..."]
  const label = id => {
    let t = nodeTextPlain(map.nodes[id].text) || ' ';
    t = t.replace(/\n+/g, ' ').replace(/"/g, '#quot;').trim();
    if(t.length > 80) t = t.slice(0, 77) + '…';
    return t;
  };
  const defined = new Set();
  const define = id => {
    if(defined.has(id)) return;
    defined.add(id);
    lines.push(`    ${mid(id)}["${label(id)}"]`);
  };
  const walk = id => {
    define(id);
    childrenOf(id).forEach(c => {
      define(c);
      lines.push(`    ${mid(id)} --> ${mid(c)}`);
      walk(c);
    });
  };
  walk(root);
  // Colour the root node to match the map accent
  const accent = (map.color || '#e0613a');
  lines.push(`    style ${mid(root)} fill:${accent},color:#fff,stroke:${accent}`);
  return lines.join('\n');
}
function exportMermaid(){
  if(!map) return;
  const startId = (sel && sel !== map.rootId) ? sel : map.rootId;
  const code = buildMermaid(startId);
  // Wrap in a fenced ```mermaid block so it pastes straight into Markdown
  const fenced = '```mermaid\n' + code + '\n```\n';
  if(navigator.clipboard?.writeText){
    navigator.clipboard.writeText(fenced).then(
      () => toast('Mermaid diagram copied'),
      () => { download(new Blob([fenced],{type:'text/plain'}), (map.title||'mindmap')+'.mmd.md'); toast('Clipboard blocked — downloaded instead'); }
    );
  } else {
    download(new Blob([fenced],{type:'text/plain'}), (map.title||'mindmap')+'.mmd.md');
    toast('Mermaid diagram downloaded');
  }
}

// Build hierarchical Markdown bullets from the map. If `startId` is given,
// only that node's subtree is included — useful for "copy this branch as a prompt".
function buildMarkdown(startId){
  const root = startId || map.rootId;
  const lines=[];
  const baseDepth = 0;
  const walk=(id, depth)=>{
    const n=map.nodes[id];
    if(!n) return;
    const indent='  '.repeat(depth);
    const plain = nodeTextPlain(n.text) || 'Untitled';
    const [first, ...rest] = plain.split('\n');
    if(depth===baseDepth){
      lines.push(`# ${first}`);
      if(rest.length) rest.forEach(r=>lines.push(r));
      if(n.notes){
        const nt=(n.notes||'').replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').trim();
        if(nt) lines.push('', nt);
      }
      lines.push('');
    } else {
      lines.push(`${indent}- ${first}`);
      rest.forEach(r=>lines.push(`${indent}  ${r}`));
      if(n.notes){
        const nt=(n.notes||'').replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').trim();
        if(nt) nt.split('\n').forEach(l=>lines.push(`${indent}  > ${l}`));
      }
    }
    childrenOf(id).forEach(c=>walk(c, depth+1));
  };
  walk(root, baseDepth);
  return lines.join('\n');
}

// === Variable / placeholder detection ============================================
// Recognise {{name}} and ${name} in node text + notes. Names can include letters,
// numbers, underscores, hyphens, dots, and spaces.
const VAR_RE = /\{\{\s*([\w.\- ]+?)\s*\}\}|\$\{\s*([\w.\- ]+?)\s*\}/g;
function findVariables(startId){
  const root = startId || map.rootId;
  const seen = new Set();
  const order = [];
  const visit = text => {
    if(!text) return;
    const plain = nodeTextPlain(text);
    VAR_RE.lastIndex = 0;
    let m; while((m = VAR_RE.exec(plain)) !== null){
      const name = (m[1] || m[2] || '').trim();
      if(name && !seen.has(name)){ seen.add(name); order.push(name); }
    }
  };
  const walk = id => {
    const n = map.nodes[id]; if(!n) return;
    visit(n.text);
    if(n.notes) visit((n.notes||'').replace(/<[^>]+>/g,' '));
    childrenOf(id).forEach(walk);
  };
  walk(root);
  return order;
}
// Replace {{var}} and ${var} occurrences inside `text` using the values map.
function substituteVariables(text, values){
  if(!text) return text;
  return text.replace(VAR_RE, (m, a, b) => {
    const name = (a || b || '').trim();
    return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : m;
  });
}

// Build a clean prompt text — hierarchical headings, no markdown syntax noise,
// notes inlined. Optionally substitutes filled variable values.
function buildPrompt(startId, values){
  const root = startId || map.rootId;
  const out = [];
  const sub = t => values ? substituteVariables(t, values) : t;
  const walk = (id, depth) => {
    const n = map.nodes[id]; if(!n) return;
    const text = sub(nodeTextPlain(n.text) || 'Untitled');
    const notes = sub(((n.notes||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim()));
    if(depth === 0){
      out.push(text);
      if(notes) out.push('', notes);
      out.push('');
    } else if(depth === 1){
      // Top-level branches become section headers
      out.push('');
      out.push(text);
      out.push('-'.repeat(Math.min(text.length, 40)));
      if(notes) out.push(notes);
    } else {
      const indent = '  '.repeat(depth - 1);
      out.push(`${indent}${text}`);
      if(notes) out.push(`${indent}  (${notes})`);
    }
    childrenOf(id).forEach(c => walk(c, depth + 1));
  };
  walk(root, 0);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// Show a small modal listing each detected variable with an input field.
// On submit, calls `done(values)` with the user-entered substitutions.
function showVariableForm(varNames, defaults, mapId, done){
  document.querySelectorAll('.var-form').forEach(p => p.remove());
  const m = document.createElement('div');
  m.className = 'var-form';
  m.innerHTML = `
    <div class="vf-backdrop"></div>
    <div class="vf-card">
      <button class="vf-close" aria-label="Close">×</button>
      <h2>Fill variables</h2>
      <p class="vf-sub">Found ${varNames.length} placeholder${varNames.length===1?'':'s'} — fill them before exporting the prompt.</p>
      <div class="vf-fields">
        ${varNames.map(name => `
          <label class="vf-row">
            <span class="vf-name"><code>${escapeHtml(name)}</code></span>
            <textarea class="vf-input" data-name="${escapeHtml(name)}" rows="1" placeholder="value for ${escapeHtml(name)}">${escapeHtml(defaults[name] || '')}</textarea>
          </label>`).join('')}
      </div>
      <div class="vf-actions">
        <button class="vf-skip">Skip / use raw</button>
        <button class="vf-cancel">Cancel</button>
        <button class="vf-go primary">Export</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  m.addEventListener('mousedown', e => e.stopPropagation());
  // Auto-grow textareas as the user types
  m.querySelectorAll('.vf-input').forEach(ta => {
    const grow = () => { ta.style.height='auto'; ta.style.height=Math.min(ta.scrollHeight, 140)+'px'; };
    ta.addEventListener('input', grow); grow();
  });
  m.querySelector('.vf-input')?.focus();
  const close = () => m.remove();
  const collect = () => {
    const out = {};
    m.querySelectorAll('.vf-input').forEach(ta => { out[ta.dataset.name] = ta.value; });
    // Remember per-map for next time
    try { localStorage.setItem('mindspark:vars:'+mapId, JSON.stringify(out)); } catch(e){}
    return out;
  };
  m.querySelector('.vf-go').onclick     = () => { const v = collect(); close(); done(v); };
  m.querySelector('.vf-skip').onclick   = () => { close(); done(null); };  // null = no substitution
  m.querySelector('.vf-cancel').onclick = close;
  m.querySelector('.vf-close').onclick  = close;
  m.querySelector('.vf-backdrop').onclick = close;
  m.addEventListener('keydown', e => {
    if(e.key==='Escape'){ e.preventDefault(); close(); }
    if(e.key==='Enter' && (e.ctrlKey||e.metaKey)){ e.preventDefault(); m.querySelector('.vf-go').click(); }
  });
}

// Top-level "Export as prompt" — detects variables, shows the form when any are
// present, then builds the prompt text and copies it to the clipboard.
function exportAsPrompt(){
  if(!map) return;
  const startId = (sel && sel !== map.rootId) ? sel : map.rootId;
  const vars = findVariables(startId);
  const finish = (values) => {
    const text = buildPrompt(startId, values);
    if(navigator.clipboard?.writeText){
      navigator.clipboard.writeText(text).then(
        () => toast(`Prompt copied (${text.length} chars)`),
        () => { download(new Blob([text],{type:'text/plain'}), (map.title||'prompt')+'.txt'); toast('Clipboard blocked — downloaded instead'); }
      );
    } else {
      download(new Blob([text],{type:'text/plain'}), (map.title||'prompt')+'.txt');
      toast('Prompt downloaded');
    }
  };
  if(vars.length === 0){
    finish(null);
    return;
  }
  // Build defaults: map-level variables first (the "official" defaults defined
  // once via the Variables panel), then any per-session localStorage values on top.
  const defaults = { ...(map.vars || {}) };
  try {
    const saved = JSON.parse(localStorage.getItem('mindspark:vars:'+map.id) || '{}');
    Object.assign(defaults, saved);
  } catch(e){}
  // If every detected variable already has a non-empty map-level default, skip the
  // form entirely and export straight away — that's the whole point of map vars.
  const allCovered = vars.every(v => (map.vars||{})[v] != null && String((map.vars||{})[v]).trim() !== '');
  if(allCovered){
    finish(defaults);
    toast('Used saved map variables');
    return;
  }
  showVariableForm(vars, defaults, map.id, (values) => {
    finish(values);
  });
}

// ===== Map-level variables panel =====
// Lets the user set default values for every {{placeholder}} / ${placeholder}
// in the map, stored on map.vars so future prompt exports reuse them.
function showMapVariables(){
  if(!map) return;
  document.querySelectorAll('.var-form').forEach(p => p.remove());
  const vars = findVariables(map.rootId);
  const cur = map.vars || {};
  const m = document.createElement('div');
  m.className = 'var-form';
  if(vars.length === 0){
    m.innerHTML = `
      <div class="vf-backdrop"></div>
      <div class="vf-card">
        <button class="vf-close" aria-label="Close">×</button>
        <h2>Map variables</h2>
        <p class="vf-sub">No placeholders found yet. Use <code>{{name}}</code> or <code>$\{name}</code> anywhere in your node text, then set their default values here so every prompt export fills them automatically.</p>
        <div class="vf-actions"><button class="vf-cancel">Close</button></div>
      </div>`;
    document.body.appendChild(m);
    m.addEventListener('mousedown', e => e.stopPropagation());
    const close=()=>m.remove();
    m.querySelector('.vf-close').onclick=close;
    m.querySelector('.vf-cancel').onclick=close;
    m.querySelector('.vf-backdrop').onclick=close;
    return;
  }
  m.innerHTML = `
    <div class="vf-backdrop"></div>
    <div class="vf-card">
      <button class="vf-close" aria-label="Close">×</button>
      <h2>Map variables</h2>
      <p class="vf-sub">Set default values for the ${vars.length} placeholder${vars.length===1?'':'s'} in this map. Prompt exports will reuse these without asking — leave one blank to be prompted at export time.</p>
      <div class="vf-fields">
        ${vars.map(name => `
          <label class="vf-row">
            <span class="vf-name"><code>${escapeHtml(name)}</code></span>
            <textarea class="vf-input" data-name="${escapeHtml(name)}" rows="1" placeholder="default for ${escapeHtml(name)}">${escapeHtml(cur[name] || '')}</textarea>
          </label>`).join('')}
      </div>
      <div class="vf-actions">
        <button class="vf-clear">Clear all</button>
        <button class="vf-cancel">Cancel</button>
        <button class="vf-go primary">Save defaults</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  m.addEventListener('mousedown', e => e.stopPropagation());
  m.querySelectorAll('.vf-input').forEach(ta => {
    const grow = () => { ta.style.height='auto'; ta.style.height=Math.min(ta.scrollHeight,140)+'px'; };
    ta.addEventListener('input', grow); grow();
  });
  m.querySelector('.vf-input')?.focus();
  const close=()=>m.remove();
  m.querySelector('.vf-go').onclick = () => {
    const out = {};
    m.querySelectorAll('.vf-input').forEach(ta => { if(ta.value.trim()!=='') out[ta.dataset.name]=ta.value; });
    map.vars = out;
    pushHistory(); scheduleSave();
    close();
    toast('Map variables saved');
  };
  m.querySelector('.vf-clear').onclick = () => { m.querySelectorAll('.vf-input').forEach(ta=>{ta.value='';ta.dispatchEvent(new Event('input'));}); };
  m.querySelector('.vf-cancel').onclick = close;
  m.querySelector('.vf-close').onclick = close;
  m.querySelector('.vf-backdrop').onclick = close;
  m.addEventListener('keydown', e => {
    if(e.key==='Escape'){ e.preventDefault(); close(); }
    if(e.key==='Enter' && (e.ctrlKey||e.metaKey)){ e.preventDefault(); m.querySelector('.vf-go').click(); }
  });
}
function exportMarkdown(toClipboard){
  if(!map) return;
  // If a non-root node is selected, export *that branch* — perfect for
  // pulling out a single prompt or section from a larger map.
  const startId = (sel && sel !== map.rootId) ? sel : map.rootId;
  const md = buildMarkdown(startId);
  const scope = startId === map.rootId ? '' : ' (selected branch)';
  if(toClipboard){
    if(navigator.clipboard?.writeText){
      navigator.clipboard.writeText(md).then(
        ()=>toast('Copied to clipboard'+scope),
        ()=>{ download(new Blob([md],{type:'text/markdown'}),(map.title||'mindmap')+'.md'); toast('Clipboard blocked — downloaded instead'); }
      );
    } else {
      download(new Blob([md],{type:'text/markdown'}),(map.title||'mindmap')+'.md');
      toast('Clipboard unavailable — downloaded');
    }
  } else {
    const name = startId === map.rootId ? map.title : nodeTextPlain(map.nodes[startId]?.text);
    download(new Blob([md],{type:'text/markdown'}), (name||'mindmap')+'.md');
    toast('Markdown exported'+scope);
  }
}
// Build a Word-compatible HTML document (saved with .doc extension —
// Word, Google Docs, and LibreOffice all open this as a Word document).
function buildDoc(){
  const title = (map.title || 'Mind Map').replace(/[<>]/g,'');
  let body = `<h1>${escapeHtml(title)}</h1>`;
  // Add root's notes under the title
  const rn = map.nodes[map.rootId]?.notes;
  if(rn){ body += `<p><em>${sanitizeInlineHTML(rn)}</em></p>`; }
  // Render children as nested <ul>
  const renderChildren = (parentId, depth)=>{
    const cs = childrenOf(parentId);
    if(!cs.length) return '';
    let out = `<ul>`;
    cs.forEach(cid=>{
      const n = map.nodes[cid];
      const txt = INLINE_HTML_RE.test(n.text||'') ? sanitizeInlineHTML(n.text) : escapeHtml(n.text||'').replace(/\n/g,'<br>');
      out += `<li>${txt}`;
      if(n.notes){ out += `<br><em style="color:#666">${sanitizeInlineHTML(n.notes)}</em>`; }
      out += renderChildren(cid, depth+1);
      out += `</li>`;
    });
    out += `</ul>`;
    return out;
  };
  body += renderChildren(map.rootId, 1);

  // Word-friendly HTML document with proper MIME hints
  return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  body{font-family:Calibri,"Segoe UI",Arial,sans-serif;color:#23201b;line-height:1.55;max-width:780px;margin:24px auto;padding:0 24px}
  h1{font-family:Cambria,Georgia,serif;color:#e0613a;margin:0 0 18px;font-size:26pt}
  ul{margin:6px 0 6px 24px;padding-left:18px}
  li{margin:4px 0}
  em{font-style:italic;color:#6a6258}
  a{color:#3a6ea5}
</style>
</head>
<body>${body}</body>
</html>`;
}
function exportDoc(){
  if(!map) return;
  const html = buildDoc();
  // .doc extension + msword MIME → Word, Google Docs, LibreOffice all open it
  const filename = (map.title||'mindmap')+'.doc';
  const blob = new Blob(['\ufeff', html], {type:'application/msword'});
  download(blob, filename);
  toast('Word document exported');
}
function exportPNG(){
  render();
  // Read live theme colors from CSS custom properties so the export matches
  // whatever theme/map style the user has selected.
  const cs = getComputedStyle(document.documentElement);
  const css = name => cs.getPropertyValue(name).trim();
  const themeBg     = css('--paper')     || '#f4efe6';
  const themeEdge   = css('--line-2')    || '#c8bda8';
  const themeInk    = css('--ink')       || '#23201b';
  const themeNodeBg = css('--node-bg')   || '#ffffff';
  const themeLine   = css('--line')      || '#d8cfbf';
  const accent      = css('--accent')    || '#e0613a';
  const mapStyle  = map.style  || 'modern';
  const mapLayout = map.layout || 'balanced';

  const hidden=hiddenSet(); const ids=Object.keys(map.nodes).filter(i=>!hidden.has(i));
  let minx=1e9,miny=1e9,maxx=-1e9,maxy=-1e9;
  ids.forEach(i=>{const n=map.nodes[i];minx=Math.min(minx,n.x);miny=Math.min(miny,n.y);maxx=Math.max(maxx,n.x+(n.w||120));maxy=Math.max(maxy,n.y+(n.h||40));});
  const pad=50,scale=2;
  const W=(maxx-minx+pad*2),H=(maxy-miny+pad*2);
  const cv=document.createElement('canvas');cv.width=W*scale;cv.height=H*scale;
  const ctx=cv.getContext('2d');ctx.scale(scale,scale);
  ctx.fillStyle=themeBg; ctx.fillRect(0,0,W,H);
  ctx.translate(-minx+pad,-miny+pad);

  // Edges — match map style: bezier (modern/bubble), step (classic), straight (sketch)
  const edgeColor = (mapStyle==='bubble') ? accent : (mapStyle==='sketch' ? themeInk : themeEdge);
  const edgeWidth = (mapStyle==='bubble') ? 3 : (mapStyle==='classic' ? 1.6 : 2.2);
  ctx.strokeStyle = edgeColor;
  ctx.lineWidth   = edgeWidth;
  ctx.lineCap='round'; ctx.lineJoin='round';
  ids.forEach(i=>{
    const n=map.nodes[i]; if(!n.parent||hidden.has(n.parent)) return;
    const p=map.nodes[n.parent]; if(!p) return;
    let x1,y1,x2,y2,leftSide=(n.side==='left'),horizontal=true;
    if(mapLayout==='down'){
      horizontal=false;
      x1=p.x+(p.w||0)/2; y1=p.y+(p.h||0);
      x2=n.x+(n.w||0)/2; y2=n.y;
    } else {
      x1=leftSide ? p.x : p.x+(p.w||0); y1=p.y+(p.h||0)/2;
      x2=leftSide ? n.x+(n.w||0) : n.x;  y2=n.y+(n.h||0)/2;
    }
    ctx.beginPath();
    if(mapStyle==='classic'){
      if(horizontal){ const mid=(x1+x2)/2; ctx.moveTo(x1,y1); ctx.lineTo(mid,y1); ctx.lineTo(mid,y2); ctx.lineTo(x2,y2); }
      else { const mid=(y1+y2)/2; ctx.moveTo(x1,y1); ctx.lineTo(x1,mid); ctx.lineTo(x2,mid); ctx.lineTo(x2,y2); }
    } else if(mapStyle==='sketch'){
      ctx.moveTo(x1,y1); ctx.lineTo(x2,y2);
    } else {
      if(horizontal){
        const dx=Math.abs(x2-x1)*0.5;
        ctx.moveTo(x1,y1);
        ctx.bezierCurveTo(x1+(leftSide?-dx:dx),y1, x2+(leftSide?dx:-dx),y2, x2,y2);
      } else {
        const dy=Math.abs(y2-y1)*0.5;
        ctx.moveTo(x1,y1);
        ctx.bezierCurveTo(x1,y1+dy, x2,y2-dy, x2,y2);
      }
    }
    ctx.stroke();
  });

  // Cross-links — dotted accent curves (match the on-screen rendering)
  if(map.links && map.links.length){
    ctx.save();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.setLineDash([2, 6]);
    ctx.globalAlpha = 0.85;
    map.links.forEach(lk=>{
      const a=map.nodes[lk.from], b=map.nodes[lk.to];
      if(!a||!b) return;
      const ax=a.x+(a.w||120)/2, ay=a.y+(a.h||40)/2;
      const bx=b.x+(b.w||120)/2, by=b.y+(b.h||40)/2;
      const mx=(ax+bx)/2, my=(ay+by)/2;
      const dx=bx-ax, dy=by-ay; const len=Math.hypot(dx,dy)||1;
      const off=Math.min(60, len*0.18);
      const cx=mx-(dy/len)*off, cy=my+(dx/len)*off;
      ctx.beginPath(); ctx.moveTo(ax,ay); ctx.quadraticCurveTo(cx,cy,bx,by); ctx.stroke();
    });
    ctx.restore();
  }

  // Nodes — also match shape per style
  const nodeRadius = (mapStyle==='bubble') ? 999 : (mapStyle==='classic' || mapStyle==='sketch') ? 4 : 12;
  ids.forEach(i=>{
    const n=map.nodes[i]; const isRoot=(i===map.rootId);
    const w=n.w||120, h=n.h||40;
    const r = Math.min(nodeRadius, h/2);
    roundRect(ctx, n.x, n.y, w, h, r);
    if(isRoot){
      ctx.fillStyle = map.color || accent;
    } else {
      ctx.fillStyle = n.color || themeNodeBg;
    }
    ctx.fill();
    if(!isRoot && mapStyle !== 'bubble'){
      ctx.strokeStyle = mapStyle==='sketch' ? themeInk : themeLine;
      ctx.lineWidth = mapStyle==='sketch' ? 2 : 1.5;
      ctx.stroke();
    }
    // Text — pick a color that contrasts with the node background
    const bg = isRoot ? (map.color || accent) : (n.color || themeNodeBg);
    const textFill = n.textColor || (isRoot ? pickContrast(bg) : (n.color ? pickContrast(n.color) : themeInk));
    const fontPx = n.fontSize || (isRoot ? 19 : 15);
    ctx.textBaseline='middle';
    // Highlight (background per text) — node-wide for the canvas export
    if(n.highlight){
      ctx.fillStyle = n.highlight;
      const padX = isRoot ? 22 : 15;
      ctx.fillRect(n.x+padX-2, n.y+4, w-padX*2+4, h-8);
    }
    // Render with inline B/I/U/S support, list bullets, line wrapping
    drawFormattedText(ctx, n.text||'', {
      x: n.x+(isRoot?22:15),
      y: n.y+h/2,
      maxWidth: w-(isRoot?44:30),
      fontPx,
      color: textFill,
      family: '"Bricolage Grotesque", sans-serif',
      baseBold: !!n.bold || isRoot,
      baseItalic: !!n.italic,
      baseUnderline: !!n.underline,
      baseStrike: !!n.strike,
      align: n.align || 'center',
      listType: n.listType || null
    });
    // Notes indicator — small white-circle dot with a 📝 glyph (top-right)
    const noteText = (n.notes||'').replace(/<[^>]*>/g,'').trim();
    if(noteText){
      const cx = (n.side==='left') ? n.x + 4 : n.x + w - 4;
      const cy = n.y + 4;
      ctx.beginPath();
      ctx.arc(cx, cy, 10, 0, Math.PI*2);
      ctx.fillStyle = themeNodeBg;
      ctx.fill();
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = themeLine;
      ctx.stroke();
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = themeInk;
      ctx.fillText('📝', cx, cy);
      ctx.textAlign = 'start';   // restore
      ctx.textBaseline = 'middle';
    }
  });

  cv.toBlob(b=>{download(b,(map.title||'mindmap')+'.png');toast('PNG exported');});
}

// Render text (possibly containing inline <b>/<i>/<u>/<s>/<a>/<br>/<ul>/<ol>/<li>)
// onto a canvas context at the given centre point, with word-wrap and per-line
// alignment. This is what makes the PNG export look like the browser render.
function drawFormattedText(ctx, html, opts){
  const { x, y, maxWidth, fontPx, color, family, baseBold, baseItalic, baseUnderline, baseStrike, align, listType } = opts;
  // Step 1: walk the HTML, collecting "runs" each with a formatting state.
  // \n separators come from <br>, end-of-li, and end-of-p/div blocks.
  const tmp = document.createElement('div');
  tmp.innerHTML = (html || '').toString();
  const runs = [];
  // legacy listType (whole-node bullets) — render as if each line of plain text
  // were wrapped in a <li>
  if(listType && !INLINE_HTML_RE.test(html||'')){
    const lines = (html||'').split('\n');
    lines.forEach((line, i)=>{
      const prefix = listType==='ol' ? `${i+1}. ` : '• ';
      runs.push({ text:prefix+line, bold:baseBold, italic:baseItalic, underline:baseUnderline, strike:baseStrike });
      if(i < lines.length-1) runs.push({ text:'\n', bold:false,italic:false,underline:false,strike:false });
    });
  } else {
    const walk = (node, st) => {
      node.childNodes.forEach(child => {
        if(child.nodeType === 3){
          // Split on \n so embedded newlines (Shift+Enter while editing) become
          // real line breaks in the export, not whitespace.
          const v = (child.nodeValue || '').replace(/\u00A0/g,' ');
          if(!v) return;
          const parts = v.split('\n');
          parts.forEach((p, i) => {
            if(i > 0) runs.push({ text:'\n', ...st });
            if(p) runs.push({ text:p, ...st });
          });
        } else if(child.nodeType === 1){
          const tag = child.tagName.toLowerCase();
          const next = { ...st };
          if(tag==='b'||tag==='strong') next.bold = true;
          if(tag==='i'||tag==='em')     next.italic = true;
          if(tag==='u')                 next.underline = true;
          if(tag==='s'||tag==='strike') next.strike = true;
          if(tag==='a'){ next.link = true; next.underline = true; }
          if(tag==='br'){ runs.push({ text:'\n', ...st }); return; }
          if(tag==='li'){
            // Push bullet/number prefix
            const isOL = child.parentElement && child.parentElement.tagName==='OL';
            const idx = child.parentElement ? Array.from(child.parentElement.children).indexOf(child)+1 : 1;
            runs.push({ text:(isOL ? `${idx}. ` : '• '), ...st });
          }
          walk(child, next);
          if(tag==='li' || tag==='p' || tag==='div') runs.push({ text:'\n', ...st });
        }
      });
    };
    walk(tmp, { bold:baseBold, italic:baseItalic, underline:baseUnderline, strike:baseStrike, link:false });
  }

  if(runs.length===0) return;

  // Step 2: word-wrap into lines. Each line = array of {text, w, bold, italic, underline, strike}
  const setFont = (run) => {
    let f='';
    if(run.italic) f += 'italic ';
    f += (run.bold ? 'bold ' : '500 ') + fontPx + 'px ' + family;
    ctx.font = f;
  };
  const lines = [[]];
  let curW = 0;
  runs.forEach(run => {
    if(run.text === '\n'){ lines.push([]); curW = 0; return; }
    // Keep whitespace as separate chunks so wrapping breaks on it
    const parts = run.text.split(/(\s+)/);
    parts.forEach(part => {
      if(!part) return;
      setFont(run);
      const w = ctx.measureText(part).width;
      if(curW + w > maxWidth && lines[lines.length-1].length > 0 && part.trim()){
        lines.push([]); curW = 0;
      }
      lines[lines.length-1].push({ text:part, w, bold:run.bold, italic:run.italic, underline:run.underline, strike:run.strike, link:run.link });
      curW += w;
    });
  });
  while(lines.length > 1 && lines[lines.length-1].length === 0) lines.pop();

  // Step 3: draw. Vertically centre block around y.
  const lineH = Math.round(fontPx * 1.35);
  const totalH = lines.length * lineH;
  let yy = y - totalH/2 + lineH/2;
  // Hyperlink colour (resolved from CSS var so it matches the live theme)
  const linkColor = (typeof getComputedStyle === 'function')
    ? (getComputedStyle(document.documentElement).getPropertyValue('--link').trim() || '#3a6ea5')
    : '#3a6ea5';
  ctx.fillStyle = color;
  lines.forEach(line => {
    const lineW = line.reduce((s, r) => s + r.w, 0);
    let xx = x;
    if(align === 'center') xx = x + (maxWidth - lineW)/2;
    else if(align === 'right') xx = x + (maxWidth - lineW);
    line.forEach(run => {
      setFont(run);
      const runColor = run.link ? linkColor : color;
      ctx.fillStyle = runColor;
      ctx.fillText(run.text, xx, yy);
      if(run.underline || run.strike){
        ctx.strokeStyle = runColor;
        ctx.lineWidth = Math.max(1, fontPx/15);
        ctx.beginPath();
        const ly = run.underline ? (yy + fontPx*0.38) : (yy - fontPx*0.18);
        ctx.moveTo(xx, ly); ctx.lineTo(xx + run.w, ly);
        ctx.stroke();
      }
      xx += run.w;
    });
    yy += lineH;
  });
}
// Pick black-or-white for best contrast against a hex background
function pickContrast(hex){
  const h = (hex||'').replace('#','');
  if(h.length < 6) return '#23201b';
  const r=parseInt(h.slice(0,2),16), g=parseInt(h.slice(2,4),16), b=parseInt(h.slice(4,6),16);
  // luminance roughly per WCAG
  const L = (0.299*r + 0.587*g + 0.114*b) / 255;
  return L > 0.6 ? '#23201b' : '#ffffff';
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
$('#newMapMenu')?.addEventListener('click', e => { e.stopPropagation(); showTemplatesMenu(); });
$('#emptyNew').onclick=createMap;
$('#addChild').onclick=()=>{ if(!map)return; addNode(sel||map.rootId,false); };
// Before printing, fit the whole map into view so nothing is clipped on paper.
window.addEventListener('beforeprint', ()=>{ try{ fit(); }catch(e){} });

$('#layout').onclick=autoLayout;            // re-tidies node positions (does NOT move the camera)
// Collapse-all / expand-all toggle. If any collapsible node is currently
// expanded, the first click collapses everything; otherwise it expands all.
$('#collapseAll')?.addEventListener('click', ()=>{
  if(!map) return;
  // Exclude the root: collapsing it would hide the whole map, and including it
  // (always expanded) would break the expand/collapse toggle detection.
  const collapsible = Object.keys(map.nodes).filter(id => id !== map.rootId && childrenOf(id).length > 0);
  if(!collapsible.length) return;
  const anyExpanded = collapsible.some(id => !map.nodes[id].collapsed);
  collapsible.forEach(id => { map.nodes[id].collapsed = anyExpanded; });
  pushHistory(); autoLayout();
  toast(anyExpanded ? 'Collapsed all branches' : 'Expanded all branches');
});
$('#undo').onclick=undo; $('#redo').onclick=redo;
$('#zoomIn').onclick=()=>zoom(1.15); $('#zoomOut').onclick=()=>zoom(.87); $('#zoomFit').onclick=fit;
$('#minimap')?.addEventListener('mousedown', e=>{ e.stopPropagation(); minimapJump(e.clientX, e.clientY); });
$('#minimap')?.addEventListener('click', e=>e.stopPropagation());
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
// On phones, default the sidebar to collapsed (slid off-screen overlay).
// And tapping the dimmed canvas while it's open should close it.
if(window.matchMedia('(max-width: 720px)').matches){
  $('#side').classList.add('collapsed');
  $('#stage').addEventListener('click', e=>{
    const side=$('#side');
    if(side.classList.contains('collapsed')) return;
    // Only close if the user tapped the dimming overlay (the ::after pseudo) —
    // which sits on top of all the topbar/zoombar at z-index 150. Easiest
    // proxy: tap landed on #stage or #viewport (not on a node or chrome).
    if(e.target.id==='stage' || e.target.id==='viewport'){
      side.classList.add('collapsed');
    }
  });
}
$('#hintClose').onclick=()=>$('#hint').style.display='none';

/* ---------- UI scale (whole-interface zoom, persisted) ---------- */
function getUiScale(){
  const v=parseFloat(localStorage.getItem('mindspark:uiScale'));
  return (v && v>=0.5 && v<=2) ? v : 1;
}
function applyUiScale(v){
  // CSS `zoom` on the root scales the entire UI uniformly — chrome and canvas —
  // like browser zoom, while keeping pointer/geometry math self-consistent.
  document.documentElement.style.zoom = (v && v!==1) ? String(v) : '';
}
function setUiScale(v){
  v = Math.min(2, Math.max(0.5, v||1));
  try{ localStorage.setItem('mindspark:uiScale', String(v)); }catch(e){}
  applyUiScale(v);
  toast('Interface scale: '+Math.round(v*100)+'%');
}

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

$('#varsBtn')?.addEventListener('click', showMapVariables);
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
    </div>
    <div class="tp-section">
      <div class="tp-label">Display size <span class="tp-hint">scales the whole interface</span></div>
      <div class="tp-scale">
        ${[80,90,100,110,125].map(p=>`
          <button class="scale-opt${p===getUiScale()*100?' active':''}" data-scale="${p}">${p}%</button>`).join('')}
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
  themePanel.querySelectorAll('.scale-opt').forEach(opt=>{
    opt.onclick=ev=>{
      ev.stopPropagation();
      setUiScale(parseInt(opt.dataset.scale,10)/100);
      themePanel.querySelectorAll('.scale-opt').forEach(o=>o.classList.remove('active'));
      opt.classList.add('active');
    };
  });
};
document.addEventListener('click',e=>{
  if(themePanel && !themePanel.contains(e.target) && e.target.id!=='themeBtn') closeThemePanel();
});
// Apply saved theme at boot. For first-time visitors, follow the OS preference
// (prefers-color-scheme) so dark-mode users get dark by default.
try{
  const saved = localStorage.getItem('mindspark:theme');
  if(saved) applyTheme(saved);
  else applyTheme(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}catch(e){}

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
  // UPI (India) — direct deep-link. Replace with your VPA.
  // Example: 'upi://pay?pa=yourname@okicici&pn=MindSpark&cu=INR'
  upi:     null,
  // UPI QR code — works on any device. Put the image as a data URL
  //   (paste a `data:image/png;base64,...` here)
  // or as an external URL (e.g., '/upi-qr.png' if you place the file in /public).
  upiQr:   null,
  upiNote: null,  // optional caption shown below the QR, e.g. "yourname@okicici"
  // GitHub Sponsors
  github:  null
};
const DONATE_AMOUNTS = [3, 5, 10, 25];

function showDonateModal(){
  document.querySelectorAll('.donate-modal').forEach(m=>m.remove());
  const m=document.createElement('div');
  m.className='donate-modal';
  const has = k => DONATE_CONFIG[k] && !String(DONATE_CONFIG[k]).includes('YOUR_USERNAME');
  const providers = [
    has('bmac')   && {k:'bmac',   label:'Buy Me a Coffee', icon:'☕', url:DONATE_CONFIG.bmac,   color:'#ffdd00', supportsAmount:false},
    has('kofi')   && {k:'kofi',   label:'Ko-fi',           icon:'♥', url:DONATE_CONFIG.kofi,   color:'#ff5e5b', supportsAmount:false},
    has('paypal') && {k:'paypal', label:'PayPal',          icon:'P', url:DONATE_CONFIG.paypal, color:'#0070ba', supportsAmount:true},
    has('upi')    && {k:'upi',    label:'UPI app (India)', icon:'₹', url:DONATE_CONFIG.upi,    color:'#5f259f', supportsAmount:true},
    has('upiQr')  && {k:'upiQr',  label:'Scan UPI QR',     icon:'⚌', url:null,                  color:'#5f259f', supportsAmount:false},
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
      if(p.k === 'upiQr'){ showUpiQrView(m); return; }
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

// ===== Focus mode — hide all chrome, show only the canvas =====
function toggleFocusMode(){
  const on = !document.body.classList.contains('focus-mode');
  document.body.classList.toggle('focus-mode', on);
  let exit = $('#focusExit');
  if(on){
    if(!exit){
      exit = document.createElement('button');
      exit.id = 'focusExit'; exit.className = 'focus-exit';
      exit.innerHTML = '⛶ Exit focus';
      exit.title = 'Exit focus mode (Esc)';
      exit.onclick = toggleFocusMode;
      document.body.appendChild(exit);
    }
    toast('Focus mode — Esc to exit');
  } else {
    exit?.remove();
  }
  // The viewport size changes when chrome is shown/hidden — wait for the layout
  // to settle, then recentre the map (keeping zoom) so it doesn't jump sideways.
  requestAnimationFrame(()=>requestAnimationFrame(()=>recenter()));
}
$('#focusBtn')?.addEventListener('click', toggleFocusMode);

// ===== Keyboard shortcuts help — press '?' to open =====
function showKeyboardHelp(){
  document.querySelectorAll('.kb-help').forEach(m=>m.remove());
  const m = document.createElement('div');
  m.className = 'kb-help';
  const shortcuts = [
    ['Building the map',[
      ['Tab',            'Add a child node'],
      ['Enter',          'Add a sibling node'],
      ['F2 / double-click', 'Edit the selected node'],
      ['Delete',         'Remove the selected node'],
      ['Space',          'Collapse / expand'],
      ['L',              'Cross-link to another node'],
      ['drag',           'Move node (subtree follows)'],
      ['drag onto node', 'Re-parent under that node'],
    ]],
    ['Navigation',[
      ['↑ ↓ ← →',        'Move selection between nodes'],
      ['scroll',         'Zoom canvas (mouse) / two-finger pinch (touch)'],
      ['drag canvas',    'Pan the map'],
    ]],
    ['Editing text',[
      ['Ctrl/⌘ + B / I / U', 'Bold / italic / underline the selection'],
      ['select + UL/OL btn', 'Make each selected line a bullet'],
      ['Shift + Enter',  'Newline within the node text'],
      ['Esc',            'Cancel an edit / close a popup'],
    ]],
    ['History',[
      ['Ctrl/⌘ + Z',     'Undo'],
      ['Ctrl/⌘ + Shift + Z',  'Redo'],
    ]]
  ];
  const renderTable = group => `
    <h3>${group[0]}</h3>
    <table>${group[1].map(r=>`<tr><td><kbd>${r[0]}</kbd></td><td>${r[1]}</td></tr>`).join('')}</table>`;
  m.innerHTML = `
    <div class="kb-backdrop"></div>
    <div class="kb-card">
      <button class="kb-close" aria-label="Close">×</button>
      <h2>Keyboard shortcuts</h2>
      <div class="kb-grid">${shortcuts.map(renderTable).join('')}</div>
      <p class="kb-foot">Press <kbd>?</kbd> any time to open this list.</p>
    </div>`;
  document.body.appendChild(m);
  const close=()=>m.remove();
  m.querySelector('.kb-close').onclick = close;
  m.querySelector('.kb-backdrop').onclick = close;
  m.addEventListener('keydown', e=>{ if(e.key==='Escape'){ e.preventDefault(); close(); } });
}
window.addEventListener('keydown', e=>{
  if(e.key !== '?') return;
  // Don't intercept when typing inside a text field / contentEditable
  if(e.target.isContentEditable) return;
  const tag = (e.target.tagName||'').toUpperCase();
  if(tag === 'INPUT' || tag === 'TEXTAREA') return;
  if(document.querySelector('.node.editing')) return;
  e.preventDefault();
  showKeyboardHelp();
});
// Esc exits focus mode (only when nothing else is open/focused)
window.addEventListener('keydown', e=>{
  if(e.key!=='Escape') return;
  if(!document.body.classList.contains('focus-mode')) return;
  // Don't fight with editing/notes/login overlay — they handle Esc themselves
  if(document.querySelector('.node.editing')) return;
  if(document.querySelector('.notes-popup')) return;
  if(document.querySelector('.donate-modal')) return;
  if($('#loginOverlay') && $('#loginOverlay').style.display==='flex') return;
  e.preventDefault();
  toggleFocusMode();
}, true);

// ===== GitHub source/issue link =====
// Set this to your repo and the sidebar footer links will go live.
const GITHUB_URL = 'https://github.com/YOUR_USERNAME/mindspark';
(function wireGitHub(){
  const ghOk = GITHUB_URL && !GITHUB_URL.includes('YOUR_USERNAME');
  const repo = $('#ghRepoLink'), issue = $('#ghIssueLink');
  if(ghOk){
    if(repo) repo.href = GITHUB_URL;
    if(issue) issue.href = GITHUB_URL.replace(/\/$/, '') + '/issues/new?labels=bug';
  } else {
    // Until configured, point at the canonical readme so the buttons aren't dead.
    // Replace these in app.js (search for GITHUB_URL) to publish your own repo.
    [repo,issue].forEach(a=>{ if(a){ a.href='#'; a.addEventListener('click',e=>{
      e.preventDefault();
      toast('Set GITHUB_URL in app.js to your repo URL');
    }); }});
  }
})();

// Swap the donate modal's card into a "scan UPI QR" view.
function showUpiQrView(modal){
  const card = modal.querySelector('.donate-card');
  // Save the original innerHTML so we can restore it via the back button
  if(!card.dataset.originalHTML) card.dataset.originalHTML = card.innerHTML;
  card.innerHTML = `
    <button class="donate-close" aria-label="Close">×</button>
    <button class="donate-back" aria-label="Back">← Back</button>
    <div class="qr-view">
      <h2>Scan to pay via UPI</h2>
      <p class="qr-sub">Open any UPI app (Google Pay, PhonePe, Paytm, BHIM) and scan the code below.</p>
      <div class="qr-frame">
        <img class="qr-image" src="${DONATE_CONFIG.upiQr}" alt="UPI QR code"/>
      </div>
      ${DONATE_CONFIG.upiNote ? `<div class="qr-note">${escapeHtml(DONATE_CONFIG.upiNote)}</div>` : ''}
      ${DONATE_CONFIG.upi ? `<a class="qr-deeplink" href="${DONATE_CONFIG.upi}">Or tap to open in your UPI app →</a>` : ''}
      <p class="qr-foot">Thank you for supporting MindSpark 💛</p>
    </div>`;
  card.querySelector('.donate-close').onclick = () => modal.remove();
  card.querySelector('.donate-back').onclick  = () => {
    card.innerHTML = card.dataset.originalHTML;
    showDonateModal();  // re-wire — easier than rebuilding events
    modal.remove();
  };
}
async function proceedBoot(){
  loadUserTemplates();   // merge any saved "My templates" into the catalog
  // A shared map queued for copying takes priority over loading the last map.
  if(await consumePendingImport()) return;
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

/* ============================================================
   ASYNC SHARING — read-only share links (no backend needed)

   The whole map is serialized, gzip-compressed (when the browser supports
   CompressionStream), and packed into the URL fragment. Opening the link
   decodes it and shows a read-only view. Nothing is sent to any server — the
   data lives entirely in the link, so recipients need no account.
   ============================================================ */
let READONLY = false;   // true while viewing a shared (read-only) map

function _b64urlFromBytes(bytes){
  let bin=''; const CH=0x8000;
  for(let i=0;i<bytes.length;i+=CH) bin+=String.fromCharCode.apply(null, bytes.subarray(i,i+CH));
  return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function _bytesFromB64url(s){
  s=s.replace(/-/g,'+').replace(/_/g,'/'); while(s.length%4) s+='=';
  const bin=atob(s), out=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) out[i]=bin.charCodeAt(i);
  return out;
}
async function _gzip(str){
  if(typeof CompressionStream==='undefined') return null;
  const cs=new CompressionStream('gzip');
  const w=cs.writable.getWriter(); w.write(new TextEncoder().encode(str)); w.close();
  const buf=await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(buf);
}
async function _gunzip(bytes){
  const ds=new DecompressionStream('gzip');
  const w=ds.writable.getWriter(); w.write(bytes); w.close();
  const buf=await new Response(ds.readable).arrayBuffer();
  return new TextDecoder().decode(buf);
}
function _shareePayload(m){
  return { v:1, title:m.title, color:m.color, style:m.style, layout:m.layout,
           rootId:m.rootId, nodes:m.nodes, links:m.links||[], vars:m.vars||{} };
}
async function buildShareLink(){
  const json=JSON.stringify(_shareePayload(map));
  const gz=await _gzip(json);
  const token = gz ? ('g'+_b64urlFromBytes(gz)) : ('r'+_b64urlFromBytes(new TextEncoder().encode(json)));
  return location.origin + location.pathname + '#view=' + token;
}
async function decodeShareToken(token){
  const scheme=token[0], body=token.slice(1);
  const bytes=_bytesFromB64url(body);
  const json = scheme==='g' ? await _gunzip(bytes) : new TextDecoder().decode(bytes);
  return JSON.parse(json);
}
async function copyShareLink(){
  if(!map) return;
  try{
    const url=await buildShareLink();
    const kb=Math.round(url.length/1024*10)/10;
    const finish=()=> toast(url.length>12000
      ? `Link copied (~${kb} KB) — very long links may not open everywhere; consider removing large images`
      : 'Read-only share link copied');
    if(navigator.clipboard?.writeText){
      navigator.clipboard.writeText(url).then(finish, ()=>showShareFallback(url));
    } else showShareFallback(url);
  }catch(e){ toast('Could not build share link'); }
}
function showShareFallback(url){
  document.querySelectorAll('.share-fallback').forEach(p=>p.remove());
  const m=document.createElement('div'); m.className='var-form share-fallback';
  m.innerHTML=`<div class="vf-backdrop"></div><div class="vf-card">
    <button class="vf-close">×</button><h2>Read-only share link</h2>
    <p class="vf-sub">Copy this link and send it to anyone — they can view (not edit) this map, no account needed.</p>
    <textarea class="vf-input" rows="4" readonly style="width:100%">${escapeHtml(url)}</textarea>
    <div class="vf-actions"><button class="vf-go primary">Copy</button></div></div>`;
  document.body.appendChild(m);
  m.addEventListener('mousedown',e=>e.stopPropagation());
  const ta=m.querySelector('textarea'); ta.focus(); ta.select();
  const close=()=>m.remove();
  m.querySelector('.vf-go').onclick=()=>{ ta.select(); try{document.execCommand('copy'); toast('Copied');}catch(e){} close(); };
  m.querySelector('.vf-close').onclick=close;
  m.querySelector('.vf-backdrop').onclick=close;
}
async function tryEnterSharedView(){
  const h=location.hash||'';
  const mt=h.match(/^#view=(.+)$/);
  if(!mt) return false;
  let payload;
  try{ payload=await decodeShareToken(mt[1]); }
  catch(e){ console.error('bad share link',e); return false; }
  READONLY=true;
  document.body.classList.add('shared-view');
  map={ id:'shared', title:payload.title||'Shared map', color:payload.color||'#e0613a',
        style:payload.style, layout:payload.layout, rootId:payload.rootId,
        nodes:payload.nodes||{}, links:payload.links||[], vars:payload.vars||{} };
  sel=null;
  $('#mapTitle').value=map.title; $('#mapTitle').readOnly=true;
  render(); fit();
  showSharedBanner();
  return true;
}
function showSharedBanner(){
  if($('#sharedBanner')) return;
  const b=document.createElement('div'); b.id='sharedBanner'; b.className='shared-banner';
  b.innerHTML=`<span class="sb-eye">👁</span>
    <span class="sb-text">You're viewing a shared map — <b>read-only</b></span>
    <button class="sb-copy" id="sbCopy">Make an editable copy</button>
    <a class="sb-brand" href="${location.origin+location.pathname}" title="Open MindSpark">MindSpark</a>`;
  document.body.appendChild(b);
  b.addEventListener('mousedown',e=>e.stopPropagation());
  $('#sbCopy').onclick=()=>{
    try{ sessionStorage.setItem('mindspark:pendingImport', JSON.stringify(_shareePayload(map))); }catch(e){}
    location.href = location.origin + location.pathname;
  };
}
async function consumePendingImport(){
  let raw; try{ raw=sessionStorage.getItem('mindspark:pendingImport'); }catch(e){ return false; }
  if(!raw) return false;
  try{ sessionStorage.removeItem('mindspark:pendingImport'); }catch(e){}
  let p; try{ p=JSON.parse(raw); }catch(e){ return false; }
  const id=uid();
  map={ id, title:(p.title||'Shared map')+' (copy)', titleAuto:false, color:p.color||'#e0613a',
        style:p.style, layout:p.layout, rootId:p.rootId, nodes:p.nodes||{},
        links:p.links||[], vars:p.vars||{}, updated:Date.now() };
  sel=map.rootId; history=[]; hpos=-1; pushHistory();
  $('#mapTitle').value=map.title;
  render(); fit();
  if(typeof Store!=='undefined' && Store){ try{ await Store.save(map); }catch(e){} }
  refreshList();
  toast('Editable copy created');
  return true;
}

(async()=>{
  // Read-only shared link? Decode and render a view-only map — no store, no
  // login, no account needed by the recipient.
  if(await tryEnterSharedView()) return;
  const {mode, loggedIn} = await initStore();
  if(mode==='cloud'){
    if(loggedIn){ showUserPill(); await proceedBoot(); }
    else { showLoginOverlay(); }
  } else {
    await proceedBoot();
  }
})().catch(e=>{ console.error(e); if(!map) createMap(); });
