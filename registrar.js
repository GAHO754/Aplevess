// registrar.js — RTDB + Cámara + OCR AUTO (sin botón) + UI BLOQUEADA
(() => {
  const $ = id => document.getElementById(id);

  // ===== Firebase =====
  const auth = firebase.auth();
  const db   = firebase.database();

  // ===== UI =====
  const fileInput    = $('ticketFile');
  const dropzone     = $('dropzone');
  const btnPickFile  = $('btnSeleccionarArchivo');
  const btnCam       = $('btnAbrirCamara');
  const modal        = $('cameraModal');
  const btnClose     = $('btnCerrarCamara');
  const video        = $('cameraVideo');
  const btnShot      = $('btnCapturar');
  const ocrStatus    = $('ocrStatus');

  const iNum   = $('inputTicketNumero');
  const iFecha = $('inputTicketFecha');
  const iTotal = $('inputTicketTotal');

  const listaProd    = $('listaProductos');
  const btnRegistrar = $('btnRegistrarTicket');
  const msgTicket    = $('ticketValidacion');
  const greetEl      = $('userGreeting');

  const tablaPuntosBody = ($('tablaPuntos')||{}).querySelector?.('tbody');
  const totalPuntosEl   = $('totalPuntos');

  // ===== Políticas =====
  const VENCE_DIAS = 180; // ~6 meses
  const DAY_LIMIT  = 2;   // máx tickets por día

  // ===== Estado =====
  let isLogged = false;
  let liveStream = null;
  let currentPreviewURL = null;
  let productos = []; // [{ name, qty, price, pointsUnit }]

  // ===== Puntos por categoría =====
  const KW = {
    burgers:["burger","hamburguesa","cheeseburger","bacon"],
    costillas:["ribs","costillas"],
    cortes:["steak","sirloin","ribeye","rib eye","new york","arrachera"],
    pescado:["salmon","salmón","tilapia","pescado","shrimp","camarones","fish & chips","fish and chips"],
    pollo:["pollo","chicken","tenders"],
    pastas:["pasta","alfredo","fettuccine","parm","pomodoro","lasagna","lasaña"],
    texmex:["fajita","fajitas","tacos","quesadilla","enchilada","burrito","skillet"],
    alitas:["alitas","wings","boneless"],
    entradas:["entrada","sampler","mozzarella","nachos","chips","dip","onion rings","aros de cebolla"],
    ensaladas:["ensalada","salad"],
    sopas:["sopa","soup"],
    postres:["postre","dessert","brownie","cheesecake","blondie","helado","nieve","pie","pastel"],
    cocteles:["margarita","mojito","martini","paloma","piña colada","pina colada","gin tonic","aperol","spritz"],
    alcohol:["cerveza","beer","vino","mezcal","tequila","whisky","ron","vodka","gin"],
    bebidas:["refresco","soda","coca","pepsi","sprite","fanta","limonada","agua","jugo","iced tea","malteada","shake","smoothie"],
    calientes:["cafe","café","latte","espresso","té","te","chocolate"]
  };
  const POINT_RANGES = {
    burgers:[7,15], costillas:[7,15], cortes:[7,15], pescado:[6,14], pollo:[6,13], pastas:[6,13], texmex:[6,14],
    alitas:[4,10], entradas:[3,9], ensaladas:[3,9], sopas:[3,8], postres:[4,10], cocteles:[4,10],
    alcohol:[3,9], bebidas:[2,7], calientes:[2,6], other:[1,5]
  };
  const hashInt = (s)=>{ let h=2166136261>>>0; for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619);} return h>>>0; };
  const seededRandInt = (seed,min,max)=>{ const r=(hashInt(String(seed))%10000)/10000; return Math.floor(min + r*(max-min+1)); };
  function detectCategory(name){
    const n = String(name||'').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
    for (const k of ["burgers","costillas","cortes","pescado","pollo","pastas","texmex","alitas","entradas","ensaladas","sopas","postres","cocteles","alcohol","bebidas","calientes"]) {
      if (KW[k].some(w=>n.includes(w))) return k;
    }
    return "other";
  }
  function assignPointsForProduct(name, price){
    let cat = detectCategory(name);
    let [minP,maxP] = POINT_RANGES[cat] || POINT_RANGES.other;
    if (cat==="other" && typeof price==="number"){
      if (price>=600) [minP,maxP]=[12,15];
      else if (price>=250) [minP,maxP]=[8,12];
      else if (price>=120) [minP,maxP]=[5,9];
      else [minP,maxP]=[1,5];
    }
    const seed = `${name}|${Math.round(price||0)}`;
    return seededRandInt(seed,minP,maxP);
  }

  // ===== Helpers =====
  function setStatus(msg, type='') {
    if (!ocrStatus) return;
    ocrStatus.className = 'validacion-msg';
    if (type) ocrStatus.classList.add(type); // ok | err
    ocrStatus.textContent = msg || '';
  }
  function disableAllEdits() {
    [iNum,iFecha,iTotal].forEach(x=>{ if(x){ x.readOnly = true; x.disabled = true; }});
  }
  function setPreview(file) {
    if (currentPreviewURL) URL.revokeObjectURL(currentPreviewURL);
    const url = URL.createObjectURL(file);
    currentPreviewURL = url;
    dropzone?.querySelectorAll('img.preview').forEach(n => n.remove());
    if (dropzone) {
      const img = document.createElement('img');
      img.className = 'preview';
      img.alt = 'Vista previa ticket';
      img.src = url;
      dropzone.appendChild(img);
    }
  }
  function dataURLtoBlob(dataURL) {
    const [meta, b64] = dataURL.split(',');
    const mime = meta.split(':')[1].split(';')[0];
    const bin = atob(b64);
    const ab = new ArrayBuffer(bin.length);
    const ia = new Uint8Array(ab);
    for (let i=0;i<bin.length;i++) ia[i] = bin.charCodeAt(i);
    return new Blob([ab], { type: mime });
  }
  function setFileInputFromBlob(blob, name='ticket.jpg') {
    const file = new File([blob], name, { type: blob.type||'image/jpeg', lastModified: Date.now() });
    const dt = new DataTransfer();
    dt.items.add(file);
    if (fileInput) fileInput.files = dt.files;
    setPreview(file);
    return file;
  }

  async function autoProcessCurrentFile() {
    const file = fileInput?.files?.[0];
    if (!file) {
      setStatus("Sube o toma la foto del ticket primero.", "err");
      return;
    }
    if (typeof window.processTicketWithIA === "function") {
      setStatus("🕐 Escaneando ticket…");
      await window.processTicketWithIA(file);
    } else {
      console.warn("[autoProcess] processTicketWithIA no está disponible. Revisa ocr.js");
      setStatus("No se pudo iniciar el OCR. Revisa la consola.", "err");
    }
  }

  // ===== Cámara =====
  async function openCamera() {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus("Tu navegador no soporta cámara. Usa Adjuntar foto.", "err"); return;
      }
      video.muted = true; video.setAttribute('playsinline','true');
      const tries = [
        { video:{ facingMode:{exact:"environment"}, width:{ideal:1920}, height:{ideal:1080} }, audio:false },
        { video:{ facingMode:{ideal:"environment"},  width:{ideal:1920}, height:{ideal:1080} }, audio:false },
        { video:true, audio:false }
      ];
      let stream=null,lastErr=null;
      for (const c of tries){ try{ stream=await navigator.mediaDevices.getUserMedia(c); break; } catch(e){ lastErr=e; } }
      if (!stream) throw lastErr||new Error("No se pudo abrir la cámara");

      liveStream=stream; video.srcObject=stream;
      modal.style.display='flex'; modal.setAttribute('aria-hidden','false');
      await video.play(); setStatus('');
    } catch(e){
      console.error("getUserMedia:",e);
      let msg="No se pudo acceder a la cámara. Revisa permisos del navegador.";
      if ((!window.isSecureContext && location.hostname!=='localhost') || (location.protocol!=='https:' && location.hostname!=='localhost')){
        msg+=" (En móviles abre el sitio con HTTPS).";
      }
      setStatus(msg,"err"); fileInput?.click();
    }
  }
  function stopCamera(){
    if (liveStream){ liveStream.getTracks().forEach(t=>t.stop()); liveStream=null; }
    modal.style.display='none'; modal.setAttribute('aria-hidden','true');
  }
  async function captureFrame(){
    const w=video.videoWidth, h=video.videoHeight;
    if (!w||!h){ setStatus("Cámara aún no lista. Intenta de nuevo.","err"); return; }
    const c=document.createElement('canvas'); c.width=w; c.height=h;
    const ctx = c.getContext('2d');
    // ligera mejora visual para OCR
    ctx.filter = "contrast(1.15) brightness(1.05) saturate(1.05)";
    ctx.drawImage(video,0,0,w,h);
    stopCamera();
    const dataURL=c.toDataURL("image/jpeg",.95);
    const blob=dataURLtoBlob(dataURL);
    setFileInputFromBlob(blob,`ticket_${Date.now()}.jpg`);
    setStatus("📎 Foto capturada. Procesando OCR…","ok");
    await autoProcessCurrentFile(); // AUTO
  }
  btnCam?.addEventListener('click', openCamera);
  btnClose?.addEventListener('click', stopCamera);
  btnShot?.addEventListener('click', captureFrame);

  // ===== Subir archivo (AUTO) =====
  btnPickFile?.addEventListener('click', ()=> fileInput?.click());
  fileInput?.addEventListener('change', async e=>{
    const f=e.target.files&&e.target.files[0];
    if (f){
      setPreview(f);
      setStatus("📎 Imagen cargada. Procesando OCR…","ok");
      await autoProcessCurrentFile(); // AUTO
    }
  });

  // ===== Drag & Drop (AUTO) =====
  if (dropzone) {
    dropzone.addEventListener('click', ()=> fileInput?.click());
    dropzone.addEventListener('dragover', e => {
      e.preventDefault(); dropzone.classList.add('drag');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
    dropzone.addEventListener('drop', async e => {
      e.preventDefault(); dropzone.classList.remove('drag');
      if (e.dataTransfer.files?.length) {
        const dt = new DataTransfer();
        dt.items.add(e.dataTransfer.files[0]);
        fileInput.files = dt.files;
        setPreview(e.dataTransfer.files[0]);
        setStatus("📎 Imagen cargada. Procesando OCR…","ok");
        await autoProcessCurrentFile(); // AUTO
      }
    });
  }

  // ===== Productos (solo lectura) =====
  function upsertProducto(nombre, cantidad=1, price=null){
    nombre=String(nombre||'').trim(); if(!nombre) return;
    const pointsUnit = assignPointsForProduct(nombre, typeof price==='number'?price:null);
    const idx = productos.findIndex(p=>p.name.toLowerCase()===nombre.toLowerCase());
    if (idx>=0){
      productos[idx].qty += cantidad;
      if (typeof price==='number'){ productos[idx].price = +((productos[idx].price||0)+price).toFixed(2); }
    } else {
      productos.push({ name:nombre, qty:cantidad, price: price??null, pointsUnit });
    }
    renderProductos();
  }
  function renderProductos(){
    if (!listaProd) return;
    listaProd.innerHTML='';
    productos.forEach(p=>{
      const chip=document.createElement('div');
      chip.className='chip readonly';
      chip.innerHTML=`<span>${p.name}</span><span class="qty"><strong>${p.qty}</strong></span><span class="pts">${p.pointsUnit} pts/u</span>`;
      listaProd.appendChild(chip);
    });
    updatePuntosResumen();
  }
  function updatePuntosResumen(){
    if (!tablaPuntosBody) return;
    tablaPuntosBody.innerHTML='';
    let total=0;
    productos.forEach(p=>{
      const sub=p.pointsUnit*p.qty; total+=sub;
      const tr=document.createElement('tr');
      tr.innerHTML=`<td>${p.name}</td><td>${p.qty}</td><td>${p.pointsUnit}</td><td>${sub}</td>`;
      tablaPuntosBody.appendChild(tr);
    });
    if (totalPuntosEl) totalPuntosEl.textContent=String(total);
  }
  function getPuntosDetalle(){
    let total=0;
    const detalle=productos.map(p=>{
      const sub=p.pointsUnit*p.qty; total+=sub;
      return { producto:p.name, cantidad:p.qty, puntos_unitarios:p.pointsUnit, puntos_subtotal:sub };
    });
    return { total, detalle };
  }

  // ===== Guardar =====
  function addMonths(date, months){ const d=new Date(date.getTime()); d.setMonth(d.getMonth()+months); return d; }
  function startEndOfToday(){ const s=new Date(); s.setHours(0,0,0,0); const e=new Date(); e.setHours(23,59,59,999); return {start:s.getTime(), end:e.getTime()}; }
  function ymdFromISO(iso){ return String(iso||'').replace(/-/g,''); }

  async function registrarTicketRTDB(){
    const user=auth.currentUser;
    if (!user){ msgTicket.className='validacion-msg err'; msgTicket.textContent="Debes iniciar sesión para registrar."; return; }

    const folio=(iNum.value||'').trim().toUpperCase();
    const fechaStr=iFecha.value;
    const totalNum=parseFloat(iTotal.value||"0")||0;

    if (!/^\d{5}$/.test(folio) || !fechaStr || !totalNum){
      msgTicket.className='validacion-msg err';
      msgTicket.textContent="Faltan datos válidos: folio (5 dígitos), fecha y total."; return;
    }

    // Puntos desde productos (o fallback por total)
    let { total: puntosTotal, detalle } = getPuntosDetalle();
    if (puntosTotal <= 0){
      let pts;
      if (totalNum >= 600) pts = 14;
      else if (totalNum >= 400) pts = 12;
      else if (totalNum >= 250) pts = 10;
      else if (totalNum >= 120) pts = 7;
      else pts = 4;

      productos = [{ name:"Consumo Applebee's", qty:1, price: totalNum, pointsUnit: pts }];
      detalle   = [{ producto:"Consumo Applebee's", cantidad:1, puntos_unitarios:pts, puntos_subtotal:pts }];
      puntosTotal = pts;
      renderProductos();
    }

    const puntosEnteros = Math.round(puntosTotal);

    // Límite por día
    if (DAY_LIMIT>0){
      try{
        const {start,end}=startEndOfToday();
        const qs=db.ref(`users/${user.uid}/tickets`).orderByChild('createdAt').startAt(start).endAt(end);
        const snap=await qs.once('value');
        const countToday=snap.exists()?Object.keys(snap.val()).length:0;
        if (countToday>=DAY_LIMIT){
          msgTicket.className='validacion-msg err'; msgTicket.textContent=`⚠️ Ya registraste ${DAY_LIMIT} tickets hoy.`; return;
        }
      }catch(err){ console.warn('No pude verificar límite diario:',err); }
    }

    const fecha=new Date(`${fechaStr}T00:00:00`);
    const vencePuntos=addMonths(fecha, VENCE_DIAS/30);
    const userRef   = db.ref(`users/${user.uid}`);
    const ticketRef = userRef.child(`tickets/${folio}`);
    const pointsRef = userRef.child('points');

    const ymd = ymdFromISO(fechaStr);
    const indexRef = db.ref(`ticketsIndex/${ymd}/${folio}`);

    try{
      // Índice anti-duplicado
      const idxTx = await indexRef.transaction(curr=>{ if (curr) return; return { uid:user.uid, createdAt:Date.now() }; });
      if (!idxTx.committed){
        msgTicket.className='validacion-msg err'; msgTicket.textContent="❌ Este folio ya fue registrado para esa fecha."; return;
      }

      // Crea ticket
      const res = await ticketRef.transaction(current=>{
        if (current) return;
        return {
          folio,
          fecha: fechaStr,
          total: totalNum,
          productos: productos.map(p=>({ nombre:p.name, cantidad:p.qty, precioLinea:p.price ?? null, puntos_unitarios:p.pointsUnit })),
          puntos: { total: puntosEnteros, detalle },
          // campos planos redundantes (compatibilidad con panel)
          puntosTotal: puntosEnteros,
          points: puntosEnteros,
          vencePuntos: vencePuntos.getTime(),
          createdAt: Date.now()
        };
      });
      if (!res.committed){
        msgTicket.className='validacion-msg err'; msgTicket.textContent="❌ Este ticket ya está en tu cuenta."; return;
      }

      // Suma al saldo
      await pointsRef.transaction(curr => (Number(curr)||0) + puntosEnteros);

      msgTicket.className='validacion-msg ok';
      msgTicket.textContent=`✅ Ticket registrado. Puntos: ${puntosEnteros}`;
      setTimeout(()=>{ window.location.href='panel.html'; }, 1200);
    }catch(e){
      console.error(e);
      msgTicket.className='validacion-msg err';
      if (String(e).includes('Permission denied')){
        msgTicket.textContent="Permiso denegado por Realtime Database. Revisa las reglas.";
      }else{
        msgTicket.textContent="No se pudo registrar el ticket. Revisa tu conexión e inténtalo de nuevo.";
      }
    }
  }

  // ===== Sesión y eventos =====
  auth.onAuthStateChanged(user=>{
    isLogged=!!user;
    if (!user){ greetEl && (greetEl.textContent="Inicia sesión para registrar tickets"); btnRegistrar && (btnRegistrar.disabled=true); }
    else { greetEl && (greetEl.textContent=`Registro de ticket — ${user.email}`); btnRegistrar && (btnRegistrar.disabled=false); }
  });

  // recibe productos desde ocr.js
  document.addEventListener('ocr:productos', ev=>{
    const det = ev.detail || [];
    productos = [];
    if (Array.isArray(det)) det.forEach(p => upsertProducto(p.name, p.qty||1, typeof p.price==='number'?p.price:null));
  });

  btnRegistrar?.addEventListener('click', registrarTicketRTDB);

  // init
  disableAllEdits();
  if (tablaPuntosBody) tablaPuntosBody.innerHTML='';

  // ===== Logs de errores =====
  window.addEventListener("error", (e) => {
    console.error("[window error]", e.error || e.message || e);
  });
  window.addEventListener("unhandledrejection", (e) => {
    console.error("[promise rejection]", e.reason || e);
  });
})();
