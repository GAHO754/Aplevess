/* ============================================
   ocr.js — OCR robusto para tickets Applebee’s
   ============================================ */

/* ===== Depuración opcional (muestra en <pre id="ocrDebug">) ===== */
const DBG = { lines:[], notes:[] };
function note(s){ try{ DBG.notes.push(String(s)); }catch{} }
function dump(){
  const el = document.getElementById('ocrDebug');
  if(!el) return;
  el.textContent =
    '[NOTAS]\n' + DBG.notes.join('\n') +
    '\n\n[LINEAS]\n' + DBG.lines.map((s,i)=>`${String(i).padStart(2,'0')}: ${s}`).join('\n');
}

/* ===== Utilidades base ===== */
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

function toISODateFromText(text){
  const m = String(text||'').match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](20\d{2})/);
  if(!m) return '';
  let d = +m[1], mo = +m[2], y = +m[3];
  if (d<=12 && mo>12) [d,mo] = [mo,d];
  return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

/* ===== Diccionario mínimo de productos/sinónimos (mejora look de “nombre item”) ===== */
const PRODUCT_HINTS = [
  'burger','hamburguesa','cheeseburger','queso','bacon','pollo','chicken','chiken','nuggets',
  'ribs','costillas','steak','sirloin','ribeye','new york','arrachera',
  'salmon','salmón','tilapia','pescado','shrimp','camarones','fish','chips',
  'fajita','tacos','quesadilla','enchilada','burrito',
  'wings','alitas','boneless','sampler','mozzarella','nachos','dip','onion','aros','cebolla',
  'ensalada','salad','sopa','soup',
  'pasta','alfredo','fettuccine','parm','pomodoro','lasagna','lasaña',
  'postre','dessert','brownie','cheesecake','blondie','helado','ice cream','pie','pastel',
  'margarita','mojito','martini','paloma','aperol','spritz',
  'cerveza','beer','vino','mezcal','tequila','whisky','ron','vodka',
  'refresco','soda','coca','pepsi','sprite','fanta','limonada','agua','jugo','iced tea','malteada','shake','smoothie',
  'coffee','cafe','latte','espresso','te','té','chocolate','kids','combo'
];

const META_RX =
  /\b(sub-?total|subtotal|iva|impuesto|impt|imp\.?t|total|propina|servicio|service|descuento|cover|cup[oó]n|cupon|cambio|redondeo|cancel|anulado|reimpres|cliente|clientes|mesa|mesero|visa|master|amex|tarjeta|efectivo|cash|pago|payment|saldo|orden|order|nota|autoriz)\b/i;
const ADDRESS_RX =
  /\b(cp|c\.p\.|col|col\.|cd|av|avenida|calle|chih|chihuahua|tecnologico|domicilio)\b/i;

function looksTextualName(s){
  if(!s) return false;
  if (/^\d+([x×]\d+)?$/.test(s)) return false; // pura cantidad
  const low = s.toLowerCase();
  if (META_RX.test(low) || ADDRESS_RX.test(low)) return false;
  if (PRODUCT_HINTS.some(w=> low.includes(w))) return true;
  return /[a-záéíóúñ]/i.test(s) && s.length >= 3;
}

/* ===== Detección de precio al final ===== */
function endsWithPrice(line){
  const m = line.match(/(?:\$?\s*)([0-9]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))\s*$/);
  if(!m) return null;
  const price = normalizeNum(m[1]);
  if(price == null) return null;
  const left = line.replace(m[0], '').trim();
  return { namePart:left, price };
}

/* ===== Ventana de productos (amplia) ===== */
function findProductsWindow(lines){
  const start = lines.findIndex(l=>{
    const end = endsWithPrice(l); if(!end) return false;
    const left = end.namePart;
    if (!/[a-z]/i.test(left)) return false;
    if (!looksTextualName(left)) return false;
    return true;
  });
  if (start<0) return {start:-1,end:-1};

  // Avanza hasta antes de totales
  let end = start;
  for(let i=start;i<lines.length;i++){
    const L = lines[i].toLowerCase();
    if (/sub-?total|iva|impuesto|^total\s*:?\s*$/i.test(L)) { end = i-1; break; }
    end = i;
  }
  note(`Ventana productos ${start}..${end}`);
  return {start,end};
}

/* ===== Fusión de líneas partidas (nombre en una línea y precio en la siguiente) ===== */
function mergeWrappedLines(lines, win){
  if (win.start<0) return [];
  const out = [];

  for(let i=win.start; i<=win.end; i++){
    let l = lines[i];
    if (!l) continue;

    const end = endsWithPrice(l);
    if (end){
      out.push(l);
      continue;
    }

    // Si la siguiente línea termina con precio, fusiona
    const next = lines[i+1] || '';
    const endNext = endsWithPrice(next);
    if (endNext){
      const nameJoined = (l + ' ' + endNext.namePart).replace(/\s{2,}/g,' ').trim();
      const merged = nameJoined + ' ' + (next.match(/([0-9]+[.,]\d{2}|\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2}))/) || [''])[0];
      out.push(merged);
      i++; // saltamos la siguiente porque ya la fusionamos
      continue;
    }

    // Si esta línea tiene texto de producto pero sin precio, guárdala por si la siguiente trae cantidad + precio
    out.push(l);
  }

  // Limpia filas que quedaron claramente no-producto
  return out.filter(s=>{
    const e = endsWithPrice(s);
    if (e) return true;
    // Permitimos una línea de ítem sin precio si la siguiente lo trae (arriba ya se unió; aquí descartamos ruido)
    return looksTextualName(s) && !META_RX.test(s) && !ADDRESS_RX.test(s);
  });
}

/* ===== Parseo de ítems robusto ===== */
function parseItems(mergedLines){
  const items = [];

  function pushItem(nameRaw, price){
    if(!nameRaw || price==null || price<=0) return;
    let qty = 1;
    // soporta: "2 ITEM", "ITEM 2", "ITEM x2", "x2 ITEM"
    const qrx = /(?:^|\s)(?:x\s*)?(\d{1,2})(?:\s*[x×])?(?=\s|$)/i;
    const m = nameRaw.match(qrx);
    if (m) qty = Math.max(1, parseInt(m[1],10));

    let name = nameRaw
      .replace(/(?:^|\s)(?:x\s*)?\d{1,2}(?:\s*[x×])?(?=\s|$)/ig,' ')
      .replace(/\s{2,}/g,' ')
      .replace(/[.:,-]\s*$/,'')
      .trim();

    if (!looksTextualName(name)) return;
    items.push({ name, qty, price });
  }

  for (let i=0;i<mergedLines.length;i++){
    const line = mergedLines[i];
    const end = endsWithPrice(line);
    if (end){
      // caso normal: "<texto> ... <precio>"
      pushItem(end.namePart, end.price);
      continue;
    }

    // caso: "2 ITEM" en esta línea y precio en la siguiente
    const next = mergedLines[i+1] || '';
    const endNext = endsWithPrice(next);
    if (endNext && looksTextualName(line)){
      pushItem(line + ' ' + endNext.namePart, endNext.price);
      i++;
      continue;
    }

    // caso: "<texto> 2 99.00" (cantidad en medio, ya cubierto por endsWithPrice)
    // caso: "<texto>" (no hacemos nada)
  }

  // Compactar por nombre (suma qty y precio)
  const comp = [];
  for(const it of items){
    const j = comp.findIndex(x => x.name.toLowerCase() === it.name.toLowerCase());
    if (j>=0){
      comp[j].qty += it.qty;
      comp[j].price = +(comp[j].price + it.price).toFixed(2);
    } else comp.push({...it});
  }
  note(`Items detectados: ${comp.length}`);
  return comp;
}

/* ===== TOTAL (robusto) ===== */
function detectGrandTotal(lines){
  const isCard = (s)=>/\b(visa|master|amex|tarjeta|card)\b/i.test(s);

  // 1) TOTAL tras “propina/servicio”
  let propIdx = -1;
  for(let i=0;i<lines.length;i++) if (/propina|servicio|service/i.test(lines[i])) propIdx = i;
  if (propIdx>=0){
    for(let j=lines.length-1;j>propIdx;j--){
      const l = lines[j];
      if (/\btotal\b/i.test(l) && !/sub|iva|imp\.?t|impt|impuesto/i.test(l) && !isCard(l)){
        const mm = l.match(/([$\s]*[0-9]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))/g);
        if (mm && mm.length){ const v = normalizeNum(mm[mm.length-1]); if(v!=null){ note(`Total tras propina: ${v}`); return v; } }
      }
    }
  }
  // 2) último TOTAL válido
  for(let i=lines.length-1;i>=0;i--){
    const l = lines[i];
    if (/\btotal\b/i.test(l) && !/sub|iva|imp\.?t|impt|impuesto/i.test(l) && !isCard(l)){
      const mm = l.match(/([$\s]*[0-9]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))/g);
      if (mm && mm.length){ const v = normalizeNum(mm[mm.length-1]); if(v!=null){ note(`Total por último TOTAL: ${v}`); return v; } }
    }
  }
  // 3) Subtotal + propina
  let sub=null, tip=null;
  for(const l of lines){
    if (/sub-?total|subtotal/i.test(l)){
      const mm = l.match(/([$\s]*[0-9]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))/g);
      if (mm) sub = normalizeNum(mm[mm.length-1]);
    }else if (/propina|servicio|service/i.test(l)){
      const mm = l.match(/([$\s]*[0-9]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))/g);
      if (mm) tip = normalizeNum(mm[mm.length-1]);
    }
  }
  if (sub!=null && tip!=null){ const t=+(sub+tip).toFixed(2); note(`Total subtotal+propina: ${t}`); return t; }

  // 4) Máximo importe (excluye tarjeta)
  const nums=[];
  lines.forEach(l=>{
    if (isCard(l)) return;
    const mm = l.match(/([$\s]*[0-9]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))/g);
    if (mm) mm.forEach(v=>{ const p = normalizeNum(v); if(p!=null) nums.push(p); });
  });
  if (nums.length){ const t=Math.max(...nums); note(`Total por máximo importe: ${t}`); return t; }

  note('Total no encontrado');
  return null;
}

/* ===== Folio 5 dígitos (cerca de fecha/hora/mesero) ===== */
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
    const c = pick5(lines[i]); if (c){ note(`Folio ventana fecha/hora @${i}: ${c}`); return c; }
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

/* ===== PREPROCESADO IMAGEN ===== */
async function preprocess(file){
  const bmp = await createImageBitmap(file);
  const targetH = 2400;
  const scale = Math.max(1, Math.min(3, targetH / bmp.height));
  const c = Object.assign(document.createElement('canvas'), {
    width: Math.round(bmp.width*scale),
    height: Math.round(bmp.height*scale)
  });
  const ctx = c.getContext('2d');
  ctx.filter = 'grayscale(1) contrast(1.2) brightness(1.06)';
  ctx.drawImage(bmp, 0, 0, c.width, c.height);

  // Si hay OpenCV, binariza + deskew
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

/* ===== Tesseract helpers ===== */
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
  return data; // { text, words, ... }
}

/* ===== Proceso principal con 3 pasadas ===== */
async function processTicket(file){
  const pre = await preprocess(file);

  // 1) Zona ítems (centro 45% de alto)
  const h = pre.height, w = pre.width;
  const yI = Math.max(0, Math.floor(h*0.18));
  const hI = Math.max(60, Math.floor(h*0.45));
  const mid = document.createElement('canvas');
  mid.width = w; mid.height = hI;
  mid.getContext('2d').drawImage(pre, 0, yI, w, hI, 0, 0, w, hI);

  // 2) Zona totales (≈42% final)
  const yT = Math.max(0, Math.floor(h*0.58));
  const bot = document.createElement('canvas');
  bot.width = w; bot.height = h - yT;
  bot.getContext('2d').drawImage(pre, 0, yT, w, h-yT, 0, 0, w, h-yT);

  // OCR en paralelo
  const [dMid, dBot, dFull] = await Promise.all([
    ocrCanvas(mid,  { psm: 6 }),
    ocrCanvas(bot,  { psm: 6 }),
    ocrCanvas(pre,  { psm: 4 }),
  ]);

  const textMid  = (dMid.text||'').trim();
  const textBot  = (dBot.text||'').trim();
  const textFull = (dFull.text||'').trim();

  // Construye líneas para ventana ítems a partir de (mid + full) para mayor recall
  const linesFull = splitLines(textFull);
  const win       = findProductsWindow(linesFull);
  const linesWin  = win.start>=0 ? linesFull.slice(win.start, Math.max(win.start,win.end)+1) : splitLines(textMid);

  // Fusiona líneas partidas y parsea ítems
  const merged = mergeWrappedLines(linesWin, {start:0, end:linesWin.length-1});
  const items  = parseItems(merged);

  // Total robusto combinando zonas
  let total = detectGrandTotal(linesFull.concat(splitLines(textBot)));
  if (total==null && items.length){
    total = +(items.reduce((a,it)=> a + (it.price||0)*(it.qty||1), 0).toFixed(2));
    note(`Total por suma de items: ${total}`);
  }

  // Folio y fecha
  const folio = extractFolio5(linesFull);
  const fecha = toISODateFromText(textFull);

  dump();
  return { folio, fecha, total, items, ocrText: textFull };
}

/* ===== Integración con tu UI actual ===== */
async function onClickProcesar(){
  const input = document.getElementById('ticketFile');
  const file  = input?.files?.[0];
  if (!file){ alert('Sube o toma una foto del ticket primero.'); return; }

  const statusEl = document.getElementById('ocrStatus');
  if (statusEl){ statusEl.textContent = '🕐 Escaneando ticket…'; }

  try{
    DBG.notes=[]; DBG.lines=[];
    const res = await processTicket(file);

    // Campos de salida
    const iNum   = document.getElementById('inputTicketNumero');
    const iFecha = document.getElementById('inputTicketFecha');
    const iTotal = document.getElementById('inputTicketTotal');

    if (iNum)   iNum.value   = (res.folio && /^\d{5}$/.test(res.folio)) ? res.folio : '';
    if (iFecha) iFecha.value = res.fecha || '';
    if (iTotal) { iTotal.value = res.total!=null ? res.total.toFixed(2) : ''; iTotal.disabled = false; }

    // Publica items a tu registrar.js (para llenar tabla de puntos)
    window.__ocrProductos = res.items || [];
    document.dispatchEvent(new CustomEvent('ocr:productos', { detail: window.__ocrProductos }));

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

// Bind
document.getElementById('btnProcesarTicket')?.addEventListener('click', onClickProcesar);
