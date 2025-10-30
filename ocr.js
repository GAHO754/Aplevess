/* ===========================
   ocr.js — OCR robusto para tickets Applebee’s
   con filtrado 2.0 de productos
   =========================== */

/* ===== Depuración opcional ===== */
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
    // arreglos típicos de OCR solo cuando están entre dígitos
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

// normaliza un número estilo MX/US → Number
function normalizeNum(raw){
  if(!raw) return null;
  let s = String(raw).replace(/[^\d.,-]/g,'').trim();
  if(!s) return null;
  if(s.includes(',') && s.includes('.')){
    // elegir el último como decimal
    if (s.lastIndexOf('.') > s.lastIndexOf(',')) {
      s = s.replace(/,/g,'');
    } else {
      s = s.replace(/\./g,'').replace(',', '.');
    }
  } else if (s.includes(',')){
    const m = s.match(/,\d{2}$/);
    s = m ? s.replace(',', '.') : s.replace(/,/g,'');
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? +(n.toFixed(2)) : null;
}

// ¿la línea termina con un precio?
function endsWithPrice(line){
  const m = line.match(/(?:\$?\s*)([0-9]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))\s*$/);
  if(!m) return null;
  const price = normalizeNum(m[1]);
  if(price == null) return null;
  const namePart = line.replace(m[0], '').trim();
  return { namePart, price };
}

// fecha yyyy-mm-dd desde el bloque completo
function toISODateFromText(text){
  const m = String(text||'').match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](20\d{2})/);
  if(!m) return '';
  let d = +m[1], mo = +m[2], y = +m[3];
  if (d<=12 && mo>12) [d,mo] = [mo,d];
  return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

/* ======================================================
   FILTROS que agregamos para quitar lo que no es platillo
   ====================================================== */

// lista negra “aprendida” — aquí puedes ir metiendo lo que se cuele
// lista negra “aprendida” — aquí puedes ir metiendo lo que se cuele
const BAD_PATTERNS = [
  'armuyo rest',
  'reimpresion',
  'reimpresión',
  'are240',
  'are240115daa',
  'rest.',
  'clientes:',
  'reimpresion no',
  'mesa ',
  'cd juarez',
  'chih',
  'cp 32530',
  'impt.total',
  'impt total',
  'impuesto',
  'iva',
  'auth',
  'visa',
  'regimen fiscal',
  'persona moral',
  'gracias por su visita',
  'gracias por tu visita',
  'visitanos',
  'te esperamos pronto',
  'te esperamos manana!!!',
  'sugerenciastapplebeesmx .com'
];


// no-productos por palabras clave
const NOT_PRODUCT_RX =
  /\b(sub-?total|subtotal|iva|impuesto|impt\.?\.?total|propina|servicio|service|descuento|cupon|cambio|cancel|anulado|cliente|clientes|mesa|mesero|reimpres|visa|master|amex|tarjeta|efectivo|pago|payment|auth|total|restaurant|rest\b)\b/i;

// dirección / encabezado
const ADDRESS_RX =
  /\b(cp|c\.p\.|col|av|avenida|calle|domicilio|chihuahua|juarez|tecnologico|tecnológico|cd\s+juarez)\b/i;

// códigos propios de los tickets
const CODEY_RX = /\b(are\d+|armuyo|rest\.?|reimpresion|reimpresión|no\.?:?)\b/i;

// palabras que SÍ queremos (comida/bebidas)
const FOOD_HINTS = [
  // bebidas bar
  "morita","mezcal","mezcalita","margarita","mojito","martini","piña colada","pina colada","spritz","aperol",
  // burgers
  "burger","hamburguesa","cheeseburger","bacon","tocino",
  // fuertes
  "ribs","costillas","sirloin","tacos","taco","tacos de sirloin","arrachera","skillet","steak","ribeye","new york",
  // ensaladas
  "buffalo salad","buffalo","salad","ensalada","caesar","cesar",
  // entradas
  "sampler","onion rings","aros de cebolla","nachos","dip","chips","queso",
  // pastas
  "pasta","alfredo","fettuccine","lasaña","lasagna","parm",
  // pollo/pescado
  "pollo","chicken","tenders","shrimp","camarones","salmon","salmón","fish and chips","fish & chips","tilapia",
  // postres
  "postre","dessert","brownie","cheesecake","blondie","ice cream","helado","pastel","pie",
  // bebidas normales
  "refresco","soda","coca","pepsi","sprite","fanta","limonada","lemonade","agua","jugo","iced tea","smoothie","shake",
  // niños
  "kids","infantil"
];

// ¿esta línea es claramente basura?
function isObviouslyGarbage(str){
  const s = str.toLowerCase();
  // 1) match con lista negra
  if (BAD_PATTERNS.some(p => s.includes(p))) return true;
  // 2) demasiados símbolos
  const nonLetters = s.replace(/[a-záéíóúñ0-9 ]/g,'');
  if (nonLetters.length >= 6) return true;
  // 3) muy cortito o muy largo
  if (s.length < 6) return true;     // “E A”, “a 1”, “3 y”
  if (s.length > 55) return true;    // direcciones
  // 4) solo mayús + números + puntos → parece código
  if (/^[A-Z0-9 .-]{6,}$/.test(str) && !/[a-z]/.test(str)) return true;
  return false;
}

// ¿suena a platillo/bebida?
function looksProductName(str){
  if (!str) return false;
  const s = str.toLowerCase().trim();

  // filtros duros primero
  if (isObviouslyGarbage(s)) return false;
  if (NOT_PRODUCT_RX.test(s)) return false;
  if (ADDRESS_RX.test(s)) return false;
  if (CODEY_RX.test(s)) return false;

  // si trae una palabra de comida/bebida → sí
  if (FOOD_HINTS.some(w => s.includes(w))) return true;

  // 2–6 palabras normales con letras → lo aceptamos
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length >= 2 && parts.length <= 6 && /[a-záéíóúñ]/i.test(s)) {
    return true;
  }

  return false;
}

/* ===== Productos (flechas verdes) — versión filtrada 2.0 ===== */
function parseProductLines(lines){
  const raw = [];

  for (let i=0; i<lines.length; i++){
    const line = lines[i];

    // descartar líneas de sistema
    if (NOT_PRODUCT_RX.test(line) || ADDRESS_RX.test(line) || CODEY_RX.test(line) || isObviouslyGarbage(line)) {
      continue;
    }

    // 1) línea con precio al final
    const end = endsWithPrice(line);
    if (end) {
      const name = end.namePart;
      if (looksProductName(name)) {
        raw.push({ name, qty:1, price:end.price });
      }
      continue;
    }

    // 2) línea que parece producto pero SIN precio:
    //    intentamos tomar el precio de la siguiente
    if (looksProductName(line)) {
      const next = lines[i+1] || '';
      const endNext = endsWithPrice(next);
      if (endNext && !isObviouslyGarbage(next)) {
        raw.push({ name: line, qty:1, price:endNext.price });
        i++; // ya usamos la de abajo
      } else {
        // sin precio pero sí parece producto
        raw.push({ name: line, qty:1, price:null });
      }
    }
  }

  // compactar por nombre
  const compact = [];
  for (const it of raw){
    const j = compact.findIndex(x => x.name.toLowerCase() === it.name.toLowerCase());
    if (j >= 0){
      compact[j].qty   += (it.qty||1);
      if (typeof it.price === 'number')
        compact[j].price = +((compact[j].price||0) + it.price).toFixed(2);
    } else {
      compact.push({...it});
    }
  }

  // 🔥 paso extra: si hay demasiado ruido, nos quedamos con los 6 más "claros"
  if (compact.length > 6) {
    const withPrice  = compact.filter(p => typeof p.price === 'number');
    const without    = compact.filter(p => typeof p.price !== 'number');
    const sorted     = withPrice.concat(without);
    compact.length = 0;
    compact.push(...sorted.slice(0,6));
  }

  note(`Productos detectados (filtrados 2.0): ${compact.length}`);
  return compact;
}

/* ===== TOTAL (robusto contra subtotal/propina) ===== */
function detectGrandTotal(lines){
  const isCard = (s)=>/\b(visa|master|amex|tarjeta|card)\b/i.test(s);

  // 1) si hay propina/servicio, buscamos un TOTAL después
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
          if(v!=null){ note(`Total tras propina: ${v}`); return v; }
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
        if(v!=null){ note(`Total por último TOTAL: ${v}`); return v; }
      }
    }
  }

  // 3) subtotal + propina
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
  if (sub!=null && tip!=null){
    const t=+(sub+tip).toFixed(2);
    note(`Total subtotal+propina: ${t}`);
    return t;
  }

  // 4) máximo importe (excluye tarjeta)
  const nums=[];
  lines.forEach(l=>{
    if (isCard(l)) return;
    const mm = l.match(/([$\s]*[0-9]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))/g);
    if (mm) mm.forEach(v=>{ const p = normalizeNum(v); if(p!=null) nums.push(p); });
  });
  if (nums.length){
    const t=Math.max(...nums);
    note(`Total por máximo importe: ${t}`);
    return t;
  }

  note('Total no encontrado');
  return null;
}

/* ===== Folio de 5 dígitos cerca de fecha/hora/mesero ===== */
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
    if (/cp\s*\d{5}/i.test(s)) return null; // Código Postal no
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
  ctx.filter = 'grayscale(1) contrast(1.22) brightness(1.06)';
  ctx.drawImage(bmp, 0, 0, c.width, c.height);

  // si hay OpenCV, binarizamos
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
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-:#/$., '
    }
  );
  return data; // {text, words, …}
}

/* ===== Proceso principal ===== */
async function processTicket(file){
  const pre = await preprocess(file);

  // parte inferior (totales)
  const h = pre.height, w = pre.width;
  const y0 = Math.max(0, Math.floor(h*0.58));
  const bot = document.createElement('canvas');
  bot.width = w; bot.height = h - y0;
  bot.getContext('2d').drawImage(pre, 0, y0, w, h-y0, 0, 0, w, h-y0);

  // OCR en paralelo
  const [totals, full] = await Promise.all([
    ocrCanvas(bot,  { psm: 6 }),
    ocrCanvas(pre,  { psm: 4 }),
  ]);

  const totalText = (totals.text||'').trim();
  const fullText  = (full.text||'').trim();

  const lines = splitLines(fullText);

  // productos (flechas verdes)
  const productos = parseProductLines(lines);

  // total
  let total = detectGrandTotal(lines.concat(splitLines(totalText)));
  if (total==null && productos.length){
    total = +(productos.reduce((a,it)=> a + (it.price||0)*(it.qty||1), 0).toFixed(2));
    note(`Total por suma de items: ${total}`);
  }

  // folio y fecha
  const folio = extractFolio5(lines);
  const fecha = toISODateFromText(fullText);

  dump();
  return { folio, fecha, total, items: productos, ocrText: fullText };
}

/* ===== Integración con tu UI ===== */
async function onClickProcesar(){
  const input = document.getElementById('ticketFile');
  const file  = input?.files?.[0];
  if (!file){ alert('Sube o toma una foto del ticket primero.'); return; }

  const statusEl = document.getElementById('ocrStatus');
  if (statusEl){ statusEl.textContent = '🕐 Escaneando ticket…'; }

  try{
    DBG.notes=[]; DBG.lines=[];
    const res = await processTicket(file);

    // rellenar campos
    const iNum   = document.getElementById('inputTicketNumero');
    const iFecha = document.getElementById('inputTicketFecha');
    const iTotal = document.getElementById('inputTicketTotal');

    if (iNum)   iNum.value   = (res.folio && /^\d{5}$/.test(res.folio)) ? res.folio : '';
    if (iFecha) iFecha.value = res.fecha || '';
    if (iTotal) { iTotal.value = res.total!=null ? res.total.toFixed(2) : ''; iTotal.disabled = false; }

    // mandar productos al registrar.js
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

// botón
document.getElementById('btnProcesarTicket')?.addEventListener('click', onClickProcesar);


