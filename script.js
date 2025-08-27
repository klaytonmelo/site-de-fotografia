  const DB_NAME = 'foto-galeria';
  const DB_VERSION = 1;
  const STORE = 'fotos';

  function openDB(){
    return new Promise((resolve, reject)=>{
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if(!db.objectStoreNames.contains(STORE)){
          const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          store.createIndex('by_name','name',{unique:false});
          store.createIndex('by_created','createdAt',{unique:false});
        }
      };
      req.onsuccess = ()=> resolve(req.result);
      req.onerror = ()=> reject(req.error);
    });
  }

  function withStore(mode, fn){
    return openDB().then(db=> new Promise((resolve, reject)=>{
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      const res = fn(store);
      tx.oncomplete = ()=> resolve(res);
      tx.onerror = ()=> reject(tx.error);
    }));
  }

  const Fotos = {
    add: (record)=> withStore('readwrite', store=> store.add(record)),
    delete: (id)=> withStore('readwrite', store=> store.delete(id)),
    clear: ()=> withStore('readwrite', store=> store.clear()),
    all: ()=> withStore('readonly', store=> new Promise((resolve)=>{
      const out=[]; const req = store.openCursor();
      req.onsuccess = ()=>{
        const cur = req.result; if(cur){ out.push(cur.value); cur.continue(); } else resolve(out);
      };
    })),
    bulkAdd: (records)=> withStore('readwrite', store=> Promise.all(records.map(r=> new Promise((resolve,reject)=>{ const req=store.add(r); req.onsuccess=()=>resolve(); req.onerror=()=>reject(req.error);}))))
  };

  // Helpers
  const $ = (sel, root=document)=> root.querySelector(sel);
  const $$ = (sel, root=document)=> Array.from(root.querySelectorAll(sel));
  function humanSize(n){
    const u=['B','KB','MB','GB']; let i=0; while(n>=1024 && i<u.length-1){n/=1024;i++} return `${n.toFixed( i?1:0 )} ${u[i]}`;
  }

  // UI refs
  const dom = {
    uploader: $('#uploader'),
    input: $('#fileInput'),
    gallery: $('#gallery'),
    search: $('#search'),
    count: $('#count'),
    empty: $('#emptyState'),
    clearAll: $('#clearAll'),
    exportJson: $('#exportJson'),
    importJson: $('#importJson'),
  };

  // Render
  let cache = [];
  async function render(filter=''){
    const term = filter.trim().toLowerCase();
    const items = term? cache.filter(f=> f.name.toLowerCase().includes(term)) : cache;
    dom.gallery.innerHTML = '';
    if(!items.length){ dom.empty.hidden=false; dom.count.textContent = '0 itens'; return; }
    dom.empty.hidden=true; dom.count.textContent = `${items.length} ${items.length===1? 'item':'itens'}`;

    for(const f of items){
      const card = document.createElement('article'); card.className='card';
      const t = document.createElement('div'); t.className='thumb';
      const img = document.createElement('img'); img.alt = f.name; img.loading='lazy';
      img.src = URL.createObjectURL(f.blob);
      t.appendChild(img);

      const meta = document.createElement('div'); meta.className='meta';
      const name = document.createElement('div'); name.className='name'; name.title=f.name; name.textContent=f.name;
      const small = document.createElement('div'); small.className='muted';
      small.textContent = `${humanSize(f.size)} • ${new Date(f.createdAt).toLocaleString()}`;

      const row = document.createElement('div'); row.className='row';
      const dl = document.createElement('a'); dl.className='btn small'; dl.download=f.name; dl.textContent='Baixar';
      dl.href = URL.createObjectURL(f.blob);
      const rm = document.createElement('button'); rm.className='danger small'; rm.textContent='Excluir';
      rm.onclick = async ()=>{ await Fotos.delete(f.id); await load(); };

      row.append(dl, rm);
      meta.append(name, small, row);
      card.append(t, meta);
      dom.gallery.append(card);
    }
  }

  async function load(){
    cache = await Fotos.all();
    render(dom.search.value);
  }

  // Upload handlers
  async function handleFiles(files){
    const list = Array.from(files).filter(f=> f.type.startsWith('image/'));
    if(!list.length) return;

    const records = await Promise.all(list.map(async file=>{
      const blob = file.slice(0, file.size, file.type); // ensure Blob type
      return {
        name: file.name,
        type: file.type,
        size: file.size,
        createdAt: Date.now(),
        blob,
      };
    }));

    for(const rec of records){ await Fotos.add(rec); }
    await load();
  }

  // Drag & drop
  ['dragenter','dragover'].forEach(ev=> dom.uploader.addEventListener(ev, e=>{ e.preventDefault(); dom.uploader.classList.add('dragover'); }));
  ;['dragleave','drop'].forEach(ev=> dom.uploader.addEventListener(ev, e=>{ e.preventDefault(); dom.uploader.classList.remove('dragover'); }));
  dom.uploader.addEventListener('drop', e=> handleFiles(e.dataTransfer.files));
  dom.uploader.addEventListener('click', ()=> dom.input.click());
  dom.input.addEventListener('change', e=> handleFiles(e.target.files));

  // Search
  dom.search.addEventListener('input', ()=> render(dom.search.value));

  // Clear all
  dom.clearAll.addEventListener('click', async ()=>{
    if(confirm('Tem certeza que deseja apagar TODAS as fotos desta galeria local?')){
      await Fotos.clear(); await load();
    }
  });

  // Import/Export
  dom.exportJson.addEventListener('click', async ()=>{
    const items = await Fotos.all();
    const payload = items.map(i=> ({...i, blob: undefined}));
    // exporta blobs em paralelo como URLs de dados Base64
    const blobs = await Promise.all(items.map(i=> blobToBase64(i.blob)));
    payload.forEach((p,idx)=> p.base64 = blobs[idx]);

    const file = new Blob([JSON.stringify({version:1, items:payload})], {type:'application/json'});
    dom.exportJson.href = URL.createObjectURL(file);
  });

  dom.importJson.addEventListener('change', async (e)=>{
    const file = e.target.files[0]; if(!file) return;
    const text = await file.text();
    try{
      const data = JSON.parse(text);
      if(!data.items) throw new Error('Arquivo inválido');
      const records = await Promise.all(data.items.map(async it=> ({
        name: it.name, type: it.type, size: it.size, createdAt: it.createdAt || Date.now(), blob: base64ToBlob(it.base64, it.type)
      })));
      await Fotos.bulkAdd(records); await load();
    }catch(err){ alert('Falha ao importar: ' + err.message); }
    e.target.value = '';
  });

  function blobToBase64(blob){
    return new Promise((resolve)=>{
      const r = new FileReader(); r.onload = ()=> resolve(r.result); r.readAsDataURL(blob);
    });
  }
  function base64ToBlob(dataUrl, type){
    const arr = dataUrl.split(',');
    const bstr = atob(arr[1]);
    let n = bstr.length; const u8 = new Uint8Array(n);
    while(n--){ u8[n] = bstr.charCodeAt(n); }
    return new Blob([u8], {type});
  }

  // Inicialização
  load();