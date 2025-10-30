

/* ========== CONFIGURA AQUÍ TU API KEY ========== */
/* IMPORTANTE:
   - Si esto lo vas a servir desde hosting público, NO dejes
     la apiKey en el frontend. Mejor haz un endpoint en tu backend.
   - Aquí lo dejo directo porque me pediste “para probar ya”.
*/
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;


/* =========================================================
   1. Utilidades de depuración
   ========================================================= */
const DBG = { lines:[], notes:[] };
function note(s){ try{ DBG.notes.push(String(s)); }catch{} }
function dump(){
  const el = document.getElementById('ocrDebug');
  if(!el) return;
  el.textContent =
    '[NOTAS]\n' + DBG.notes.join('\n') +
    '\n\n[LINEAS]\n' + DBG.lines.map((s,i)=>`${String(i).padStart(2,'0')}: ${s}`).join('\n');
}

/* =========================================================
   2. Utilidades de texto / números
   ========================================================= */
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

function looksTextualName(s){
  if(!s) return false;
  if (/^\d+([x×]\d+)?$/.test(s)) return false;
  const low = s.toLowerCase();
  if (/\b(sub-?total|subtotal|iva|impuesto|propina|servicio|service|descuento|cover|cupon|cambio|cancel|anulado|cliente|clientes|mesa|mesero|visa|master|amex|tarjeta|efectivo|cash|pago|payment|saldo|orden|order|nota|reimpres|autoriz)/.test(low)) return false;
  if (/\b(cp|c\.p\.|col|av|avenida|calle|domicilio|chihuahua|tecnologico)\b/i.test(low)) return false;
  return /[a-záéíóúñ]/i.test(s) && s.length >= 3;
}

function toISODateFromText(text){
  const m = String(text||'').match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](20\d{2})/);
  if(!m) return '';
  let d = +m[1], mo = +m[2], y = +m[3];
  if (d<=12 && mo>12) [d,mo] = [mo,d];
  return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

/* =========================================================
   3. Ventana de productos (parser clásico)
   ========================================================= */
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

function parseItems(lines, win){
  if (win.start<0 || win.end<0 || win.end<win.start) return [];
  const out = [];

  function push(name, price){
    if(!name || price==null || price<=0) return;
    let qty = 1;
    const qm = name.match(/(?:^|\s)(?:x\s*)?(\d{1,2})(?:\s*[x×])?(?:\s|$)/i);
    if (qm) qty = Math.max(1, parseInt(qm[1],10));
    name = name
      .replace(/(?:^|\s)(?:x\s*)?\d{1,2}(?:\s*[x×])?(?:\s|$)/ig,' ')
      .replace(/\s{2,}/g,' ')
      .replace(/[.:,-]\s*$/,'')
      .trim();
    if (!looksTextualName(name)) { note(`Descartado no-item: "${name}"`); return; }
    out.push({ name, qty, price });
  }

  for(let i=win.start;i<=win.end;i++){
    const l = lines[i];
    const end = endsWithPrice(l);
    if(!end) continue;
    const left = end.namePart;
    if (!/[a-z]/i.test(left)) continue;
    push(left, end.price);
  }

  // compactar
  const comp = [];
  for(const it of out){
    const j = comp.findIndex(x => x.name.toLowerCase() === it.name.toLowerCase());
    if (j>=0){
      comp[j].qty += it.qty;
      comp[j].price = +(comp[j].price + it.price).toFixed(2);
    } else comp.push({...it});
  }
  note(`Items (parser clásico): ${comp.length}`);
  return comp;
}

/* =========================================================
   4. TOTAL (parser clásico)
   ========================================================= */
function detectGrandTotal(lines){
  const isCard = (s)=>/\b(visa|master|amex|tarjeta|card)\b/i.test(s);

  // 1) Después de propina
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
  // 2) Último total
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

  // 4) Mayor importe
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

/* =========================================================
   5. Folio de 5 dígitos
   ========================================================= */
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

/* =========================================================
   6. Preprocesado de imagen
   ========================================================= */
async function preprocess(file){
  const bmp = await createImageBitmap(file);
  const targetH = 2400;
  const scale = Math.max(1, Math.min(3, targetH / bmp.height));
  const c = Object.assign(document.createElement('canvas'), {
    width: Math.round(bmp.width*scale),
    height: Math.round(bmp.height*scale)
  });
  const ctx = c.getContext('2d');
  ctx.filter = 'grayscale(1) contrast(1.18) brightness(1.07)';
  ctx.drawImage(bmp, 0, 0, c.width, c.height);

  // Si hay OpenCV, intentamos binarizar
  if (typeof cv !== 'undefined' && cv?.Mat){
    try{
      let src = cv.imread(c);
      let gray = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
      let bw = new cv.Mat();
      cv.adaptiveThreshold(gray, bw, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY, 35, 10);
      cv.imshow(c, bw);
      src.delete(); gray.delete(); bw.delete();
    }catch(e){
      console.warn('OpenCV no aplicado:', e);
    }
  }

  return c;
}

/* =========================================================
   7. Tesseract helpers
   ========================================================= */
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

/* =========================================================
   8. IA: identificar productos con OpenAI
   ========================================================= */
async function identificarProductosConIA(textoOCR){
  if (!OPENAI_API_KEY || OPENAI_API_KEY.startsWith("PON_AQUI")) {
    note('IA desactivada: no hay API KEY');
    return [];
  }

  const prompt = `
Eres un asistente que extrae información de tickets de restaurantes (Applebee's México).
Del siguiente texto de ticket identifica SOLO los productos consumidos.
Reglas:
- Ignora subtotal, total, IVA, propina, formas de pago.
- Si no hay cantidad explícita, usa 1.
- Si ves "2 LIMONADA 59.00" es cantidad 2, precio 59.00 c/u.
- Devuelve SOLO JSON válido. Sin texto antes ni después.
- Si un precio parece total de la cuenta, NO lo pongas como producto.

Formato:
[
  {"producto": "Nombre", "cantidad": 1, "precio": 59.00}
]

Ticket:
${textoOCR}
  `.trim();

  try{
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.15,
        response_format: { type: "json_object" } // nos aseguramos JSON
      })
    });

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content || "{}";
    // Como pedimos json_object, viene tipo { "items": [...] }
    let parsed = {};
    try{ parsed = JSON.parse(raw); }catch(e){ return []; }

    // Aceptamos 2 formatos:
    // a) { "items": [...] }
    // b) [ ... ]
    let itemsIA = [];
    if (Array.isArray(parsed)) {
      itemsIA = parsed;
    } else if (Array.isArray(parsed.items)) {
      itemsIA = parsed.items;
    }

    // Normalizamos
    itemsIA = itemsIA.map(it => ({
      name: it.producto || it.name || it.descripcion || 'Producto',
      qty: Number(it.cantidad || it.qty || 1),
      price: Number(it.precio || it.price || 0)
    })).filter(x => x.name && x.qty>0);

    note(`IA devolvió ${itemsIA.length} productos`);
    return itemsIA;
  }catch(e){
    console.error('Error llamando a OpenAI:', e);
    note('IA falló, usando parser clásico');
    return [];
  }
}

/* =========================================================
   9. Proceso principal
   ========================================================= */
async function processTicket(file){
  // 1) preprocesa
  const pre = await preprocess(file);

  // 2) OCR completo + zona inferior
  const h = pre.height, w = pre.width;
  const y0 = Math.max(0, Math.floor(h*0.58));
  const bot = document.createElement('canvas');
  bot.width = w; bot.height = h - y0;
  bot.getContext('2d').drawImage(pre, 0, y0, w, h-y0, 0, 0, w, h-y0);

  const [totals, full] = await Promise.all([
    ocrCanvas(bot,  { psm: 6 }),
    ocrCanvas(pre,  { psm: 4 }),
  ]);

  const fullText  = (full.text  || '').trim();
  const totalText = (totals.text|| '').trim();

  // 3) parser clásico
  const lines = splitLines(fullText);
  const win   = findProductsWindow(lines);
  const itemsClasico = parseItems(lines, win);

  // 4) total clásico
  const mergedLines = lines.concat(splitLines(totalText));
  let total = detectGrandTotal(mergedLines);
  if (total==null && itemsClasico.length){
    total = +(itemsClasico.reduce((a,it)=> a + (it.price||0)*(it.qty||1), 0).toFixed(2));
    note(`Total por suma de items (clásico): ${total}`);
  }

  const folio = extractFolio5(lines);
  const fecha = toISODateFromText(fullText);

  // 5) IA para mejorar productos
  const itemsIA = await identificarProductosConIA(fullText);

  // 6) Elegimos mejor lista:
  //    - si IA detectó al menos 1 → usamos IA
  //    - si no, lo clásico
  const finalItems = (itemsIA && itemsIA.length) ? itemsIA : itemsClasico;

  // 7) Depurar
  dump();

  return {
    folio,
    fecha,
    total,
    items: finalItems,
    ocrText: fullText
  };
}

/* =========================================================
   10. Integración con tu botón
   ========================================================= */
async function onClickProcesar(){
  const input = document.getElementById('ticketFile') || document.getElementById('ticketImage');
  const file  = input?.files?.[0];
  if (!file){ alert('Sube o toma una foto del ticket primero.'); return; }

  const statusEl = document.getElementById('ocrStatus');
  if (statusEl){ statusEl.textContent = '🕐 Escaneando ticket…'; }

  try{
    DBG.notes = []; DBG.lines = [];
    const res = await processTicket(file);

    // Rellenar UI
    const iNum   = document.getElementById('inputTicketNumero');
    const iFecha = document.getElementById('inputTicketFecha');
    const iTotal = document.getElementById('inputTicketTotal');

    if (iNum)   iNum.value   = (res.folio && /^\d{5}$/.test(res.folio)) ? res.folio : '';
    if (iFecha) iFecha.value = res.fecha || '';
    if (iTotal) { iTotal.value = res.total!=null ? res.total.toFixed(2) : ''; iTotal.disabled = false; }

    // Disparar a registrar.js
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
    if (statusEl) statusEl.textContent = '❌ No pude leer el ticket. Intenta con mejor iluminación.';
    alert('No se pudo leer el ticket. Prueba con más luz, sin sombras y más recto.');
  }
}

document.getElementById('btnProcesarTicket')?.addEventListener('click', onClickProcesar);
