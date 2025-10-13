/* ===========================
   ocr.js — SOLO OCR + PARSING
   (No escribe a la BD. Rellena inputs y emite productos)
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

function isMetaLine(line){
  return /sub-?total|subtotal|iva|impuesto|impt\.?\.?total|^total\s*$|^total\s*:|reimpres|propina|servicio|service|mesa|clientes?|visa|master|tarjeta|auth|autoriz|método|metodo|pago|efectivo|cambio/i.test(line);
}

function lineEndsWithPrice(line){
  const m = line.match(/(?:\$?\s*)([0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))\s*$/);
  if(!m) return null;
  const price = parsePriceMX(m[1]);
  if(price == null) return null;
  const namePart = line.replace(m[0], '').trim();
  return { namePart, price };
}

/* ---------- Detector de FOLIO (exactamente 5 dígitos) ---------- */
function isLikelyPriceLine(s) {
  return /[$]\s*\d|^\s*\d{1,3}([.,]\d{3})*([.,]\d{2})\s*$/.test(s);
}
function tokenizeLine(line) {
  return String(line||'')
    .replace(/[^\w:\-#]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}
function findDateTokens(allText) {
  const m = allText.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](20\d{2})/);
  if (!m) return null;
  return { d: +m[1], m: +m[2], y: +m[3], raw: m[0] };
}
function findTimeTokens(allText) {
  const m = allText.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (!m) return null;
  return { h: +m[1], min: +m[2], ap: (m[3]||'').toLowerCase(), raw: m[0] };
}
function findLineIndex(lines, rx){
  for (let i=0;i<lines.length;i++) if (rx.test(lines[i])) return i;
  return -1;
}

/**
 * Reglas nuevas (para tu formato):
 *  - Preferimos un token de **5 dígitos** que esté en la MISMA línea que la hora/fecha
 *    o en las siguientes 1–3 líneas (el típico “50037” bajo la fecha).
 *  - Si una línea tiene “CP”, “C.P.” o palabras de dirección (av, col, cd, chih, cp), se DESCARTA.
 *  - Se ignoran líneas que parecen montos/precios.
 *  - Si no aparece cerca de fecha/hora, volvemos a un ranking general con penalización fuerte a direcciones.
 */
function extractTicketNumber5(lines, allText) {
  const dateRx = /(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](20\d{2})/;
  const timeRx = /(\d{1,2}):(\d{2})\s*(am|pm)?/i;

  const dateIdx = findLineIndex(lines, dateRx);
  const timeIdx = findLineIndex(lines, timeRx);
  const anchor  = Math.max(dateIdx, timeIdx); // normalmente están juntos en la misma zona

  const isAddressLine = (s) => /\b(cp|c\.p\.|col|col\.|cd|av|avenida|calle|chih|chihuahua|cp\s*\d{4,6})\b/i.test(s);

  const fiveDigitAt = (s) => {
    if (isLikelyPriceLine(s) || isAddressLine(s)) return null;
    const m = s.match(/\b(\d{5})\b/g);
    if (!m) return null;
    // si hay varios, toma el más a la derecha (suele estar alineado a la derecha)
    let last = null, lastIdx = -1;
    m.forEach(tok => {
      const idx = s.lastIndexOf(tok);
      if (idx > lastIdx) { last = tok; lastIdx = idx; }
    });
    return last;
  };

  // (1) Misma línea de fecha/hora o 1–3 líneas debajo
  if (anchor >= 0){
    const end = Math.min(lines.length-1, anchor + 3);
    for (let i=anchor; i<=end; i++){
      const cand = fiveDigitAt(lines[i]);
      if (cand) return cand;
    }
  }

  // (2) Etiqueta explícita + 5 dígitos
  const tagRx = /(folio|ticket|tkt|transac(?:cion)?|transacción|venta|nota|id|no\.?|n°|nº|num\.?|orden|order)\s*(?:#|:)?\s*([a-z0-9\-]{3,})/i;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(tagRx);
    if (m && !isAddressLine(lines[i])) {
      const raw = m[2].replace(/[^a-z0-9\-]/gi,'');
      const cand = raw.match(/^\d{5}$/) ? raw : null;
      if (cand) return cand.toUpperCase();
    }
  }

  // (3) Ranking general (penaliza dirección, premia cercanía a anchor)
  const nearWords = ["mesero","mesa","clientes","reimpres","reimpresión","reimpresion","cajero"];
  const candidates = [];
  for (let i = 0; i < Math.min(lines.length, 60); i++) {
    const line = lines[i].trim();
    if (!line || isLikelyPriceLine(line) || isAddressLine(line)) continue;
    const tokens = tokenizeLine(line);
    tokens.forEach(tok => {
      if (/^\d{5}$/.test(tok)) {
        let score = 1;
        const low = ' ' + line.toLowerCase() + ' ';
        nearWords.forEach(w => { if (low.includes(' ' + w + ' ')) score += 3; });
        if (anchor >= 0) {
          const dist = Math.abs(i - anchor);
          if (i >= anchor) score += 3;           // preferimos debajo de fecha/hora
          if (dist <= 3)   score += 4;           // muy cerca de fecha/hora
        }
        if (i <= 18) score += 2;
        candidates.push({ tok, score });
      }
    });
  }
  if (candidates.length) {
    candidates.sort((a,b)=> b.score - a.score);
    return String(candidates[0].tok).toUpperCase();
  }

  // (4) Último recurso: primer 5-dígitos no-precio no-dirección
  for (let i = 0; i < Math.min(lines.length, 60); i++) {
    const l = lines[i].trim();
    if (isLikelyPriceLine(l) || isAddressLine(l)) continue;
    const m = l.match(/(?:^|\s)(\d{5})(?:\s|$)/);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

/* ---------- Productos desde líneas ---------- */
function parseItemsFromLines(lines){
  const items = [];
  let bufferName = '';

  const PUSH = (name, price) => {
    if(!name) return;
    let qty = 1;
    const qm = name.match(/(?:^|\s)(?:x\s*)?(\d{1,2})(?:\s*x)?(?:\s|$)/i);
    if(qm) qty = Math.max(1, parseInt(qm[1],10));
    name = name
      .replace(/(?:^|\s)(?:x\s*)?\d{1,2}(?:\s*x)?(?:\s|$)/ig, ' ')
      .replace(/\s{2,}/g,' ')
      .trim();
    if (/2x1|bono|desc|promo|promoción|desayunos/i.test(name) && price === 0) return;
    items.push({ name, qty, price });
  };

  for (let i=0; i<lines.length; i++){
    const line = lines[i];
    if (isMetaLine(line)) { bufferName = ''; continue; }

    const end = lineEndsWithPrice(line);
    if (end){
      const price = end.price;
      let name   = (bufferName ? (bufferName + ' ' + end.namePart) : end.namePart).trim();
      bufferName = '';
      if (price > 0) PUSH(name, price);
      continue;
    }

    if (line.length >= 3 && !/^\d{1,4}$/.test(line)) {
      const next = lines[i+1] || '';
      if (next && isMetaLine(next)) { bufferName = ''; continue; }
      bufferName = (bufferName ? (bufferName + ' ' + line) : line).trim();
    }
  }

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

/* ---------- TOTAL pagado (incluyendo propina) ---------- */
function detectGrandTotal(lines){
  let propIndex = -1;
  for (let i=0;i<lines.length;i++){
    if (/propina|servicio|service/i.test(lines[i])) propIndex = i;
  }
  if (propIndex >= 0) {
    for (let j=lines.length-1; j>propIndex; j--){
      const l = lines[j];
      if (/\btotal\b/i.test(l) && !/impt|imp\.?t|iva|sub/i.test(l)) {
        const m = l.match(/([$\s]*[0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))/g);
        if (m && m.length){
          const last = parsePriceMX(m[m.length-1]);
          if (last!=null) return last;
        }
      }
    }
  }
  for (let i=lines.length-1; i>=0; i--){
    const l = lines[i];
    if (/\btotal\b/i.test(l) && !/impt|imp\.?t|iva|sub/i.test(l)) {
      const m = l.match(/([$\s]*[0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))/g);
      if (m && m.length){
        const last = parsePriceMX(m[m.length-1]);
        if (last!=null) return last;
      }
    }
  }
  const nums = [];
  lines.forEach(l=>{
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

/* ---------- OCR con Tesseract ---------- */
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
      if (numero && /^\d{5}$/.test(numero)) iNum.value = numero;
      else iNum.value = '';
    }
    if (iFecha && fecha)  iFecha.value = fecha;
    if (iTotal && total)  iTotal.value = parseFloat(total).toFixed(2);

    window.__ocrProductos = productosDetectados || [];
    document.dispatchEvent(new CustomEvent('ocr:productos', { detail: window.__ocrProductos }));

    if (statusEl){
      const okFolio = (numero && /^\d{5}$/.test(numero));
      statusEl.textContent = okFolio
        ? "✓ Ticket procesado. Verifica y presiona “Registrar”."
        : "⚠️ Procesado. No pude asegurar un FOLIO de 5 dígitos (buscado bajo la fecha/hora). Revísalo antes de registrar.";
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
