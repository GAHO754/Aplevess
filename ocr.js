/* ===========================
   ocr.js — OCR dirigido al layout Applebee’s
   (fecha azul, folio rojo, productos verdes, total amarillo)
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

// ===== Diccionario de productos (ES + EN) =====
const FOOD_HINTS = [
  "morita","mezcal","mezcalita",
  "burger","hamburguesa","cheeseburger","bacon","tocino",
  "ribs","costillas","sirloin","tacos","taco","tacos de sirloin","buffalo","salad","ensalada","buffalo salad",
  "pasta","alfredo","fettuccine","lasaña","lasagna",
  "pollo","chicken","tenders",
  "quesadillas","quesadilla","fajita","enchilada","burrito","skillet","nachos",
  "shrimp","camarones","salmon","salmón","fish and chips","fish & chips",
  "postre","dessert","brownie","cheesecake","blondie","ice cream","helado","pastel","pie",
  "margarita","mojito","martini","piña colada","pina colada","spritz","aperol",
  "cerveza","beer","vino","tequila","mezcal","whisky","ron","vodka","bucket",
  "refresco","soda","coca","pepsi","sprite","fanta","limonada","lemonade","agua","jugo","iced tea","smoothie","shake",
  "kids","infantil","sampler","onion rings","aros de cebolla","papas","fries","potato"
];

function looksProductName(s){
  if(!s) return false;
  const low = s.toLowerCase();
  // líneas que NO son productos
  if (/\b(sub-?total|subtotal|iva|impuesto|impt\.?\.?total|propina|servicio|service|descuento|cupon|cambio|cancel|anulado|cliente|clientes|mesa|mesero|reimpres|visa|master|amex|tarjeta|efectivo|pago|payment|auth|total)\b/i.test(low))
    return false;
  if (/\b(cp|c\.p\.|col|av|avenida|calle|domicilio|chihuahua|tecnologico)\b/i.test(low))
    return false;
  // si contiene palabra de comida/bebida → sí
  if (FOOD_HINTS.some(w => low.includes(w))) return true;
  // si tiene letras y no es muy corta → sí
  return /[a-záéíóúñ]/i.test(s) && s.length >= 3;
}

// ===== Fecha (flecha azul) cerca de “Mesero/Mesa/Clientes” =====
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
  // fallback: cualquiera en todo el ticket
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

// ===== Folio (flecha roja) — 5 dígitos en esa misma región =====
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

  // fallback en todo el ticket
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

// ===== Productos (flechas verdes) =====
function parseProductLines(lines){
  const items = [];

  for (let i=0; i<lines.length; i++){
    const line = lines[i];
    // 1) Formato "Morita Mezcal .... 149.00"
    const end = endsWithPrice(line);
    if (end && looksProductName(end.namePart)){
      // es una línea de producto directa
      const name = end.namePart;
      const price = end.price;
      items.push({ name, qty:1, price });
      continue;
    }

    // 2) Formato “Morita Mezcal” en una línea y el precio en la siguiente
    if (looksProductName(line)){
      const next = lines[i+1] || '';
      const endNext = endsWithPrice(next);
      if (endNext){
        items.push({ name: line, qty:1, price: endNext.price });
        i++; // saltamos la línea del precio
      } else {
        // acepta sin precio (luego JS le pone puntos)
        items.push({ name: line, qty:1, price: null });
      }
    }
  }

  // compactamos por nombre
  const compact = [];
  for (const it of items){
    const j = compact.findIndex(x => x.name.toLowerCase() === it.name.toLowerCase());
    if (j >= 0){
      compact[j].qty   += (it.qty||1);
      if (typeof it.price === 'number')
        compact[j].price = +((compact[j].price||0) + it.price).toFixed(2);
    } else {
      compact.push({...it});
    }
  }
  note(`Productos detectados: ${compact.length}`);
  return compact;
}

// ===== Total (flecha amarilla) =====
function detectGrandTotal(lines){
  // buscamos primero el que sea "Total" solito
  for (let i=0;i<lines.length;i++){
    const l = lines[i];
    if (/^total\b/i.test(l.trim()) && !/impt|imp\.?t|iva|visa|propina/i.test(l)){
      const end = endsWithPrice(l);
      if (end){
        note(`Total (directo): ${end.price}`);
        return end.price;
      }
      // a veces viene en la línea de abajo
      const next = lines[i+1] || '';
      const endNext = endsWithPrice(next);
      if (endNext){
        note(`Total (línea abajo): ${endNext.price}`);
        return endNext.price;
      }
    }
  }

  // luego: última línea que diga total sin ser impuesto
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

// ===== Preprocesado imagen (checa calidad) =====
async function preprocess(file){
  const bmp = await createImageBitmap(file);

  // chequeo de calidad mínima
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

  // si hay OpenCV, filtramos un poco
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

// ===== OCR con Tesseract =====
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

// ===== Botón =====
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

    // VALIDACIONES DURAS
    if (!res.folio || !/^\d{5}$/.test(res.folio)){
      throw new Error('NO_FOLIO');
    }
    if (!res.fecha){
      throw new Error('NO_FECHA');
    }
    if (!res.items || !res.items.length){
      throw new Error('NO_ITEMS');
    }
    if (res.total == null){
      throw new Error('NO_TOTAL');
    }

    // pintar en la UI
    const iNum   = document.getElementById('inputTicketNumero');
    const iFecha = document.getElementById('inputTicketFecha');
    const iTotal = document.getElementById('inputTicketTotal');

    if (iNum)   iNum.value   = res.folio;
    if (iFecha) iFecha.value = res.fecha;
    if (iTotal){ iTotal.value = res.total.toFixed(2); iTotal.disabled = false; }

    // mandamos productos al registrar.js
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
    // mensajes bonitos
    let msg = '❌ No pude leer el ticket.';
    if (e.message === 'IMG_LOW_RES') msg = '❌ La foto salió muy chica o borrosa. Tómala otra vez, más cerca y con luz.';
    if (e.message === 'NO_FOLIO')    msg = '❌ No pude ver el número de ticket (5 dígitos). Vuelve a tomar la foto apuntando a la zona del número.';
    if (e.message === 'NO_FECHA')    msg = '❌ No pude ver la fecha. Vuelve a tomar la foto apuntando a la zona de la fecha.';
    if (e.message === 'NO_ITEMS')    msg = '❌ No vi los platillos. Vuelve a tomar la foto para que se vean los nombres y precios completos.';
    if (e.message === 'NO_TOTAL')    msg = '❌ No vi el total. Vuelve a tomar la foto apuntando al “Total”.';

    if (statusEl) statusEl.textContent = msg;
    alert(msg);
    dump();
  }
}

document.getElementById('btnProcesarTicket')?.addEventListener('click', onClickProcesar);
