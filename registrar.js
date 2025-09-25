// registrar.js — RTDB + Cámara + OCR + Edición manual (puntos auto 1–15) + antifraude (folio+fecha)
(() => {
  const $ = id => document.getElementById(id);

  // ===== Firebase =====
  const auth = firebase.auth();
  const db   = firebase.database();
  console.log("Proyecto (registrar):", firebase.app().options.projectId);

  // ===== UI =====
  const fileInput    = $('ticketFile');
  const dropzone     = $('dropzone');
  const btnPickFile  = $('btnSeleccionarArchivo');

  const btnCam       = $('btnAbrirCamara');
  const modal        = $('cameraModal');
  const btnClose     = $('btnCerrarCamara');
  const video        = $('cameraVideo');
  const btnShot      = $('btnCapturar');

  const btnOCR       = $('btnProcesarTicket');   // el handler real vive en ocr.js
  const btnEditar    = $('btnEditarManual');     // (si no existe en tu HTML, no pasa nada)
  const ocrStatus    = $('ocrStatus');

  const iNum         = $('inputTicketNumero');
  const iFecha       = $('inputTicketFecha');
  const iTotal       = $('inputTicketTotal');

  const listaProd    = $('listaProductos');
  const nuevoProd    = $('nuevoProducto');
  const nuevaCant    = $('nuevaCantidad');
  const btnAdd       = $('btnAgregarProducto');

  const btnRegistrar = $('btnRegistrarTicket');
  const msgTicket    = $('ticketValidacion');
  const greetEl      = $('userGreeting');

  const tablaPuntosBody = ($('tablaPuntos')||{}).querySelector?.('tbody');
  const totalPuntosEl   = $('totalPuntos');

  // ===== Políticas =====
  const VENCE_DIAS = 180;  // vence en 180 días
  const DAY_LIMIT  = 2;    // máx. tickets por día

  // ===== Estado =====
  let isLogged = false;
  let liveStream = null;
  let currentPreviewURL = null;
  // productos = [{ name, qty, price, pointsUnit }]
  let productos = [];

  // ===========================================
  //  Heurística de categorías y puntos (1–15)
  // ===========================================
  const KW = {
    entradas: ["entrada","sampler","appetizer","nachos","totopos","guacamole","spinach & artichoke","artichoke dip","mozzarella sticks","aros de cebolla","onion rings","elote","elotes","chicharron","chicharrón","chips","dip","wonton","queso fundido"],
    alitas: ["alitas","wings","boneless","buffalo wings","bone in","bone-out","bone out","boneless buffalo"],
    ensaladas: ["ensalada","salad","garden salad","caesar","oriental chicken salad","buffalo salad","santa fe salad"],
    sopas: ["sopa","soup","chicken tortilla","sopa de tortilla","caldo","crema"],
    burgers: ["burger","hamburguesa","cheese burger","cheeseburger","bacon","messy burger","cowboy burger","smash burger","double smash","bacon & cheddar","cheesy nacho","buffalo chicken burger","louisiana chicken burger","sizzling burger"],
    pastas: ["pasta","fettuccine","alfredo","pomodoro","three cheese","parmesana","parmigiana","chicken & broccoli","chicken parm","camarones blackened","shrimp pasta","lasagna","lasaña"],
    costillas: ["costillas","ribs","riblets","double glazed ribs","old texas sampler","ribs platter","carnitas ribs"],
    pollo: ["pollo","chicken","tenders","chicken tender","bourbon street chicken","fiesta lime chicken","crispy orange chicken","stuffed chicken"],
    pescado: ["pescado","salmon","salmón","grilled salmon","tilapia","camarones","shrimp","fish & chips","fish and chips"],
    cortes: ["steak","arrachera","house steak","bourbon street steak","sirloin","rib eye","ribeye","new york","ny steak","shrimp & parmesan steak"],
    texmex: ["fajitas","faji-tsss","fajita","tacos","quesadillas","enchiladas","burrito","burritos","skillet","adobado","al pastor","asada","barbacoa","chile"],
    sides: ["papas","fries","french fries","pure","puré","puré de papa","mashed potato","arroz","frijoles","coleslaw","ensalada chica","side","guarnicion","guarnición","elote","maiz","maíz"],
    postres: ["postre","dessert","brownie","fudge","sundae","helado","nieve","pastel","cheesecake","apple cheesecake","apple chimicheesecake","blondie","triple chocolate meltdown","churro","pay","pie"],
    bebidas: ["refresco","soda","coca","pepsi","sprite","fanta","manzanita","bebida","limonada","limon","limón","lemonade","agua","jugo","naranja","arándano","cranberry","smoothie","malteada","shake","iced tea","te helado","té helado"],
    calientes: ["cafe","café","capuchino","capuccino","latte","espresso","te","té","chocolate caliente"],
    alcohol: ["cerveza","beer","vino","tinto","blanco","rosado","rosé","mezcal","tequila","whisky","ron","vodka","gin"],
    cocteles: ["margarita","perfect margarita","mojito","paloma","cantarito","martini","piña colada","pina colada","azulito","bucket","cuba","daiquiri","spritz","aperol","gin tonic","tonic"]
  };

  const POINT_RANGES = {
    burgers:[7,15], costillas:[7,15], cortes:[7,15],
    pescado:[6,14], pollo:[6,13], pastas:[6,13], texmex:[6,14],
    alitas:[4,10], entradas:[3,9], ensaladas:[3,9], sopas:[3,8], sides:[2,6],
    postres:[4,10], cocteles:[4,10], alcohol:[3,9], bebidas:[2,7], calientes:[2,6],
    other:[1,5]
  };

  function hashInt(str){ let h=2166136261>>>0; for(let i=0;i<str.length;i++){h^=str.charCodeAt(i); h=Math.imul(h,16777619);} return h>>>0; }
  function seededRandInt(seed,min,max){ const x=hashInt(String(seed)); const r=(x%10000)/10000; return Math.floor(min + r*(max-min+1)); }

  function detectCategory(name){
    const n = String(name||'').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
    if (KW.burgers.some(k=>n.includes(k))) return "burgers";
    if (KW.costillas.some(k=>n.includes(k))) return "costillas";
    if (KW.cortes.some(k=>n.includes(k))) return "cortes";
    if (KW.pescado.some(k=>n.includes(k)))  return "pescado";
    if (KW.pollo.some(k=>n.includes(k)))    return "pollo";
    if (KW.pastas.some(k=>n.includes(k)))   return "pastas";
    if (KW.texmex.some(k=>n.includes(k)))   return "texmex";
    if (KW.alitas.some(k=>n.includes(k)))   return "alitas";
    if (KW.entradas.some(k=>n.includes(k))) return "entradas";
    if (KW.ensaladas.some(k=>n.includes(k)))return "ensaladas";
    if (KW.sopas.some(k=>n.includes(k)))    return "sopas";
    if (KW.postres.some(k=>n.includes(k)))  return "postres";
    if (KW.cocteles.some(k=>n.includes(k))) return "cocteles";
    if (KW.alcohol.some(k=>n.includes(k)))  return "alcohol";
    if (KW.bebidas.some(k=>n.includes(k)))  return "bebidas";
    if (KW.calientes.some(k=>n.includes(k)))return "calientes";
    if (KW.sides.some(k=>n.includes(k)))    return "sides";
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
    return seededRandInt(seed, minP, maxP);
  }

  // ===== Helpers de UI =====
  function setStatus(msg, type=''){ if(!ocrStatus) return; ocrStatus.className='validacion-msg'; if(type) ocrStatus.classList.add(type); ocrStatus.textContent=msg||''; }
  function enableForm(on){ [iNum,iFecha,iTotal,nuevoProd,nuevaCant,btnAdd].forEach(x=>x && (x.disabled=!on)); if(btnRegistrar) btnRegistrar.disabled = !on || !isLogged; }
  function setPreview(file){
    if (currentPreviewURL) URL.revokeObjectURL(currentPreviewURL);
    const url = URL.createObjectURL(file); currentPreviewURL = url;
    dropzone?.querySelectorAll('img.preview').forEach(n=>n.remove());
    if (dropzone){ const img=document.createElement('img'); img.className='preview'; img.alt='Vista previa ticket'; img.src=url; dropzone.appendChild(img); }
  }
  function dataURLtoBlob(dataURL){ const [meta,b64]=dataURL.split(','); const mime=meta.split(':')[1].split(';')[0]; const bin=atob(b64); const ab=new ArrayBuffer(bin.length); const ia=new Uint8Array(ab); for(let i=0;i<bin.length;i++) ia[i]=bin.charCodeAt(i); return new Blob([ab],{type:mime}); }
  function setFileInputFromBlob(blob,name='ticket.jpg'){ const file=new File([blob],name,{type:blob.type||'image/jpeg',lastModified:Date.now()}); const dt=new DataTransfer(); dt.items.add(file); if(fileInput) fileInput.files=dt.files; setPreview(file); }

  // ======================
  // Cámara (con OpenCV)
  // ======================
  async function openCamera(){
    try{
      if(!navigator.mediaDevices?.getUserMedia){ setStatus("Tu navegador no soporta cámara. Usa Adjuntar foto.","err"); return; }
      video.muted=true; video.setAttribute('playsinline','true');
      const tries=[
        { video:{ facingMode:{exact:"environment"}, width:{ideal:1920}, height:{ideal:1080} }, audio:false },
        { video:{ facingMode:{ideal:"environment"},  width:{ideal:1920}, height:{ideal:1080} }, audio:false },
        { video:true, audio:false }
      ];
      let stream=null, lastErr=null;
      for(const c of tries){ try{ stream=await navigator.mediaDevices.getUserMedia(c); break; } catch(e){ lastErr=e; } }
      if(!stream) throw lastErr || new Error("No se pudo abrir la cámara");
      liveStream=stream; video.srcObject=stream; modal.style.display='flex'; modal.setAttribute('aria-hidden','false'); await video.play(); setStatus('');
    }catch(e){
      console.error("getUserMedia:", e);
      let msg="No se pudo acceder a la cámara. Revisa permisos del navegador.";
      if((!window.isSecureContext && location.hostname!=='localhost') || (location.protocol!=='https:' && location.hostname!=='localhost')){ msg+=" (En móviles debes abrir el sitio con HTTPS)."; }
      setStatus(msg,"err"); fileInput?.click();
    }
  }
  function stopCamera(){ if(liveStream){ liveStream.getTracks().forEach(t=>t.stop()); liveStream=null; } modal.style.display='none'; modal.setAttribute('aria-hidden','true'); }
  async function captureFrame(){
    const w=video.videoWidth, h=video.videoHeight;
    if(!w||!h){ setStatus("Cámara aún no lista. Intenta de nuevo.","err"); return; }
    const c=document.createElement('canvas'); c.width=w; c.height=h; c.getContext('2d').drawImage(video,0,0,w,h);
    stopCamera();
    let dataURL;
    if(window.cv && window.cv.Mat){ try{ dataURL=processWithOpenCV(c); } catch(e){ console.warn("OpenCV falló:",e); dataURL=c.toDataURL("image/jpeg",.95); } }
    else { dataURL=c.toDataURL("image/jpeg",.95); }
    const blob=dataURLtoBlob(dataURL); setFileInputFromBlob(blob,`ticket_${Date.now()}.jpg`);
    enableForm(true); setStatus("Foto capturada. Procesa con OCR…","ok"); btnOCR?.click();
  }
  function processWithOpenCV(canvasEl){
    const cv=window.cv; let src=cv.imread(canvasEl); let dst=new cv.Mat(); let gray=new cv.Mat(); let blurred=new cv.Mat(); let canny=new cv.Mat(); let contours=new cv.MatVector(); let hierarchy=new cv.Mat(); let best=null;
    try{
      cv.cvtColor(src,gray,cv.COLOR_RGBA2GRAY,0);
      cv.GaussianBlur(gray,blurred,new cv.Size(5,5),0,0,cv.BORDER_DEFAULT);
      cv.Canny(blurred,canny,75,200,3,false);
      cv.findContours(canny,contours,hierarchy,cv.RETR_EXTERNAL,cv.CHAIN_APPROX_SIMPLE);
      let maxArea=0;
      for(let i=0;i<contours.size();i++){
        const cont=contours.get(i); const area=cv.contourArea(cont); if(area<15000) continue;
        const peri=cv.arcLength(cont,true); const approx=new cv.Mat(); cv.approxPolyDP(cont,approx,.02*peri,true);
        if(approx.rows===4 && area>maxArea){ if(best) best.delete(); best=approx; maxArea=area; } else { approx.delete(); }
      }
      let outCanvas=document.createElement('canvas');
      if(best){
        const pts=[]; for(let i=0;i<best.rows;i++) pts.push({x:best.data32S[i*2], y:best.data32S[i*2+1]});
        const orderQuad=(ps)=>{ const rect=new Array(4); const s=ps.map(p=>p.x+p.y); const d=ps.map(p=>p.y-p.x); rect[0]=ps[s.indexOf(Math.min(...s))]; rect[2]=ps[s.indexOf(Math.max(...s))]; rect[1]=ps[d.indexOf(Math.min(...d))]; rect[3]=ps[d.indexOf(Math.max(...d))]; return rect; };
        const [tl,tr,br,bl]=orderQuad(pts);
        const wA=Math.hypot(br.x-bl.x,br.y-bl.y), wB=Math.hypot(tr.x-tl.x,tr.y-tl.y);
        const hA=Math.hypot(tr.x-br.x,tr.y-br.y), hB=Math.hypot(tl.x-bl.x,tl.y-bl.y);
        const W=Math.max(wA,wB), H=Math.max(hA,hB);
        const dSize=new cv.Size(Math.max(300,Math.floor(W)), Math.max(400,Math.floor(H)));
        const srcPts=cv.matFromArray(4,1,cv.CV_32FC2,[tl.x,tl.y,tr.x,tr.y,br.x,br.y,bl.x,bl.y]);
        const dstPts=cv.matFromArray(4,1,cv.CV_32FC2,[0,0,dSize.width-1,0,dSize.width-1,dSize.height-1,0,dSize.height-1]);
        const M=cv.getPerspectiveTransform(srcPts,dstPts);
        cv.warpPerspective(src,dst,M,dSize,cv.INTER_LINEAR,cv.BORDER_CONSTANT,new cv.Scalar());
        srcPts.delete(); dstPts.delete(); M.delete(); best.delete();
        const out=document.createElement('canvas'); cv.imshow(out,dst); const ctx=out.getContext('2d'); ctx.filter='contrast(1.18) brightness(1.06) grayscale(1)'; const tmp=document.createElement('canvas'); tmp.width=out.width; tmp.height=out.height; tmp.getContext('2d').drawImage(out,0,0); ctx.drawImage(tmp,0,0); outCanvas=out;
      } else { outCanvas=canvasEl; }
      return outCanvas.toDataURL("image/jpeg",.95);
    } finally { src.delete(); dst.delete(); gray.delete(); blurred.delete(); canny.delete(); contours.delete(); hierarchy.delete(); if(best) best.delete(); }
  }

  // ======================
  // Productos (UI + puntos)
  // ======================
  function upsertProducto(nombre, cantidad=1, price=null){
    nombre = String(nombre||'').trim();
    if(!nombre) return;
    const pts = assignPointsForProduct(nombre, typeof price==='number' ? price : null);
    const idx = productos.findIndex(p => p.name.toLowerCase() === nombre.toLowerCase());
    if (idx >= 0) {
      productos[idx].qty += cantidad;
      if (typeof price === 'number') {
        const prevPrice = Number(productos[idx].price || 0);
        productos[idx].price = +(prevPrice + price).toFixed(2);
      }
    } else {
      productos.push({ name:nombre, qty:cantidad, price: price ?? null, pointsUnit: pts });
    }
    renderProductos();
  }

  function renderProductos(){
    if(!listaProd) return;
    listaProd.innerHTML='';
    productos.forEach(p=>{
      const chip=document.createElement('div');
      chip.className='chip';
      chip.innerHTML=`
        <span>${p.name}</span>
        <span class="qty">
          <button type="button" data-act="-" data-name="${p.name}">−</button>
          <strong>${p.qty}</strong>
          <button type="button" data-act="+" data-name="${p.name}">+</button>
        </span>
        <span class="pts">${p.pointsUnit} pts/u</span>
        <button type="button" data-act="x" data-name="${p.name}">✕</button>
      `;
      listaProd.appendChild(chip);
    });
    updatePuntosResumen();
  }

  function updatePuntosResumen(){
    if(!tablaPuntosBody) return;
    tablaPuntosBody.innerHTML='';
    let total=0;
    productos.forEach(p=>{
      const sub=p.pointsUnit*p.qty; total+=sub;
      const tr=document.createElement('tr');
      tr.innerHTML=`<td>${p.name}</td><td>${p.qty}</td><td>${p.pointsUnit}</td><td>${sub}</td>`;
      tablaPuntosBody.appendChild(tr);
    });
    if(totalPuntosEl) totalPuntosEl.textContent=String(total);
  }

  function getPuntosDetalle(){
    let total=0;
    const detalle=productos.map(p=>{
      const sub=p.pointsUnit*p.qty; total+=sub;
      return { producto:p.name, cantidad:p.qty, puntos_unitarios:p.pointsUnit, puntos_subtotal:sub };
    });
    return { total, detalle };
  }

  // ======================
  // Guardar en RTDB (con índice global por fecha+folio)
  // ======================
  function addMonths(date, months){ const d=new Date(date.getTime()); d.setMonth(d.getMonth()+months); return d; }
  function startEndOfToday(){ const s=new Date(); s.setHours(0,0,0,0); const e=new Date(); e.setHours(23,59,59,999); return {start:s.getTime(), end:e.getTime()}; }
  const yyyymmdd = (iso) => String(iso||'').replace(/-/g,'');

  async function registrarTicketRTDB(){
    const user = auth.currentUser;
    if(!user){ msgTicket.className='validacion-msg err'; msgTicket.textContent="Debes iniciar sesión para registrar."; return; }

    const folio   = (iNum.value || '').trim().toUpperCase();
    const fechaStr= iFecha.value;              // YYYY-MM-DD
    const totalNum= parseFloat(iTotal.value || "0") || 0;

    if(!folio || !fechaStr || !totalNum){
      msgTicket.className='validacion-msg err';
      msgTicket.textContent="Faltan datos obligatorios: número, fecha y total.";
      return;
    }

    // Puntos desde productos detectados
    const { total: puntosTotal, detalle } = getPuntosDetalle();
    if(puntosTotal <= 0){
      msgTicket.className='validacion-msg err';
      msgTicket.textContent="No se detectaron consumos con puntos. Revisa los productos o edita manualmente.";
      return;
    }

    // Límite por día por usuario
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
      } catch (err) {
        console.warn('No pude verificar límite diario, continúo sin bloquear:', err);
      }
    }

    // === Antifraude: índice global por (fecha YYYYMMDD + folio) ===
    const ymd = yyyymmdd(fechaStr);
    const compositeKey = `${ymd}_${folio}`;
    const indexRef = db.ref(`ticketsIndex/${ymd}/${folio}`); // evita duplicados entre TODOS los usuarios
    let indexLocked = false;

    try {
      // Aparta índice (transacción): si ya existe, aborta
      const lockRes = await indexRef.transaction(current => {
        if (current) return; // YA existe → abortar
        return { uid: user.uid, createdAt: Date.now() };
      });

      if (!lockRes.committed) {
        msgTicket.className='validacion-msg err';
        msgTicket.textContent = `❌ Ticket duplicado: ${folio} del ${fechaStr} ya fue registrado.`;
        return;
      }
      indexLocked = true;

      // Guardar ticket en carpeta del usuario con llave compuesta
      const fecha = new Date(`${fechaStr}T00:00:00`);
      const vencePuntos = addMonths(fecha, VENCE_DIAS/30);
      const userRef   = db.ref(`users/${user.uid}`);
      const ticketRef = userRef.child(`tickets/${compositeKey}`);
      const pointsRef = userRef.child('points');

      const res = await ticketRef.transaction(current => {
        if (current) return; // por si el usuario mismo intenta duplicar
        return {
          key: compositeKey,
          folio,
          fecha: fechaStr,        // 'YYYY-MM-DD'
          total: totalNum,
          productos: productos.map(p=>({
            nombre: p.name,
            cantidad: p.qty,
            precioLinea: p.price ?? null,
            puntos_unitarios: p.pointsUnit
          })),
          puntos: { total: puntosTotal, detalle },
          vencePuntos: vencePuntos.getTime(),
          createdAt: Date.now()
        };
      });

      if (!res.committed) {
        msgTicket.className='validacion-msg err';
        msgTicket.textContent = "❌ Este ticket ya estaba en tu historial.";
        return;
      }

      // Sumar puntos al perfil (atómico)
      await pointsRef.transaction(curr => (Number(curr)||0) + puntosTotal);

      msgTicket.className='validacion-msg ok';
      msgTicket.textContent = `✅ Ticket registrado. Puntos: ${puntosTotal}`;
      setTimeout(()=>{ window.location.href = 'panel.html'; }, 1200);

    } catch (e) {
      console.error(e);
      // si algo falló y ya habíamos bloqueado el índice, revertimos
      if (indexLocked) { try { await indexRef.remove(); } catch(_){} }
      msgTicket.className='validacion-msg err';
      if (String(e).includes('Permission denied')) {
        msgTicket.textContent = "Permiso denegado por Realtime Database. Revisa reglas (ticketsIndex y users/$uid/tickets).";
      } else {
        msgTicket.textContent = "No se pudo registrar el ticket. Revisa tu conexión e inténtalo de nuevo.";
      }
    }
  }

  // ======================
  // Sesión
  // ======================
  auth.onAuthStateChanged(user => {
    isLogged = !!user;
    if (!user) {
      if (greetEl) greetEl.textContent = "Inicia sesión para registrar tickets";
      if (btnRegistrar) btnRegistrar.disabled = true;
    } else {
      if (greetEl) greetEl.textContent = `Registro de ticket — ${user.email}`;
      if (btnRegistrar && !iNum.disabled) btnRegistrar.disabled = false;
    }
  });

  // ======================
  // Eventos
  // ======================
  btnPickFile?.addEventListener('click', ()=> fileInput?.click());
  btnCam?.addEventListener('click', openCamera);
  btnClose?.addEventListener('click', stopCamera);
  btnShot?.addEventListener('click', captureFrame);

  fileInput?.addEventListener('change', (e)=>{
    const f = e.target.files && e.target.files[0];
    if (f) { setPreview(f); enableForm(true); setStatus("Imagen cargada. Puedes editar o usar OCR.", "ok"); }
  });

  btnOCR?.addEventListener('click', ()=>{
    if (!fileInput?.files?.length) {
      setStatus("Adjunta imagen del ticket primero (o usa Edición manual).", "err");
      return;
    }
    // el procesamiento real lo hace ocr.js -> leerTicket()
  });

  btnEditar?.addEventListener('click', ()=>{
    enableForm(true);
    setStatus("Edición manual habilitada. Puedes escribir folio, fecha, total, productos y registrar.", "ok");
  });

  listaProd?.addEventListener('click', (e)=>{
    const btn = e.target.closest('button'); if (!btn) return;
    const act = btn.dataset.act, name = btn.dataset.name;
    const idx = productos.findIndex(p=>p.name===name); if (idx<0) return;
    if (act==='+') productos[idx].qty++;
    if (act==='-' && productos[idx].qty>1) productos[idx].qty--;
    if (act==='x') productos.splice(idx,1);
    renderProductos();
  });

  btnAdd?.addEventListener('click', ()=>{
    const n = (nuevoProd.value || '').trim();
    const c = Math.max(1, parseInt(nuevaCant.value||"1", 10));
    if (n) upsertProducto(n, c, null);
    nuevoProd.value=''; nuevaCant.value='';
  });

  // Productos detectados por OCR.js
  document.addEventListener('ocr:productos', (ev) => {
    const det = ev.detail || []; // [{name, qty, price}]
    productos = [];
    if (Array.isArray(det)) {
      det.forEach(p => upsertProducto(p.name, p.qty || 1, typeof p.price==='number' ? p.price : null));
    }
  });

  btnRegistrar?.addEventListener('click', registrarTicketRTDB);

  // ===== Init =====
  enableForm(false);
  updatePuntosResumen();

  if ((!window.isSecureContext && location.hostname !== 'localhost') ||
      (location.protocol !== 'https:' && location.hostname !== 'localhost')) {
    setStatus("Para usar la cámara en móviles, abre el sitio con HTTPS.", "err");
  }
})();
