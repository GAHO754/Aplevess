// registrar.js — RTDB + Cámara + OCR + UI BLOQUEADA (puntos auto 1–15)
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

  const btnOCR       = $('btnProcesarTicket'); // el procesamiento real está en ocr.js
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
  const VENCE_DIAS = 180; // meses aprox.
  const DAY_LIMIT  = 2;   // máx. tickets por día

  // ===== Estado =====
  let isLogged = false;
  let liveStream = null;
  let currentPreviewURL = null;
  // productos = [{ name, qty, price, pointsUnit }]
  let productos = [];

  // ===== Asignación de puntos 1–15 según categoría =====
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
    for(const k of ["burgers","costillas","cortes","pescado","pollo","pastas","texmex","alitas","entradas","ensaladas","sopas","postres","cocteles","alcohol","bebidas","calientes"]){
      if (KW[k].some(w=>n.includes(w))) return k;
    }
    return "other";
  }
  function assignPointsForProduct(name, price){
    let cat = detectCategory(name);
    let [minP,maxP] = POINT_RANGES[cat] || POINT_RANGES.other;
    if (cat==="other" && typeof price==="number"){
      if (price>=250) [minP,maxP]=[10,15];
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
  }

  // ===== Cámara =====
  async function openCamera() {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus("Tu navegador no soporta cámara. Usa Adjuntar foto.", "err");
        return;
      }
      video.muted = true;
      video.setAttribute('playsinline','true');

      const tries = [
        { video: { facingMode: { exact: "environment" }, width:{ideal:1920}, height:{ideal:1080} }, audio:false },
        { video: { facingMode: { ideal: "environment" },  width:{ideal:1920}, height:{ideal:1080} }, audio:false },
        { video: true, audio:false }
      ];
      let stream = null, lastErr = null;
      for (const c of tries) { try { stream = await navigator.mediaDevices.getUserMedia(c); break; } catch(e){ lastErr = e; } }
      if (!stream) throw lastErr || new Error("No se pudo abrir la cámara");

      liveStream = stream;
      video.srcObject = stream;
      modal.style.display = 'flex';
      modal.setAttribute('aria-hidden','false');
      await video.play();
      setStatus('');
    } catch (e) {
      console.error("getUserMedia:", e);
      let msg = "No se pudo acceder a la cámara. Revisa permisos del navegador.";
      if ((!window.isSecureContext && location.hostname !== 'localhost') ||
          (location.protocol !== 'https:' && location.hostname !== 'localhost')) {
        msg += " (En móviles debes abrir el sitio con HTTPS).";
      }
      setStatus(msg, "err");
      fileInput?.click(); // Fallback
    }
  }
  function stopCamera() {
    if (liveStream) { liveStream.getTracks().forEach(t=>t.stop()); liveStream = null; }
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden','true');
  }
  async function captureFrame() {
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) { setStatus("Cámara aún no lista. Intenta de nuevo.", "err"); return; }

    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(video, 0, 0, w, h);

    stopCamera();

    let dataURL;
    if (window.cv && window.cv.Mat) {
      try { dataURL = processWithOpenCV(c); }
      catch(e){ console.warn("OpenCV falló:", e); dataURL = c.toDataURL("image/jpeg", .95); }
    } else {
      dataURL = c.toDataURL("image/jpeg", .95);
    }
    const blob = dataURLtoBlob(dataURL);
    setFileInputFromBlob(blob, `ticket_${Date.now()}.jpg`);

    setStatus("Foto capturada. Procesa con OCR…", "ok");
    btnOCR?.click(); // dispara el flujo de OCR (ocr.js)
  }
  function processWithOpenCV(canvasEl) {
    const cv = window.cv;
    let src = cv.imread(canvasEl);
    let dst = new cv.Mat();
    let gray = new cv.Mat();
    let blurred = new cv.Mat();
    let canny = new cv.Mat();
    let contours = new cv.MatVector();
    let hierarchy = new cv.Mat();
    let best = null;
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
      cv.GaussianBlur(gray, blurred, new cv.Size(5,5), 0,0, cv.BORDER_DEFAULT);
      cv.Canny(blurred, canny, 75, 200, 3, false);
      cv.findContours(canny, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

      let maxArea = 0;
      for (let i=0;i<contours.size();i++){
        const cont = contours.get(i);
        const area = cv.contourArea(cont);
        if (area < 15000) continue;
        const peri = cv.arcLength(cont, true);
        const approx = new cv.Mat();
        cv.approxPolyDP(cont, approx, .02*peri, true);
        if (approx.rows === 4 && area > maxArea) { if (best) best.delete(); best = approx; maxArea = area; } else { approx.delete(); }
      }

      let outCanvas = document.createElement('canvas');
      if (best) {
        const pts = [];
        for (let i=0;i<best.rows;i++) pts.push({x: best.data32S[i*2], y: best.data32S[i*2+1]});
        const [tl,tr,br,bl] = (function orderQuad(pts){
          const rect = new Array(4);
          const s = pts.map(p=>p.x+p.y);
          const d = pts.map(p=>p.y-p.x);
          rect[0] = pts[s.indexOf(Math.min(...s))]; // tl
          rect[2] = pts[s.indexOf(Math.max(...s))]; // br
          rect[1] = pts[d.indexOf(Math.min(...d))]; // tr
          rect[3] = pts[d.indexOf(Math.max(...d))]; // bl
          return rect;
        })(pts);

        const wA = Math.hypot(br.x-bl.x, br.y-bl.y);
        const wB = Math.hypot(tr.x-tl.x, tr.y-tl.y);
        const hA = Math.hypot(tr.x-br.x, tr.y-br.y);
        const hB = Math.hypot(tl.x-bl.x, tl.y-bl.y);
        const W = Math.max(wA,wB), H = Math.max(hA,hB);

        const dSize = new cv.Size(Math.max(300, Math.floor(W)), Math.max(400, Math.floor(H)));
        const srcPts = cv.matFromArray(4,1,cv.CV_32FC2,[tl.x,tl.y, tr.x,tr.y, br.x,br.y, bl.x,bl.y]);
        const dstPts = cv.matFromArray(4,1,cv.CV_32FC2,[0,0, dSize.width-1,0, dSize.width-1,dSize.height-1, 0,dSize.height-1]);
        const M = cv.getPerspectiveTransform(srcPts, dstPts);
        cv.warpPerspective(src, dst, M, dSize, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());
        srcPts.delete(); dstPts.delete(); M.delete(); best.delete();

        const out = document.createElement('canvas');
        cv.imshow(out, dst);
        const ctx = out.getContext('2d');
        ctx.filter = 'contrast(1.18) brightness(1.06) grayscale(1)';
        const tmp = document.createElement('canvas'); tmp.width = out.width; tmp.height = out.height;
        tmp.getContext('2d').drawImage(out,0,0); ctx.drawImage(tmp,0,0);
        outCanvas = out;
      } else {
        outCanvas = canvasEl;
      }
      return outCanvas.toDataURL("image/jpeg", .95);
    } finally {
      src.delete(); dst.delete(); gray.delete(); blurred.delete();
      canny.delete(); contours.delete(); hierarchy.delete(); if (best) best.delete();
    }
  }

  // ===== Productos (solo lectura en UI) =====
  function upsertProducto(nombre, cantidad=1, price=null) {
    nombre = String(nombre||'').trim();
    if (!nombre) return;
    const pointsUnit = assignPointsForProduct(nombre, typeof price==='number' ? price : null);

    const idx = productos.findIndex(p => p.name.toLowerCase() === nombre.toLowerCase());
    if (idx >= 0) {
      productos[idx].qty += cantidad;
      if (typeof price === 'number') {
        productos[idx].price = +((productos[idx].price||0) + price).toFixed(2);
      }
    } else {
      productos.push({ name: nombre, qty: cantidad, price: price ?? null, pointsUnit });
    }
    renderProductos();
  }

  function renderProductos() {
    if (!listaProd) return;
    listaProd.innerHTML = '';
    productos.forEach(p => {
      const chip = document.createElement('div');
      chip.className = 'chip readonly';
      chip.innerHTML = `
        <span>${p.name}</span>
        <span class="qty"><strong>${p.qty}</strong></span>
        <span class="pts">${p.pointsUnit} pts/u</span>
      `;
      listaProd.appendChild(chip);
    });
    updatePuntosResumen();
  }

  function updatePuntosResumen() {
    if (!tablaPuntosBody) return;
    tablaPuntosBody.innerHTML = '';
    let total = 0;
    productos.forEach(p=>{
      const sub = p.pointsUnit * p.qty;
      total += sub;
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${p.name}</td><td>${p.qty}</td><td>${p.pointsUnit}</td><td>${sub}</td>`;
      tablaPuntosBody.appendChild(tr);
    });
    if (totalPuntosEl) totalPuntosEl.textContent = String(total);
  }

  function getPuntosDetalle() {
    let total = 0;
    const detalle = productos.map(p=>{
      const sub = p.pointsUnit * p.qty;
      total += sub;
      return { producto: p.name, cantidad: p.qty, puntos_unitarios: p.pointsUnit, puntos_subtotal: sub };
    });
    return { total, detalle };
  }

  // ===== Guardar en RTDB con índice (fecha+folio) anti-duplicado =====
  function addMonths(date, months){ const d=new Date(date.getTime()); d.setMonth(d.getMonth()+months); return d; }
  function startEndOfToday() {
    const s = new Date(); s.setHours(0,0,0,0);
    const e = new Date(); e.setHours(23,59,59,999);
    return { start: s.getTime(), end: e.getTime() };
  }
  function ymdFromISO(iso){ return String(iso||'').replace(/-/g,''); }

  async function registrarTicketRTDB() {
    const user = auth.currentUser;
    if (!user) {
      msgTicket.className='validacion-msg err';
      msgTicket.textContent = "Debes iniciar sesión para registrar.";
      return;
    }

    const folio   = (iNum.value || '').trim().toUpperCase();
    const fechaStr= iFecha.value;
    const totalNum= parseFloat(iTotal.value || "0") || 0;

    if (!folio || !/^\d{5}$/.test(folio) || !fechaStr || !totalNum) {
      msgTicket.className='validacion-msg err';
      msgTicket.textContent = "Faltan datos válidos: folio (5 dígitos), fecha y total.";
      return;
    }

    // Calcula puntos
    let { total: puntosTotal, detalle } = getPuntosDetalle();

    // Fallback: si por OCR no quedaron productos válidos, asigna por tramo de total
    if (puntosTotal <= 0) {
      const t = Number(totalNum);
      let pts;
      if (t >= 600) pts = 14;
      else if (t >= 400) pts = 12;
      else if (t >= 250) pts = 10;
      else if (t >= 120) pts = 7;
      else pts = 4;

      productos = [{ name: "Consumo Applebee's", qty: 1, price: t, pointsUnit: pts }];
      detalle   = [{ producto: "Consumo Applebee's", cantidad: 1, puntos_unitarios: pts, puntos_subtotal: pts }];
      puntosTotal = pts;

      // refleja en UI
      renderProductos();
    }

    // Límite por día
    if (DAY_LIMIT > 0) {
      try {
        const { start, end } = startEndOfToday();
        const qs = db.ref(`users/${user.uid}/tickets`).orderByChild('createdAt').startAt(start).endAt(end);
        const snap = await qs.once('value');
        const countToday = snap.exists() ? Object.keys(snap.val()).length : 0;
        if (countToday >= DAY_LIMIT) {
          msgTicket.className='validacion-msg err';
          msgTicket.textContent = `⚠️ Ya registraste ${DAY_LIMIT} tickets hoy.`;
          return;
        }
      } catch (err) { console.warn('No pude verificar límite diario:', err); }
    }

    const fecha = new Date(`${fechaStr}T00:00:00`);
    const vencePuntos = addMonths(fecha, VENCE_DIAS/30);

    const userRef    = db.ref(`users/${user.uid}`);
    const ticketRef  = userRef.child(`tickets/${folio}`);
    const pointsRef  = userRef.child('points');

    // Índice global fecha+folio para **evitar duplicados** (mismo ticket, misma fecha)
    const ymd = ymdFromISO(fechaStr);
    const indexRef = db.ref(`ticketsIndex/${ymd}/${folio}`);

    try {
      // 1) Crea índice si NO existe (reglas .write: !data.exists())
      const idxTx = await indexRef.transaction(curr => {
        if (curr) return; // ya existe → aborta
        return { uid: user.uid, createdAt: Date.now() };
      });
      if (!idxTx.committed) {
        msgTicket.className='validacion-msg err';
        msgTicket.textContent = "❌ Este folio ya fue registrado para esa fecha.";
        return;
      }

      // 2) Crea ticket del usuario (anti-sobrescritura)
      const res = await ticketRef.transaction(current => {
        if (current) return;
        return {
          folio,
          fecha: fechaStr,
          total: totalNum,
          productos: productos.map(p=>({ nombre: p.name, cantidad: p.qty, precioLinea: p.price ?? null, puntos_unitarios: p.pointsUnit })),
          puntos: { total: puntosTotal, detalle },
          // Campo plano redundante para tablas/paneles
          puntosTotal: puntosTotal,
          vencePuntos: vencePuntos.getTime(),
          createdAt: Date.now()
        };
      });
      if (!res.committed) {
        msgTicket.className='validacion-msg err';
        msgTicket.textContent = "❌ Este ticket ya está en tu cuenta.";
        return;
      }

      // 3) Suma puntos a perfil
      await pointsRef.transaction(curr => (Number(curr)||0) + puntosTotal);

      msgTicket.className='validacion-msg ok';
      msgTicket.textContent = `✅ Ticket registrado. Puntos: ${puntosTotal}`;
      setTimeout(()=>{ window.location.href = 'panel.html'; }, 1200);
    } catch (e) {
      console.error(e);
      msgTicket.className='validacion-msg err';
      if (String(e).includes('Permission denied')) {
        msgTicket.textContent = "Permiso denegado por Realtime Database. Revisa las reglas.";
      } else {
        msgTicket.textContent = "No se pudo registrar el ticket. Revisa tu conexión e inténtalo de nuevo.";
      }
    }
  }

  // ===== Sesión =====
  auth.onAuthStateChanged(user => {
    isLogged = !!user;
    if (!user) {
      if (greetEl) greetEl.textContent = "Inicia sesión para registrar tickets";
      if (btnRegistrar) btnRegistrar.disabled = true;
    } else {
      if (greetEl) greetEl.textContent = `Registro de ticket — ${user.email}`;
      if (btnRegistrar) btnRegistrar.disabled = false;
    }
  });

  // ===== Eventos =====
  btnPickFile?.addEventListener('click', ()=> fileInput?.click());
  btnCam?.addEventListener('click', openCamera);
  btnClose?.addEventListener('click', ()=>{ 
    if (liveStream) liveStream.getTracks().forEach(t=>t.stop());
    modal.style.display='none'; 
    modal.setAttribute('aria-hidden','true');
  });
  btnShot?.addEventListener('click', captureFrame);

  fileInput?.addEventListener('change', (e)=>{
    const f = e.target.files && e.target.files[0];
    if (f) { setPreview(f); setStatus("Imagen cargada. Procesa con OCR.", "ok"); }
  });

  // Integra productos detectados por ocr.js
  document.addEventListener('ocr:productos', (ev) => {
    const det = ev.detail || []; // [{name, qty, price}]
    productos = [];
    if (Array.isArray(det)) det.forEach(p => upsertProducto(p.name, p.qty || 1, typeof p.price==='number' ? p.price : null));
  });

  btnRegistrar?.addEventListener('click', registrarTicketRTDB);

  // ===== Init =====
  disableAllEdits(); // bloquea inputs
  if (tablaPuntosBody) tablaPuntosBody.innerHTML = '';
  if ((!window.isSecureContext && location.hostname !== 'localhost') ||
      (location.protocol !== 'https:' && location.hostname !== 'localhost')) {
    setStatus("Para usar la cámara en móviles, abre el sitio con HTTPS.", "err");
  }
})();
