/* ===========================
   ocr.js — SOLO OCR + PARSING (robusto)
   =========================== */

/* ---------- Utils ---------- */
function normalize(s){
  return String(s||'')
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/[^\w$%#./,:\- \t\n]/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}

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
  return String(text||'')
    .replace(/\r/g,'\n')
    .split('\n')
    .map(s => s.replace(/\s{2,}/g,' ').trim())
    .filter(Boolean);
}

/* ---------- Diccionarios ---------- */
// Líneas que NO son producto (pago/impuestos/etc.)
const META_RX =
  /(^|\b)(sub-?total|subtotal|iva|impuesto|impt\.?\.?total|impt|total\s*:?$|reimpres|propina|servicio|service|cover|cargo|descuento|discount|cupon|cambio|redondeo|cancel|anulado|mesa|clientes?|mesero|cajero|visa|master|amex|tarjeta|efectivo|cash|auth|autoriz|met[oó]do|pago|payment|saldo|abon|anticipo|transacci[oó]n|orden|order|nota|reimpresi[oó]n)(\b|$)/i;

// Palabras típicas de dirección / encabezado
const ADDRESS_RX =
  /\b(cp|c\.p\.|col|col\.|cd|av|avenida|calle|chih|chihuahua|tecnologico|domicilio)\b/i;

// Señal de “línea parece un importe”
function isLikelyPriceLine(s) {
  return /[$]\s*\d|^\s*\d{1,3}([.,]\d{3})*([.,]\d{2})\s*$/.test(s);
}

/* ---------- Ticket # (exactamente 5 dígitos, anclado a fecha/hora) ---------- */
function tokenizeLine(line) {
  return String(line||'').replace(/[^\w:\-#]/g, ' ').split(/\s+/).filter(Boolean);
}
function findLineIndex(lines, rx){ for(let i=0;i<lines.length;i++) if(rx.test(lines[i])) return i; return -1; }
function extractTicketNumber5(lines, allText) {
  const dateRx = /(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](20\d{2})/;
  const timeRx = /(\d{1,2}):(\d{2})\s*(am|pm)?/i;
  const anchor  = Math.max(findLineIndex(lines, dateRx), findLineIndex(lines, timeRx));

  const isAddressLine = (s) => ADDRESS_RX.test(s);

  const fiveDigitAt = (s) => {
    if (isLikelyPriceLine(s) || isAddressLine(s)) return null;
    const m = s.match(/\b(\d{5})\b/g);
    if (!m) return null;
    let last = null, lastIdx = -1;
    m.forEach(tok => { const idx = s.lastIndexOf(tok); if (idx > lastIdx){ last=tok; lastIdx=idx; }});
    return last;
  };

  if (anchor >= 0){
    const end = Math.min(lines.length-1, anchor + 3);
    for (let i=anchor; i<=end; i++){
      const cand = fiveDigitAt(lines[i]);
      if (cand) return cand;
    }
  }

  // Fallback con ranking simple
  const nearWords = ["mesero","mesa","clientes","reimpres","reimpresión","reimpresion","cajero"];
  const candidates = [];
  for (let i=0;i<Math.min(lines.length,60);i++){
    const line = lines[i].trim();
    if (!line || isLikelyPriceLine(line) || isAddressLine(line)) continue;
    const m = line.match(/\b(\d{5})\b/);
    if (m){
      let score = 1;
      const low = ' '+line.toLowerCase()+' ';
      nearWords.forEach(w=>{ if(low.includes(' '+w+' ')) score+=3; });
      if (anchor>=0){
        const dist = Math.abs(i - anchor);
        if (i >= anchor) score += 3;
        if (dist <= 3) score += 4;
      }
      if (i <= 18) score += 2;
      candidates.push({tok:m[1], score});
    }
  }
  if (candidates.length){
    candidates.sort((a,b)=>b.score-a.score);
    return candidates[0].tok;
  }

  // Último recurso
  for (let i=0;i<Math.min(lines.length,60);i++){
    const l = lines[i].trim();
    if (isLikelyPriceLine(l) || isAddressLine(l)) continue;
    const m = l.match(/(?:^|\s)(\d{5})(?:\s|$)/);
    if (m) return m[1];
  }
  return null;
}

/* ---------- Heurística de PRODUCTOS ---------- */
// Palabras “positivas” que sugieren alimento/bebida (es/en)
const FOOD_HINTS = [
  // categorías base
  "burger","hamburguesa","cheeseburger","bacon","ribs","costillas","steak","sirloin","ribeye","new york","arrachera",
  "salmon","salmón","tilapia","pescado","shrimp","camarones","fish","chips","fajita","tacos","quesadilla","enchilada","burrito",
  "wings","alitas","boneless","sampler","mozzarella","nachos","chips","dip","onion","aros","cebolla",
  "ensalada","salad","sopa","soup","pasta","alfredo","fettuccine","parm","pomodoro","lasagna","lasaña",
  "postre","dessert","brownie","cheesecake","blondie","helado","ice cream","pie","pastel","apple pie",
  "margarita","mojito","martini","paloma","piña colada","pina colada","gin","tonic","aperol","spritz",
  "cerveza","beer","vino","mezcal","tequila","whisky","ron","vodka","refresco","soda","coca","pepsi","sprite","fanta",
  "limonada","agua","jugo","iced tea","malteada","shake","smoothie","coffee","cafe","latte","espresso","té","te","chocolate"
];

// ¿la línea parece claramente “meta”?
function isMetaLine(line){
  return META_RX.test(line);
}

// ¿acaba con un precio?
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
  // si contiene algún “hint” de comida/bebida, true
  if (FOOD_HINTS.some(w => n.includes(w))) return true;

  // fallback: si es corto pero con letras, aceptamos (ej: “Morita Mezcal”, “Te Shake”)
  // — descarta cosas muy genéricas
  if (n.length >= 3 && !/^(total|item|linea|line|product|producto|cuenta)$/i.test(n)) return true;

  return false;
}

/* ---------- Productos desde líneas ---------- */
function parseItemsFromLines(lines){
  const items = [];
  let bufferName = '';

  const PUSH = (name, price) => {
    if(!name) return;
    // cantidad: "x2", "2x", "2 ..."
    let qty = 1;
    const qm = name.match(/(?:^|\s)(?:x\s*)?(\d{1,2})(?:\s*x)?(?:\s|$)/i);
    if(qm) qty = Math.max(1, parseInt(qm[1],10));
    name = name
      .replace(/(?:^|\s)(?:x\s*)?\d{1,2}(?:\s*x)?(?:\s|$)/ig, ' ')
      .replace(/\s{2,}/g,' ')
      .replace(/[.:,-]\s*$/,'') // limpia finales
      .trim();

    if (!looksLikeFoodName(name)) return;
    if (price <= 0) return;

    items.push({ name, qty, price });
  };

  for (let i=0; i<lines.length; i++){
    const line = lines[i];
    if (!line || isMetaLine(line)) { bufferName = ''; continue; }

    const end = lineEndsWithPrice(line);
    if (end){
      const price = end.price;
      let name   = (bufferName ? (bufferName + ' ' + end.namePart) : end.namePart).trim();
      bufferName = '';
      PUSH(name, price);
      continue;
    }

    // posible parte de nombre
    if (!isLikelyPriceLine(line) && !ADDRESS_RX.test(line)){
      const next = lines[i+1] || '';
      if (next && isMetaLine(next)) { bufferName = ''; continue; }
      // si la línea tiene palabras food hints, la guardamos por si el precio viene abajo
      if (FOOD_HINTS.some(h => normalize(line).includes(h)) || (!META_RX.test(line) && line.length >= 3)){
        bufferName = (bufferName ? (bufferName + ' ' + line) : line).trim();
      }
    }
  }

  // Compacta por nombre
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
  return compact;
}

/* ---------- TOTAL pagado (incluye propina si existe) ---------- */
function detectGrandTotal(lines){
  const isCardLine = (s)=>/\b(visa|master|amex|tarjeta|card)\b/i.test(s);

  // 1) Si hay “Propina/Service”, toma el último “Total” DESPUÉS
  let propIndex = -1;
  for (let i=0;i<lines.length;i++){
    if (/propina|servicio|service/i.test(lines[i])) propIndex = i;
  }
  if (propIndex >= 0) {
    for (let j=lines.length-1; j>propIndex; j--){
      const l = lines[j];
      if (/\btotal\b/i.test(l) && !/impt|imp\.?t|iva|sub/i.test(l) && !isCardLine(l)) {
        const m = l.match(/([$\s]*[0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))/g);
        if (m && m.length){
          const last = parsePriceMX(m[m.length-1]);
          if (last!=null) return last;
        }
      }
    }
  }

  // 2) Último “Total” no asociado a tarjeta
  for (let i=lines.length-1; i>=0; i--){
    const l = lines[i];
    if (/\btotal\b/i.test(l) && !/impt|imp\.?t|iva|sub/i.test(l) && !isCardLine(l)) {
      const m = l.match(/([$\s]*[0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))/g);
      if (m && m.length){
        const last = parsePriceMX(m[m.length-1]);
        if (last!=null) return last;
      }
    }
  }

  // 3) Fallback: mayor importe del documento (ignorando líneas de tarjeta)
  const nums = [];
  lines.forEach(l=>{
    if (isCardLine(l)) return;
    const mm = l.match(/([$\s]*[0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))/g);
    if(mm) mm.forEach(v=>{ const p = parsePriceMX(v); if(p!=null) nums.push(p); });
  });
  if (nums.length) return Math.max(...nums);
  return null;
}

/* ---------- Parseo principal ---------- */
function parseTicketText(text){
  const lines = splitLinesForReceipt(text);
  const all   = lines.join('\n');

  const numero = extractTicketNumber5(lines, all);

  // Fecha a YYYY-MM-DD
  let fechaISO = null;
  const dm = all.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](20\d{2})/);
  if (dm){
    let d = +dm[1], m = +dm[2], y = +dm[3];
    if (d<=12 && m>12) [d,m] = [m,d];
    fechaISO = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  }

  const total = detectGrandTotal(lines);
  const productosDetectados = parseItemsFromLines(lines).filter(p => p.price > 0);

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
  const targetH = 2000;
  const scale = Math.max(1, Math.min(2.4, targetH / img.height));
  const c = Object.assign(document.createElement('canvas'), {
    width:  Math.round(img.width * scale),
    height: Math.round(img.height * scale)
  });
  const ctx = c.getContext('2d');
  ctx.filter = 'grayscale(1) contrast(1.18) brightness(1.06)';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise(res=>c.toBlob(res, 'image/jpeg', 0.95));

  const { data:{ text } } = await Tesseract.recognize(
    blob, 'spa+eng',
    {
      logger: m => console.log(m),
      tessedit_pageseg_mode: 6,
      preserve_interword_spaces: '1',
      user_defined_dpi: '300',
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
    const text = await recognizeImageToText(file);
    const { numero, fecha, total, productosDetectados } = parseTicketText(text);

    const iNum   = document.getElementById('inputTicketNumero');
    const iFecha = document.getElementById('inputTicketFecha');
    const iTotal = document.getElementById('inputTicketTotal');

    if (iNum){
      if (numero && /^\d{5}$/.test(numero)) iNum.value = numero; else iNum.value = '';
    }
    if (iFecha && fecha)  iFecha.value = fecha;
    if (iTotal && total)  iTotal.value = parseFloat(total).toFixed(2);

    // Publica productos a registrar.js
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
    alert("No se pudo leer el ticket. Prueba con más luz y encuadre recto.");
  }
}

document.getElementById('btnProcesarTicket')?.addEventListener('click', leerTicket);
