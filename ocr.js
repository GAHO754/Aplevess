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
  return String(text||'')
    .replace(/\r/g,'\n')
    .split('\n')
    .map(s => s.replace(/\s{2,}/g,' ').trim())
    .filter(Boolean);
}

function isMetaLine(line){
  return /sub-?total|subtotal|iva|impuesto|impt\.?\.?total|total\s*:?$|reimpres|propina|mesa|clientes?|visa|tarjeta|auth|método|metodo|pago/i.test(line);
}

function lineEndsWithPrice(line){
  const m = line.match(/(?:\$?\s*)([0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))\s*$/);
  if(!m) return null;
  const price = parsePriceMX(m[1]);
  if(price == null) return null;
  const namePart = line.replace(m[0], '').trim();
  return { namePart, price };
}

// Si tienes PRODUCT_LEXICON en registrar.js, lo respetamos si existe
function canonicalProductNameFree(txt){
  if (!window.PRODUCT_LEXICON) return txt;
  const norm = ' ' + String(txt||'').toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"") + ' ';
  for (const [canon, syns] of Object.entries(window.PRODUCT_LEXICON)){
    for(const kw of syns){
      const k = ' ' + String(kw).toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g,"") + ' ';
      if(norm.includes(k)) return canon;
    }
  }
  return txt;
}

/* ---------- Productos desde líneas ---------- */
function parseItemsFromLines(lines){
  const items = [];
  let bufferName = '';

  const PUSH = (name, price) => {
    if(!name) return;
    // cantidad: “x2”, “2x”, “2 …”
    let qty = 1;
    const qm = name.match(/(?:^|\s)(?:x\s*)?(\d{1,2})(?:\s*x)?(?:\s|$)/i);
    if(qm) qty = Math.max(1, parseInt(qm[1],10));
    name = name
      .replace(/(?:^|\s)(?:x\s*)?\d{1,2}(?:\s*x)?(?:\s|$)/ig, ' ')
      .replace(/\s{2,}/g,' ')
      .trim();

    // ignora promos típicas con precio 0
    if (/2x1|bono|desc|promo|promoción|desayunos/i.test(name) && price === 0) return;

    const canon = canonicalProductNameFree(name);
    items.push({ name: canon, qty, price });
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

    // línea de nombre (posible wrap)
    if (line.length >= 3 && !/^\d{1,4}$/.test(line)) {
      const next = lines[i+1] || '';
      if (next && isMetaLine(next)) { bufferName = ''; continue; }
      bufferName = (bufferName ? (bufferName + ' ' + line) : line).trim();
    }
  }

  // Compactar por nombre
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

/* ---------- Parseo principal (número, fecha, total, productos) ---------- */
function parseTicketText(text){
  const lines = splitLinesForReceipt(text);
  const all   = lines.join('\n');

  // Número de ticket
  let numero = null;
  const tagged = all.match(/(?:orden|order|folio|ticket|tkt|transac(?:cion)?|venta|nota|id|no\.?)\s*(?:#|:)?\s*([a-z0-9\-]{3,})/i);
  if (tagged) numero = tagged[1].toUpperCase();
  if (!numero) {
    for (let i=0; i<Math.min(12, lines.length); i++){
      const l = lines[i];
      if (/^\d{4,8}$/.test(l)) { numero = l; break; }
    }
  }

  // Fecha -> YYYY-MM-DD
  let fechaISO = null;
  const dm = all.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](20\d{2})/);
  if (dm){
    let d = +dm[1], m = +dm[2], y = +dm[3];
    if (d<=12 && m>12) [d,m] = [m,d];
    fechaISO = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  }

  // Total (última línea con “Total … <precio>”)
  let total = null;
  for (let i=0;i<lines.length;i++){
    const l = lines[i];
    if (/total/i.test(l)){
      const m = l.match(/([$\s]*[0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))/g);
      if (m && m.length){
        const last = parsePriceMX(m[m.length-1]);
        if (last!=null) total = last; // nos quedamos con la última encontrada
      }
    }
  }
  // Fallback: mayor importe si no se halló “Total …”
  if (total == null){
    const nums = [];
    lines.forEach(l=>{
      const mm = l.match(/([$\s]*[0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))/g);
      if(mm) mm.forEach(v=>{ const p = parsePriceMX(v); if(p!=null) nums.push(p); });
    });
    if (nums.length) total = Math.max(...nums);
  }

  // Renglones de productos (nombre … precio), ignorando promos 0.00
  const productosDetectados = parseItemsFromLines(lines).filter(p => p.price > 0);

  return {
    numero,
    fecha: fechaISO,
    total: total!=null ? total.toFixed(2) : null,
    productosDetectados // [{name, qty, price}]
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

/* ---------- Punto de entrada (botón “Procesar ticket”) ---------- */
async function leerTicket(){
  const input = document.getElementById("ticketImage") || document.getElementById("ticketFile");
  const file  = input?.files?.[0];
  if (!file) return alert("Selecciona o toma una foto del ticket.");

  const statusEl = document.getElementById("ocrStatus") || document.getElementById("ocrResult");
  if (statusEl){ statusEl.textContent = "🕐 Escaneando ticket…"; }

  try{
    const text = await recognizeImageToText(file);
    const { numero, fecha, total, productosDetectados } = parseTicketText(text);

    // Rellena inputs
    const iNum   = document.getElementById('inputTicketNumero');
    const iFecha = document.getElementById('inputTicketFecha');
    const iTotal = document.getElementById('inputTicketTotal');
    if (iNum && numero)   iNum.value   = numero;
    if (iFecha && fecha)  iFecha.value = fecha;
    if (iTotal && total)  iTotal.value = parseFloat(total).toFixed(2);

    // Publica productos para registrar.js
    window.__ocrProductos = productosDetectados || [];
    document.dispatchEvent(new CustomEvent('ocr:productos', { detail: window.__ocrProductos }));

    if (statusEl){
      statusEl.textContent = "✓ Ticket procesado. Verifica y presiona “Registrar”.";
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

// Activa el botón
document.getElementById('btnProcesarTicket')?.addEventListener('click', leerTicket);
