/* ===========================
   ocr.js — OCR tolerante para tickets Applebee’s
   =========================== */

// ===== Depuración opcional =====
const DBG = { lines:[], notes:[] };
function note(s){ try{ DBG.notes.push(String(s)); }catch{} }
function dump(){
  const el = document.getElementById('ocrDebug');
  if(!el) return;
  el.textContent =
    '[NOTAS]\n' + DBG.notes.join('\n') +
    '\n\n[LINEAS]\n' + DBG.lines.map((s,i)=>`${String(i).padStart(2,'0')}: ${s}`).join('\n');
}

// ===== Utilidades base =====
function fixLine(s){
  if(!s) return s;
  return s
    .replace(/(?<=\d)O(?=\d)/g,'0')
    .replace(/(?<=\d)S(?=\d)/g,'5')
    .replace(/(?<=\d)l(?=\d)/g,'1')
    .replace(/(?<=\d)I(?=\d)/g,'1');
}

function splitLines(text){
  const arr = String(text||'')
    .replace(/\r/g,'\n')
    .split('\n')
    .map(s=>fixLine(s.replace(/\s{2,}/g,' ').trim()))
    .filter(Boolean);
  DBG.lines = arr.slice();
  return arr;
}

function normalizeNum(raw){
  if(!raw) return null;
  let s = String(raw).replace(/[^\d.,-]/g,'').trim();
  if(!s) return null;
  if(s.includes(',') && s.includes('.')){
    if (s.lastIndexOf('.') > s.lastIndexOf(',')) s = s.replace(/,/g,'');
    else s = s.replace(/\./g,'').replace(',', '.');
  } else if (s.includes(',')){
    const m = s.match(/,\d{2}$/);
    s = m ? s.replace(',', '.') : s.replace(/,/g,'');
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? +(n.toFixed(2)) : null;
}

function endsWithPrice(line){
  const m = line.match(/(?:\$?\s*)([0-9]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))\s*$/);
  if(!m) return null;
  const price = normalizeNum(m[1]);
  if(price == null) return null;
  const namePart = line.replace(m[0], '').trim();
  return { namePart, price };
}

// ===== Diccionario ES+EN de comida/bebidas/postres =====
const FOOD_HINTS = [
  // español
  "hamburguesa","burger","cheeseburger","tocino","bacon",
  "alitas","boneless","costillas","ribs","arrachera","sirloin","new york","steak",
  "pasta","alfredo","fettuccine","lasagna","lasaña","parm",
  "pollo","chicken","tenders",
  "quesadilla","quesadillas","tacos","fajita","fajitas","enchilada","burrito","skillet","nachos",
  "ensalada","salad","cesar","césar",
  "sopa","soup",
  "mariscos","shrimp","camarones","salmon","salmón","tilapia","fish","fish & chips","fish and chips",
  "postre","dessert","brownie","cheesecake","blondie","helado","ice cream","pastel","pie",
  // bebidas
  "margarita","mojito","piña colada","pina colada","martini","aperol","spritz","coctel","cocktail",
  "cerveza","beer","vino","wine","tequila","mezcal","whisky","ron","vodka","gin","bucket",
  "refresco","soda","coca","pepsi","sprite","fanta","limonada","lemonade","agua","jugo","iced tea","smoothie","shake","malteada",
  // kids / sides
  "kids","infantil","guacamole","dip","onion rings","aros","papas","fries","potato","mashed","pure","puré",
  // brunch
  "huevo","eggs","breakfast","desayuno","pancake","waffle","french toast"
];

function looksTextualName(s){
  if(!s) return false;
  const low = s.toLowerCase();

  // cosas que NO son productos
  if (/\b(sub-?total|subtotal|iva|impuesto|propina|servicio|service|descuento|cupon|cambio|cancel|anulado|cliente|clientes|mesa|mesero|tarjeta|efectivo|visa|master|amex|pago|payment|autoriz)\b/.test(low))
    return false;
  if (/\b(cp|c\.p\.|col|av|avenida|calle|domicilio|chihuahua)\b/i.test(low))
    return false;

  // si trae palabra de comida/bebida → sí
  if (FOOD_HINTS.some(w => low.includes(w)))
    return true;

  // si es una frase con letras de 3+ caracteres → aceptamos
  if (/[a-záéíóúñ]/i.test(s) && s.length >= 3)
    return true;

  return false;
}

// ===== Fecha / folio =====
function toISODateFromText(text){
  const m = String(text||'').match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](20\d{2})/);
  if(!m) return '';
  let d = +m[1], mo = +m[2], y = +m[3];
  if (d<=12 && mo>12) [d,mo] = [mo,d];
  return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

function findDateIdx(lines){ return lines.findIndex(s=>/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](20\d{2})/.test(s)); }
function findTimeIdx(lines){ return lines.findIndex(s=>/(\d{1,2}):(\d{2})\s*(am|pm)?/i.test(s)); }
function findMeseroIdx(lines){ const i = lines.findIndex(s=>/\bmesero\b|\bmesa\b|\bclientes?\b/i.test(s)); return i>=0?i:0; }

function extractFolio5(lines){
  const iD = findDateIdx(lines);
  const iT = findTimeIdx(lines);
  const iM = findMeseroIdx(lines);
  const anchor = (iD>=0 || iT>=0) ? Math.max(iD,iT) : -1;
  const from = Math.max(iM, anchor>=0?anchor:iM);
  const to   = Math.min(lines.length-1, from+5);

  const pick5 = (s)=>{
    if (/cp\s*\d{5}/i.test(s)) return null;
    const m = s.match(/\b(\d{5})\b/g);
    return m ? m[m.length-1] : null;
  };

  for(let i=from;i<=to;i++){
    const c = pick5(lines[i]);
    if (c){ note(`Folio ventana fecha/hora @${i}: ${c}`); return c; }
  }

  for(let i=iM;i<Math.min(lines.length,iM+15);i++){
    const s = lines[i];
    if (/\b(cp|col|av|calle)\b/i.test(s)) continue;
    const m = s.match(/\b(\d{5})\b/);
    if (m){ note(`Folio fallback bloque mesero @${i}: ${m[1]}`); return m[1]; }
  }

  note('Folio no encontrado');
  return null;
}

// ===== Ventana de productos =====
function findProductsWindow(lines){
  const start = lines.findIndex(l=>{
    const end = endsWithPrice(l); if(!end) return false;
    const left = end.namePart;
    if (!/[a-z]/i.test(left)) return false;
    if (!looksTextualName(left)) return false;
    return true;
  });
  if (start<0) return {start:-1,end:-1};

  let end = start;
  for(let i=start;i<lines.length;i++){
    const l = lines[i].toLowerCase();
    if (/sub-?total|iva|impuesto|^total\s*:?\s*$/i.test(l)) { end = i-1; break; }
    end = i;
  }
  note(`Ventana productos ${start}..${end}`);
  return {start,end};
}

// ===== Parseo tolerante =====
function parseItems(lines, win){
  if (win.start<0 || win.end<0 || win.end<win.start) return [];
  const out = [];

  function push(name, price){
    if(!name) return;
    let qty = 1;
    const qm = name.match(/(?:^|\s)(?:x\s*)?(\d{1,2})(?:\s*[x×])?(?:\s|$)/i);
    if (qm) qty = Math.max(1, parseInt(qm[1],10));
    name = name
      .replace(/(?:^|\s)(?:x\s*)?\d{1,2}(?:\s*[x×])?(?:\s|$)/ig,' ')
      .replace(/\s{2,}/g,' ')
      .replace(/[.:,-]\s*$/,'')
      .trim();
    if (!looksTextualName(name)) {
      note(`Descartado no-producto: "${name}"`);
      return;
    }
    out.push({ name, qty, price: price ?? 0 });
  }

  for(let i=win.start;i<=win.end;i++){
    const line = lines[i];
    const end  = endsWithPrice(line);

    if (end){
      // línea normal: PRODUCTO .... 199.00
      push(end.namePart, end.price);
      continue;
    }

    // línea SIN precio pero suena a comida → ver la siguiente
    if (looksTextualName(line)){
      const next = lines[i+1] || '';
      const endNext = endsWithPrice(next);
      if (endNext){
        push(line, endNext.price);
        i++; // saltamos la línea de precio
      } else {
        // lo guardamos sin precio, luego registrar.js le asigna puntos
        push(line, 0);
      }
    }
  }

  // compactar
  const comp = [];
  for(const it of out){
    const j = comp.findIndex(x => x.name.toLowerCase() === it.name.toLowerCase());
    if (j>=0){
      comp[j].qty   += it.qty;
      comp[j].price = +(comp[j].price + (it.price||0)).toFixed(2);
    } else {
      comp.push({...it});
    }
  }
  note(`Items detectados (tolerante): ${comp.length}`);
  return comp;
}

// ===== TOTAL =====
function detectGrandTotal(lines){
  const isCard = s => /\b(visa|master|amex|tarjeta|card)\b/i.test(s);

  // 1) si hay propina, buscar TOTAL después
  let propIdx = -1;
  for(let i=0;i<lines.length;i++){
    if (/propina|servicio|service/i.test(lines[i])) propIdx = i;
  }
  if (propIdx>=0){
    for(let j=lines.length-1;j>propIdx;j--){
      const l = lines[j];
      if (/\btotal\b/i.test(l) && !/sub|iva|imp\.?t|impt|impuesto/i.test(l) && !isCard(l)){
        const mm = l.match(/([$\s]*[0-9]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))/g);
        if (mm && mm.length){
          const v = normalizeNum(mm[mm.length-1]);
          if (v!=null){ note(`Total tras propina: ${v}`); return v; }
        }
      }
    }
  }

  // 2) último TOTAL válido
  for(let i=lines.length-1;i>=0;i--){
    const l = lines[i];
    if (/\btotal\b/i.test(l) && !/sub|iva|imp\.?t|impt|impuesto/i.test(l) && !isCard(l)){
      const mm = l.match(/([$\s]*[0-9]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))/g);
      if (mm && mm.length){
        const v = normalizeNum(mm[mm.length-1]);
        if (v!=null){ note(`Total por último TOTAL: ${v}`); return v; }
      }
    }
  }

  // 3) subtotal + propina
  let sub=null, tip=null;
  for(const l of lines){
    if (/sub-?total|subtotal/i.test(l)){
      const mm = l.match(/([$\s]*[0-9]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))/g);
      if (mm) sub = normalizeNum(mm[mm.length-1]);
    } else if (/propina|servicio|service/i.test(l)){
      const mm = l.match(/([$\s]*[0-9]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))/g);
      if (mm) tip = normalizeNum(mm[mm.length-1]);
    }
  }
  if (sub!=null && tip!=null){
    const t = +(sub + tip).toFixed(2);
    note(`Total subtotal+propina: ${t}`);
    return t;
  }

  // 4) máximo importe
  const nums = [];
  lines.forEach(l=>{
    if (isCard(l)) return;
    const mm = l.match(/([$\s]*[0-9]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))/g);
    if (mm) mm.forEach(v => {
      const p = normalizeNum(v);
      if (p!=null) nums.push(p);
    });
  });
  if (nums.length){
    const t = Math.max(...nums);
    note(`Total por máximo importe: ${t}`);
    return t;
  }

  note('Total no encontrado');
  return null;
}

// ===== Preprocesado imagen =====
async function preprocess(file){
  const bmp = await createImageBitmap(file);
  const targetH = 2400;
  const scale = Math.max(1, Math.min(3, targetH / bmp.height));
  const c = Object.assign(document.createElement('canvas'), {
    width: Math.round(bmp.width*scale),
    height: Math.round(bmp.height*scale)
  });
  const ctx = c.getContext('2d');
  ctx.filter = 'grayscale(1) contrast(1.22) brightness(1.06)';
  ctx.drawImage(bmp, 0, 0, c.width, c.height);

  // si hay OpenCV, mejoramos
  if (typeof cv !== 'undefined' && cv?.Mat){
    let src = cv.imread(c);
    let gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
    try{
      const clahe = new cv.CLAHE(2.0, new cv.Size(8,8));
      clahe.apply(gray, gray);
      clahe.delete();
    }catch{}
    let bw = new cv.Mat();
    cv.adaptiveThreshold(gray, bw, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY, 35, 10);
    try{
      let coords = cv.findNonZero(cv.bitwise_not(bw));
      let rect = cv.minAreaRect(coords);
      let angle = rect.angle;
      if (angle < -45) angle += 90;
      const rot = cv.getRotationMatrix2D(new cv.Point(bw.cols/2, bw.rows/2), angle, 1);
      let rotated = new cv.Mat();
      cv.warpAffine(bw, rotated, rot, new cv.Size(bw.cols, bw.rows), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
      bw.delete(); bw = rotated; rot.delete();
      coords?.delete?.();
    }catch{}
    cv.imshow(c, bw);
    src.delete(); gray.delete(); bw.delete();
  }
  return c;
}

// ===== Tesseract wrapper =====
async function ocrCanvas(canvas, { psm=6 } = {}){
  const blob = await new Promise(res=>canvas.toBlob(res, 'image/jpeg', 0.96));
  const { data } = await Tesseract.recognize(
    blob, 'spa+eng',
    {
      tessedit_pageseg_mode: String(psm),
      preserve_interword_spaces: '1',
      user_defined_dpi: '320',
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-:#/$., ',
    }
  );
  return data;
}

// ===== Proceso principal =====
async function processTicket(file){
  const pre = await preprocess(file);

  // zona inferior (totales)
  const h = pre.height, w = pre.width;
  const y0 = Math.max(0, Math.floor(h*0.58));
  const bot = document.createElement('canvas');
  bot.width = w; bot.height = h - y0;
  bot.getContext('2d').drawImage(pre, 0, y0, w, h-y0, 0, 0, w, h-y0);

  const [totals, full] = await Promise.all([
    ocrCanvas(bot,  { psm: 6 }),
    ocrCanvas(pre,  { psm: 4 }),
  ]);

  const totalText = (totals.text||'').trim();
  const fullText  = (full.text||'').trim();

  const lines = splitLines(fullText);
  const win   = findProductsWindow(lines);
  const items = parseItems(lines, win);

  let total = detectGrandTotal(lines.concat(splitLines(totalText)));
  if (total==null && items.length){
    total = +(items.reduce((a,it)=> a + (it.price||0)*(it.qty||1), 0).toFixed(2));
    note(`Total por suma de items: ${total}`);
  }

  const folio = extractFolio5(lines);
  const fecha = toISODateFromText(fullText);

  dump();
  return { folio, fecha, total, items, ocrText: fullText };
}

// ===== Botón “Procesar ticket (OCR)” =====
async function onClickProcesar(){
  const input = document.getElementById('ticketFile');
  const file  = input?.files?.[0];
  if (!file){
    alert('Sube o toma una foto del ticket primero.');
    return;
  }

  const statusEl = document.getElementById('ocrStatus');
  if (statusEl){ statusEl.textContent = '🕐 Escaneando ticket…'; }

  try{
    DBG.notes=[]; DBG.lines=[];
    const res = await processTicket(file);

    const iNum   = document.getElementById('inputTicketNumero');
    const iFecha = document.getElementById('inputTicketFecha');
    const iTotal = document.getElementById('inputTicketTotal');

    if (iNum)   iNum.value   = (res.folio && /^\d{5}$/.test(res.folio)) ? res.folio : '';
    if (iFecha) iFecha.value = res.fecha || '';
    if (iTotal) { iTotal.value = res.total!=null ? res.total.toFixed(2) : ''; iTotal.disabled = false; }

    // mandamos los productos al registrar.js
    const payload = (res.items || []).map(it => ({
      name: it.name,
      qty: it.qty || 1,
      price: typeof it.price === 'number' ? it.price : null
    }));
    window.__ocrProductos = payload;
    document.dispatchEvent(new CustomEvent('ocr:productos', { detail: payload }));

    if (statusEl){
      const okFolio = (res.folio && /^\d{5}$/.test(res.folio));
      const okItems = (res.items && res.items.length>0);
      const okTotal = (res.total!=null);
      statusEl.textContent =
        (okFolio && okItems && okTotal)
          ? '✓ Ticket procesado. Verifica y presiona “Registrar”.'
          : `⚠️ Procesado. ${okFolio?'':'Folio (5 dígitos) no detectado. '} ${okItems?'':'No detecté productos claros. '} ${okTotal?'':'Total no encontrado. '}`.trim();
    }
  }catch(e){
    console.error(e);
    const statusEl = document.getElementById('ocrStatus');
    if (statusEl) statusEl.textContent = '❌ No pude leer el ticket. Intenta con mejor iluminación y encuadre recto.';
    alert('No se pudo leer el ticket. Prueba con más luz, sin sombras y acercando el ticket a la cámara.');
  }
}

document.getElementById('btnProcesarTicket')?.addEventListener('click', onClickProcesar);
