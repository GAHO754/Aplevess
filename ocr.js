/* ===========================
   ocr.js — OCR + PARSE robusto con zona de productos y depuración
   =========================== */

/* ---------- Utilidades ---------- */
const DBG = { lines:[], notes:[] };
function debugNote(s){ try{DBG.notes.push(String(s));}catch{} }
function dumpDebug(){
  const el = document.getElementById('ocrDebug');
  if(!el) return;
  el.textContent =
    '[NOTAS]\n' + DBG.notes.join('\n') +
    '\n\n[LINEAS]\n' + DBG.lines.map((s,i)=>`${String(i).padStart(2,'0')}: ${s}`).join('\n');
}

function normalize(s){
  return String(s||'')
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/[^\w$%#./,:\- \t\n]/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}

/* Arreglos OCR comunes en una línea (no tocar precios) */
function fixOCRLine(s){
  if(!s) return s;
  // solo en la parte "texto", no números con decimales
  // cambios seguros: O->0 cuando está rodeado de dígitos, l->1, I->1, S->5 si está claramente rodeado de dígitos
  return s
    .replace(/(?<=\d)O(?=\d)/g,'0')
    .replace(/(?<=\d)S(?=\d)/g,'5')
    .replace(/(?<=\d)l(?=\d)/g,'1')
    .replace(/(?<=\d)I(?=\d)/g,'1');
}

// 1,234.56 / 1.234,56 / 169 -> Number
function parsePriceMX(raw){
  if(!raw) return null;
  let s = String(raw).replace(/[^\d.,]/g,'').trim();
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

function splitLinesForReceipt(text){
  const arr = String(text||'')
    .replace(/\r/g,'\n')
    .split('\n')
    .map(s=>fixOCRLine(s.replace(/\s{2,}/g,' ').trim()))
    .filter(Boolean);
  DBG.lines = arr.slice();
  return arr;
}

function isPriceToken(tok){ return /^[\s$]*\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2})\s*$/.test(tok); }
function isLikelyPriceLine(s){ return /[$]\s*\d|^\s*\d{1,3}([.,]\d{3})*([.,]\d{2})\s*$/.test(s); }

/* ---------- Diccionarios ---------- */
const META_RX =
  /(^|\b)(sub-?total|subtotal|iva|impuesto|impt\.?\.?total|impt|total\s*:?$|reimpres|propina|servicio|service|cover|cargo|descuento|discount|cupon|cambio|redondeo|cancel|anulado|mesa|clientes?|mesero|cajero|visa|master|amex|tarjeta|efectivo|cash|auth|autoriz|met[oó]do|pago|payment|saldo|abon|anticipo|transacci[oó]n|orden|order|nota|reimpresi[oó]n)(\b|$)/i;

const ADDRESS_RX =
  /\b(cp|c\.p\.|col|col\.|cd|av|avenida|calle|chih|chihuahua|tecnologico|domicilio)\b/i;

const FOOD_HINTS = [
  "burger","hamburguesa","cheeseburger","bacon",
  "ribs","costillas","steak","sirloin","ribeye","new york","arrachera",
  "salmon","salmón","tilapia","pescado","shrimp","camarones","fish","chips",
  "fajita","tacos","quesadilla","enchilada","burrito",
  "wings","alitas","boneless","sampler","mozzarella","nachos","dip","onion","aros","cebolla",
  "ensalada","salad","sopa","soup",
  "pasta","alfredo","fettuccine","parm","pomodoro","lasagna","lasaña",
  "postre","dessert","brownie","cheesecake","blondie","helado","ice cream","pie","pastel",
  "margarita","mojito","martini","paloma","piña colada","pina colada","gin","tonic","aperol","spritz",
  "cerveza","beer","vino","mezcal","tequila","whisky","ron","vodka",
  "refresco","soda","coca","pepsi","sprite","fanta","limonada","agua","jugo","iced tea","malteada","shake","smoothie",
  "coffee","cafe","latte","espresso","te","té","chocolate"
];

/* ---------- Ayudas ---------- */
function lineEndsWithPrice(line){
  const m = line.match(/(?:\$?\s*)([0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))\s*$/);
  if(!m) return null;
  const price = parsePriceMX(m[1]);
  if(price == null) return null;
  const namePart = line.replace(m[0], '').trim();
  return { namePart, price };
}
function looksLikeFoodName(nameRaw){
  const n = normalize(nameRaw);
  if (!n) return false;
  if (META_RX.test(n) || ADDRESS_RX.test(n)) return false;
  if (FOOD_HINTS.some(w => n.includes(w))) return true;
  // tolerante: si es un texto corto con letras (no puro número)
  return /[a-z]/i.test(n) && n.length>=3;
}

/* ---------- Fecha/Hora y anclas ---------- */
function findDateIndex(lines){ return lines.findIndex(s=>/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](20\d{2})/.test(s)); }
function findTimeIndex(lines){ return lines.findIndex(s=>/(\d{1,2}):(\d{2})\s*(am|pm)?/i.test(s)); }
function findMeseroBlockIndex(lines){
  const i = lines.findIndex(s=>/\bmesero\b|\bmesa\b|\bclientes?\b/i.test(s));
  return i>=0? i : 0;
}

/* ---------- Ticket # exactamente 5 dígitos (pegado a hora/fecha y después de “Mesero”) ---------- */
function extractTicketNumber5(lines){
  const idxD = findDateIndex(lines);
  const idxT = findTimeIndex(lines);
  const idxM = findMeseroBlockIndex(lines);
  const anchor = (idxD>=0 || idxT>=0) ? Math.max(idxD,idxT) : -1;

  const inWindow = (i)=> (i>=0 && i<lines.length);
  const from = Math.max(idxM, anchor>=0?anchor:idxM);
  const to   = Math.min(lines.length-1, from+5);

  const fiveFromLine = (s) => {
    if (!s) return null;
    if (/cp\s*\d{5}/i.test(s)) return null; // CP
    const m = s.match(/\b(\d{5})\b/g);
    if (!m) return null;
    // si hay tag “Reimpresion No.: 2” ignora ese “2”
    const last = m[m.length-1];
    return last;
  };

  // 1) ventana cerca de fecha/hora
  for (let i=from; i<=to; i++){
    const cand = fiveFromLine(lines[i]);
    if (cand) { debugNote(`Folio por ventana fecha/hora @${i}: ${cand}`); return cand; }
  }

  // 2) fallback: buscar 5 dígitos entre mesero-bloque y antes de totales
  for (let i=idxM;i<Math.min(lines.length, idxM+15);i++){
    const s = lines[i];
    if (META_RX.test(s) || ADDRESS_RX.test(s)) continue;
    const m = s.match(/\b(\d{5})\b/);
    if (m){ debugNote(`Folio fallback bloque mesero @${i}: ${m[1]}`); return m[1]; }
  }

  debugNote('Folio no encontrado');
  return null;
}

/* ---------- Delimitar ZONA de productos ---------- */
function findProductsWindow(lines){
  const start = lines.findIndex((s,i)=>{
    const end = lineEndsWithPrice(s);
    if(!end) return false;
    const left = end.namePart;
    if (META_RX.test(left) || ADDRESS_RX.test(left)) return false;
    if (!/[a-z]/i.test(left)) return false; // debe tener letras
    return true;
  });
  if (start < 0) return {start:-1,end:-1};

  let end = start;
  for (let i=start;i<lines.length;i++){
    const l = lines[i];
    if (/sub-?total|iva|impuesto|impt\.?\.?total|^total\s*:?\s*$/i.test(l)) { end = i-1; break; }
    end = i;
  }
  debugNote(`Ventana de productos: ${start}..${end}`);
  return {start,end};
}

/* ---------- Parseo de productos dentro de la ventana ---------- */
function parseItemsFromWindow(lines, w){
  if (w.start<0 || w.end<0 || w.end<w.start) return [];
  const items = [];

  const PUSH = (name, price) => {
    if(!name) return;
    let qty = 1;
    const qm = name.match(/(?:^|\s)(?:x\s*)?(\d{1,2})(?:\s*x)?(?:\s|$)/i);
    if(qm) qty = Math.max(1, parseInt(qm[1],10));
    name = name
      .replace(/(?:^|\s)(?:x\s*)?\d{1,2}(?:\s*x)?(?:\s|$)/ig, ' ')
      .replace(/\s{2,}/g,' ')
      .replace(/[.:,-]\s*$/,'')
      .trim();

    if (!looksLikeFoodName(name)) { debugNote(`Descartado nombre no-food: "${name}"`); return; }
    if (price <= 0) return;

    items.push({ name, qty, price });
  };

  for (let i=w.start; i<=w.end; i++){
    const line = lines[i];
    if (META_RX.test(line) || ADDRESS_RX.test(line)) continue;
    // Debe terminar con precio
    const end = lineEndsWithPrice(line);
    if (!end) continue;

    const left = end.namePart;
    if (!/[a-z]/i.test(left)) continue;

    PUSH(left, end.price);
  }

  // Compactar
  const compact = [];
  for(const it of items){
    const j = compact.findIndex(x => x.name.toLowerCase() === it.name.toLowerCase());
    if (j>=0){
      compact[j].qty   += it.qty;
      compact[j].price += it.price;
    } else {
      compact.push({...it});
    }
  }
  compact.forEach(x => x.price = +(x.price.toFixed(2)));
  debugNote(`Productos detectados: ${compact.length}`);
  return compact;
}

/* ---------- TOTAL pagado ---------- */
function detectGrandTotal(lines){
  const isCardLine = (s)=>/\b(visa|master|amex|tarjeta|card)\b/i.test(s);
  let propIndex = -1;
  for (let i=0;i<lines.length;i++){
    if (/propina|servicio|service/i.test(lines[i])) propIndex = i;
  }
  // 1) Total después de propina
  if (propIndex >= 0){
    for (let j=lines.length-1; j>propIndex; j--){
      const l = lines[j];
      if (/\btotal\b/i.test(l) && !/impt|imp\.?t|iva|sub/i.test(l) && !isCardLine(l)) {
        const m = l.match(/([$\s]*[0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))/g);
        if (m && m.length){ const last = parsePriceMX(m[m.length-1]); if (last!=null){ debugNote(`Total tras propina: ${last}`); return last; } }
      }
    }
  }
  // 2) Último Total válido
  for (let i=lines.length-1; i>=0; i--){
    const l = lines[i];
    if (/\btotal\b/i.test(l) && !/impt|imp\.?t|iva|sub/i.test(l) && !isCardLine(l)) {
      const m = l.match(/([$\s]*[0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))/g);
      if (m && m.length){ const last = parsePriceMX(m[m.length-1]); if (last!=null){ debugNote(`Total por último TOTAL: ${last}`); return last; } }
    }
  }
  // 3) Suma Subtotal + Propina como respaldo
  let sub=null, tip=null;
  for (const l of lines){
    if (/sub-?total|subtotal/i.test(l)){
      const m = l.match(/([$\s]*[0-9]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))/g);
      if (m){ sub = parsePriceMX(m[m.length-1]); }
    } else if (/propina|servicio|service/i.test(l)){
      const m = l.match(/([$\s]*[0-9]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))/g);
      if (m){ tip = parsePriceMX(m[m.length-1]); }
    }
  }
  if (sub!=null && tip!=null){ const t=+(sub+tip).toFixed(2); debugNote(`Total por Subtotal+Propina: ${t}`); return t; }

  // 4) Mayor importe del documento (excluye tarjeta)
  const nums=[];
  lines.forEach(l=>{
    if (isCardLine(l)) return;
    const mm = l.match(/([$\s]*[0-9]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))/g);
    if(mm) mm.forEach(v=>{ const p = parsePriceMX(v); if(p!=null) nums.push(p); });
  });
  if (nums.length){ const t=Math.max(...nums); debugNote(`Total por máximo importe: ${t}`); return t; }

  debugNote('Total no encontrado');
  return null;
}

/* ---------- Parseo principal ---------- */
function parseTicketText(text){
  const lines = splitLinesForReceipt(text);

  // Fecha -> YYYY-MM-DD
  let fechaISO = null;
  const all = lines.join('\n');
  const dm = all.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](20\d{2})/);
  if (dm){
    let d = +dm[1], m = +dm[2], y = +dm[3];
    if (d<=12 && m>12) [d,m] = [m,d];
    fechaISO = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  }

  const numero = extractTicketNumber5(lines);

  const win = findProductsWindow(lines);
  const productosDetectados = parseItemsFromWindow(lines, win);

  const total = detectGrandTotal(lines);

  dumpDebug();
  return {
    numero,
    fecha: fechaISO,
    total: total!=null ? total.toFixed(2) : null,
    productosDetectados
  };
}

/* ---------- OCR (Tesseract) ---------- */
async function recognizeImageToText(file){
  const img = await createImageBitmap(file);

  // Upscale + binarizado suave
  const targetH = 2400;
  const scale = Math.max(1, Math.min(3, targetH / img.height));
  const c = Object.assign(document.createElement('canvas'), {
    width:  Math.round(img.width * scale),
    height: Math.round(img.height * scale)
  });
  const ctx = c.getContext('2d');
  ctx.filter = 'grayscale(1) contrast(1.22) brightness(1.06)';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise(res=>c.toBlob(res, 'image/jpeg', 0.96));

  const { data:{ text } } = await Tesseract.recognize(
    blob, 'spa+eng',
    {
      logger: m => console.log(m),
      tessedit_pageseg_mode: 6,
      preserve_interword_spaces: '1',
      user_defined_dpi: '320',
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-:#/$., ',
    }
  );
  return text;
}

/* ---------- Punto de entrada ---------- */
async function leerTicket(){
  const input = document.getElementById("ticketImage") || document.getElementById("ticketFile");
  const file  = input?.files?.[0];
  if (!file) return alert("Selecciona o toma una foto del ticket.");

  const statusEl = document.getElementById("ocrStatus") || document.getElementById("ocrResult");
  if (statusEl){ statusEl.textContent = "🕐 Escaneando ticket…"; }

  try{
    DBG.notes=[]; DBG.lines=[];
    const text = await recognizeImageToText(file);
    const { numero, fecha, total, productosDetectados } = parseTicketText(text);

    const iNum   = document.getElementById('inputTicketNumero');
    const iFecha = document.getElementById('inputTicketFecha');
    const iTotal = document.getElementById('inputTicketTotal');

    if (iNum){
      iNum.value = (numero && /^\d{5}$/.test(numero)) ? numero : '';
    }
    if (iFecha && fecha)  iFecha.value = fecha;
    if (iTotal && total)  iTotal.value = parseFloat(total).toFixed(2);

    window.__ocrProductos = productosDetectados || [];
    document.dispatchEvent(new CustomEvent('ocr:productos', { detail: window.__ocrProductos }));

    if (statusEl){
      const okFolio = (numero && /^\d{5}$/.test(numero));
      const okItems = (productosDetectados && productosDetectados.length>0);
      const okTotal = (total!=null);
      statusEl.textContent =
        (okFolio && okItems && okTotal)
          ? "✓ Ticket procesado. Verifica y presiona “Registrar”."
          : `⚠️ Procesado. ${okFolio?'':'Folio 5 dígitos no detectado. '} ${okItems?'':'No detecté productos claros. '} ${okTotal?'':'Total no encontrado. '}`.trim();
      statusEl.classList?.remove('loading-dots');
    }
  } catch(e){
    console.error(e);
    if (statusEl){
      statusEl.textContent = "❌ No pude leer el ticket. Intenta de nuevo con mejor iluminación.";
      statusEl.classList?.remove('loading-dots');
    }
    alert("No se pudo leer el ticket. Prueba con más luz, encuadre recto y sin sombras.");
  }
}

document.getElementById('btnProcesarTicket')?.addEventListener('click', leerTicket);
