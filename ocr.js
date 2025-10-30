/* ===========================
   ocr.js — OCR dirigido al layout Applebee’s
   =========================== */

// ===== Depuración =====
const DBG = { lines:[], notes:[] };
function note(s){ try{ DBG.notes.push(String(s)); }catch{} }
function dump(){
  const el = document.getElementById('ocrDebug');
  if(!el) return;
  el.textContent =
    '[NOTAS]\n' + DBG.notes.join('\n') +
    '\n\n[LINEAS]\n' + DBG.lines.map((s,i)=>`${String(i).padStart(2,'0')}: ${s}`).join('\n');
}

// ===== Helpers básicos =====
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

/* ===== Listas de ayuda ===== */

// palabras que NO son productos
const NOT_PRODUCT_RX =
  /\b(sub-?total|subtotal|iva|impuesto|impt\.?\.?total|propina|servicio|service|descuento|cupon|cambio|cancel|anulado|cliente|clientes|mesa|mesero|reimpres|visa|master|amex|tarjeta|efectivo|pago|payment|auth|total|rest\b|restaurant|rest\.)\b/i;

// encabezados / dirección
const ADDRESS_RX =
  /\b(cp|c\.p\.|col|av|avenida|calle|domicilio|chihuahua|juarez|tecnologico|tecnológico|cd\s+juarez)\b/i;

// códigos de sistema típicos
const CODEY_RX = /\b(are\d+|armuyo|rest\.?|reimpresion|reimpresión|no\.?:?)\b/i;

// diccionario ES + EN de platillos y bebidas
const FOOD_HINTS = [
  // bebidas/tragos
  "morita","mezcal","mezcalita","margarita","mojito","martini","piña colada","pina colada","spritz","aperol",
  // hamburguesas
  "burger","hamburguesa","cheeseburger","bacon","tocino",
  // meat / tex-mex
  "ribs","costillas","sirloin","tacos","taco","tacos de sirloin","arrachera","skillet",
  // ensaladas
  "buffalo salad","buffalo","salad","ensalada","caesar","cesar",
  // entradas
  "sampler","onion rings","aros de cebolla","nachos","dip","chips","queso",
  // pastas
  "pasta","alfredo","fettuccine","lasaña","lasagna","parm",
  // pollo / seafood
  "pollo","chicken","tenders","shrimp","camarones","salmon","salmón","fish and chips","fish & chips",
  // postres
  "postre","dessert","brownie","cheesecake","blondie","ice cream","helado","pastel","pie",
  // bebidas sencillas
  "refresco","soda","coca","pepsi","sprite","fanta","limonada","lemonade","agua","jugo","iced tea","smoothie","shake",
  // niños
  "kids","infantil"
];

// ¿esta frase suena a platillo/bebida?
function looksProductName(str){
  if (!str) return false;
  const s = str.toLowerCase();

  // descartar si trae palabras de no-producto
  if (NOT_PRODUCT_RX.test(s)) return false;
  if (ADDRESS_RX.test(s)) return false;
  if (CODEY_RX.test(s)) return false;

  // si contiene palabra de lista → sí
  if (FOOD_HINTS.some(w => s.includes(w))) return true;

  // si tiene pocas palabras y son letras → también la aceptamos
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length >= 2 && parts.length <= 6 && /[a-záéíóúñ]/i.test(s)) {
    return true;
  }

  return false;
}

// ===== Fecha (flecha azul) =====
function extractDateNearBlock(lines){
  const blockIdx = lines.findIndex(s => /\bmesero\b|\bmesa\b|\bclientes?\b/i.test(s));
  const minIdx = blockIdx >= 0 ? blockIdx : 0;
  const maxIdx = Math.min(lines.length-1, (blockIdx>=0 ? blockIdx+5 : 5));
  for (let i=minIdx; i<=maxIdx; i++){
    const m = lines[i].match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](20\d{2})/);
    if (m){
      let d = +m[1], mo = +m[2], y = +m[3];
      if (d<=12 && mo>12) [d,mo] = [mo,d];
      const iso = `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      note(`Fecha (zona azul) @${i}: ${iso}`);
      return iso;
    }
  }
  // fallback global
  for (let i=0;i<lines.length;i++){
    const m = lines[i].match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](20\d{2})/);
    if (m){
      let d = +m[1], mo = +m[2], y = +m[3];
      if (d<=12 && mo>12) [d,mo] = [mo,d];
      const iso = `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      note(`Fecha (fallback): ${iso}`);
      return iso;
    }
  }
  note('Fecha no encontrada');
  return '';
}

// ===== Folio (flecha roja) =====
function extractFolioNearBlock(lines){
  const blockIdx = lines.findIndex(s => /\bmesero\b|\bmesa\b|\bclientes?\b/i.test(s));
  const minIdx = blockIdx >= 0 ? blockIdx : 0;
  const maxIdx = Math.min(lines.length-1, (blockIdx>=0 ? blockIdx+6 : 8));
  const isCP = s => /cp\s*\d{5}/i.test(s);

  for (let i=minIdx; i<=maxIdx; i++){
    const s = lines[i];
    if (isCP(s)) continue;
    const m = s.match(/\b(\d{5})\b/);
    if (m){
      note(`Folio (zona roja) @${i}: ${m[1]}`);
      return m[1];
    }
  }
  // fallback global
  for (let i=0;i<lines.length;i++){
    const s = lines[i];
    if (isCP(s)) continue;
    const m = s.match(/\b(\d{5})\b/);
    if (m){
      note(`Folio (fallback): ${m[1]}`);
      return m[1];
    }
  }
  note('Folio 5 dígitos no encontrado');
  return null;
}

// ===== Productos (flechas verdes) — versión filtrada =====
function parseProductLines(lines){
  const raw = [];

  for (let i=0; i<lines.length; i++){
    const line = lines[i];

    // 0. descartar líneas de encabezado / sistema
    if (NOT_PRODUCT_RX.test(line) || ADDRESS_RX.test(line) || CODEY_RX.test(line)) {
      continue;
    }

    // 1) línea con precio al final
    const end = endsWithPrice(line);
    if (end) {
      const name = end.namePart;
      // la línea que trae precio debe pasar el filtro de producto
      if (looksProductName(name)) {
        raw.push({ name, qty:1, price:end.price });
      }
      continue;
    }

    // 2) línea que parece producto pero SIN precio
    if (looksProductName(line)) {
      // buscamos precio en la siguiente
      const next = lines[i+1] || '';
      const endNext = endsWithPrice(next);
      if (endNext) {
        raw.push({ name: line, qty:1, price:endNext.price });
        i++;
      } else {
        // la aceptamos sin precio
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

  note(`Productos detectados (filtrados): ${compact.length}`);
  return compact;
}

// ===== Total =====
function detectGrandTotal(lines){
  // "Total" solito
  for (let i=0;i<lines.length;i++){
    const l = lines[i];
    if (/^total\b/i.test(l.trim()) && !/impt|imp\.?t|iva|visa|propina/i.test(l)){
      const end = endsWithPrice(l);
      if (end){
        note(`Total (directo): ${end.price}`);
        return end.price;
      }
      const next = lines[i+1] || '';
      const endNext = endsWithPrice(next);
      if (endNext){
        note(`Total (línea abajo): ${endNext.price}`);
        return endNext.price;
      }
    }
  }
  // último "Total" válido
  for (let i=lines.length-1; i>=0; i--){
    const l = lines[i];
    if (/\btotal\b/i.test(l) && !/impt|imp\.?t|iva|visa|propina/i.test(l)){
      const end = endsWithPrice(l);
      if (end){
        note(`Total (último válido): ${end.price}`);
        return end.price;
      }
    }
  }
  // fallback: mayor importe
  const nums = [];
  lines.forEach(l=>{
    if (/visa|propina|tarjeta/i.test(l)) return;
    const mm = l.match(/([$\s]*[0-9]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))/g);
    if (mm) mm.forEach(v=>{
      const p = normalizeNum(v);
      if (p != null) nums.push(p);
    });
  });
  if (nums.length){
    const t = Math.max(...nums);
    note(`Total (max importe): ${t}`);
    return t;
  }
  note('Total no encontrado');
  return null;
}

// ===== Preprocesado imagen =====
async function preprocess(file){
  const bmp = await createImageBitmap(file);
  if (bmp.width < 800 || bmp.height < 800){
    throw new Error("IMG_LOW_RES");
  }
  const targetH = 2400;
  const scale = Math.max(1, Math.min(3, targetH / bmp.height));
  const c = Object.assign(document.createElement('canvas'), {
    width: Math.round(bmp.width*scale),
    height: Math.round(bmp.height*scale)
  });
  const ctx = c.getContext('2d');
  ctx.filter = 'grayscale(1) contrast(1.22) brightness(1.06)';
  ctx.drawImage(bmp, 0, 0, c.width, c.height);

  if (typeof cv !== 'undefined' && cv?.Mat){
    let src = cv.imread(c);
    let gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
    let bw = new cv.Mat();
    cv.adaptiveThreshold(gray, bw, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY, 35, 10);
    cv.imshow(c, bw);
    src.delete(); gray.delete(); bw.delete();
  }
  return c;
}

// ===== OCR =====
async function ocrCanvas(canvas){
  const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.96));
  const { data } = await Tesseract.recognize(
    blob, 'spa+eng',
    {
      tessedit_pageseg_mode: '4',
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
  const { text } = await ocrCanvas(pre);
  const lines = splitLines(text);

  const fecha = extractDateNearBlock(lines);
  const folio = extractFolioNearBlock(lines);
  const items = parseProductLines(lines);
  const total = detectGrandTotal(lines);

  dump();
  return { fecha, folio, items, total };
}

// ===== Botón OCR =====
async function onClickProcesar(){
  const input = document.getElementById('ticketFile');
  const file  = input?.files?.[0];
  if (!file){
    alert('Sube o toma una foto del ticket primero.');
    return;
  }

  const statusEl = document.getElementById('ocrStatus');
  if (statusEl) statusEl.textContent = '⏳ Escaneando ticket…';

  try{
    DBG.lines=[]; DBG.notes=[];
    const res = await processTicket(file);

    if (!res.folio || !/^\d{5}$/.test(res.folio)) throw new Error('NO_FOLIO');
    if (!res.fecha) throw new Error('NO_FECHA');
    if (!res.items || !res.items.length) throw new Error('NO_ITEMS');
    if (res.total == null) throw new Error('NO_TOTAL');

    const iNum   = document.getElementById('inputTicketNumero');
    const iFecha = document.getElementById('inputTicketFecha');
    const iTotal = document.getElementById('inputTicketTotal');

    if (iNum)   iNum.value   = res.folio;
    if (iFecha) iFecha.value = res.fecha;
    if (iTotal){ iTotal.value = res.total.toFixed(2); iTotal.disabled = false; }

    // enviar a registrar.js
    const payload = res.items.map(it => ({
      name: it.name,
      qty: it.qty || 1,
      price: typeof it.price === 'number' ? it.price : null
    }));
    window.__ocrProductos = payload;
    document.dispatchEvent(new CustomEvent('ocr:productos', { detail: payload }));

    if (statusEl) statusEl.textContent = '✅ Ticket procesado. Revisa y registra.';
  }catch(e){
    console.error(e);
    const statusEl = document.getElementById('ocrStatus');
    let msg = '❌ No pude leer el ticket.';
    if (e.message === 'IMG_LOW_RES') msg = '❌ La foto salió muy chica o borrosa. Tómala otra vez, más cerca y con luz.';
    if (e.message === 'NO_FOLIO')    msg = '❌ No pude ver el número de ticket (5 dígitos). Vuelve a tomar la foto apuntando a la zona del número.';
    if (e.message === 'NO_FECHA')    msg = '❌ No pude ver la fecha. Vuelve a tomar la foto apuntando a la zona de la fecha.';
    if (e.message === 'NO_ITEMS')    msg = '❌ No vi los platillos/bebidas. Tómala otra vez más cerca donde se lean los nombres y los precios.';
    if (e.message === 'NO_TOTAL')    msg = '❌ No vi el total. Tómala otra vez apuntando al “Total”.';
    if (statusEl) statusEl.textContent = msg;
    alert(msg);
    dump();
  }
}

document.getElementById('btnProcesarTicket')?.addEventListener('click', onClickProcesar);
