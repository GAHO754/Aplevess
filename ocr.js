/* ====== Helpers ====== */
function normalize(s){
  return String(s||'')
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")    // quita acentos
    .replace(/[^\w$%#./,:\- \t\n]/g,' ')               // limpia raro pero deja símbolos útiles
    .replace(/\s+/g,' ')
    .trim();
}

// Normaliza precios MX: "1,234.50" -> 1234.50 | "1.234,50" -> 1234.50 | "169" -> 169.00
function parsePrice(raw){
  if(!raw) return null;
  let s = String(raw).replace(/[^\d.,]/g,'').trim();
  if(!s) return null;
  // Si hay coma y punto: el último separador suele ser decimales
  if(s.includes(',') && s.includes('.')){
    if(s.lastIndexOf('.') > s.lastIndexOf(',')){
      s = s.replace(/,/g,'');            // 1,234.56 -> 1234.56
    } else {
      s = s.replace(/\./g,'').replace(',', '.'); // 1.234,56 -> 1234.56
    }
  } else if(s.includes(',')){
    // Asumir coma decimal si hay 1 coma y 2 decimales
    const m = s.match(/,\d{2}$/);
    s = m ? s.replace(',', '.') : s.replace(/,/g,'');
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? +(n.toFixed(2)) : null;
}

// Intenta mapear un nombre libre a un producto canónico según PRODUCT_LEXICON
function canonicalProductName(freeText){
  const txt = ' ' + normalize(freeText) + ' ';
  for (const [canon, syns] of Object.entries(PRODUCT_LEXICON)){
    for(const kw of syns){
      const k = ' ' + normalize(kw) + ' ';
      if(txt.includes(k)) return canon;
    }
  }
  return null;
}

// Intenta extraer cantidad: "2 alitas", "alitas x2", "2x alitas", "alitas 10pz"
function extractQty(line, fallback=1){
  let qty = null;
  // prefijos: "2x ", "2 "
  let m = line.match(/(?:^|\s)(\d{1,2})\s*x?(?=\s*[a-z])/i);
  if(m) qty = parseInt(m[1],10);

  // sufijos cercanos al nombre: "x2", " 2pz", " 2 pzas", " 10 uds"
  if(qty==null){
    m = line.match(/(?:^|[^a-z0-9])x?\s*(\d{1,2})\s*(?:pz|pzas?|uds?|u|unidad(?:es)?|piezas?)\b/i);
    if(m) qty = parseInt(m[1],10);
  }
  // “10pz” pegado
  if(qty==null){
    m = line.match(/(\d{1,2})\s*(?:pz|pzas?|uds?|u|unidad(?:es)?|piezas?)\b/i);
    if(m) qty = parseInt(m[1],10);
  }
  return qty ?? fallback;
}

// Intenta extraer precio al final de línea
function extractLinePrice(line){
  const m = line.match(/(?:\$|\s)\s*([0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2})?)\s*$/);
  return m ? parsePrice(m[1]) : null;
}

// Parseo de renglones de detalle: detecta {qty, name, unitPrice?, linePrice?}
function parseItemsFromLines(lines){
  const items = [];
  for(let raw of lines){
    if(!raw) continue;
    const l = raw.trim();

    // ignora líneas de totales/impuestos
    if(/subtotal|propina|servicio|iva|impuesto|total|cambio|pago|efectivo|tarjeta|metodo|método|metodo de pago/i.test(l)) continue;

    const price = extractLinePrice(l);
    // quita el precio del texto para analizar el nombre
    const namePart = price!=null ? l.replace(/([^\d]|^)\$?\s*[0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,]\d{2})\s*$/,'').trim() : l;

    const qty = extractQty(namePart, 1);

    // limpia prefijos tipo "2x", "x2", "2 "
    const cleanedName = namePart
      .replace(/(?:^|\s)\d{1,2}\s*x?(?=\s*[a-z])/i,' ')
      .replace(/(?:^|[^a-z0-9])x\s*\d{1,2}\b/i,' ')
      .replace(/\b\d{1,2}\s*(?:pz|pzas?|uds?|u|unidad(?:es)?|piezas?)\b/i,' ')
      .replace(/\s{2,}/g,' ')
      .trim();

    // canónico según lexicón
    const canon = canonicalProductName(cleanedName);

    if(canon){
      items.push({
        name: canon,
        qty,
        linePrice: price ?? null
      });
    }
  }

  // Compacta por nombre
  const compact = [];
  for(const it of items){
    const i = compact.findIndex(x=>x.name===it.name);
    if(i>=0){
      compact[i].qty += it.qty;
      if(it.linePrice!=null) compact[i].linePrice = (compact[i].linePrice??0) + it.linePrice;
    }else{
      compact.push({...it});
    }
  }
  return compact;
}

function splitLinesForReceipt(text){
  // divide por saltos y espacios grandes; también tabs
  const arr = text.split(/\n|\t|(?<=\d)\s{2,}(?=\D)/g)
    .map(s=>s.trim())
    .filter(Boolean);
  return arr;
}

function parseTicketText(text){
  const raw = String(text||'');
  const clean = normalize(raw);
  const lines = splitLinesForReceipt(raw); // usa “raw” para no perder mayúsculas/diacríticos en OCR

  // ===== número de orden/folio =====
  let numero = null;
  const idRX = [
    /(?:orden|order|folio|ticket|tkt|transac(?:cion)?|venta|nota|id|no\.?)\s*(?:#|:)?\s*([a-z0-9\-]{3,})/i,
    /(?:ord\.?|ordnum)\s*(?:#|:)?\s*([a-z0-9\-]{3,})/i
  ];
  for(const rx of idRX){
    const m = raw.match(rx) || clean.match(rx);
    if(m){ numero = m[1].toUpperCase(); break; }
  }
  // fallback: números tipo “Orden # 123-456”
  if(!numero){
    const m = raw.match(/(?:orden|order)\s*(?:#|:)?\s*([A-Za-z0-9\-]+)/i);
    if(m) numero = m[1].toUpperCase();
  }

  // ===== fecha (dd/mm/aaaa, mm-dd-aaaa, etc.) =====
  let fechaISO = null;
  const fm = clean.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](20\d{2})/);
  if(fm){
    let d = +fm[1], m = +fm[2], y = +fm[3];
    if (d<=12 && m>12) [d,m] = [m,d]; // corrige mm/dd vs dd/mm
    fechaISO = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  }

  // ===== total =====
  let total = null;
  // Busca líneas con palabra TOTAL (descarta subtotal/iva/propina)
  const totalMatches = [...raw.matchAll(/^(?=.*total)(?!.*sub)(?!.*iva)(?!.*propina)(?!.*servicio).*?([$\s]*[0-9][0-9.,]*)\s*$/gmi)];
  if(totalMatches.length){
    total = parsePrice(totalMatches[totalMatches.length-1][1]);
  }
  if(total==null){
    // fallback: el mayor importe no etiquetado como iva/propina/subtotal
    const amounts = [];
    for(const ln of raw.split('\n')){
      if(/subtotal|propina|servicio|iva/i.test(ln)) continue;
      const mm = ln.match(/([$\s]*[0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,]\d{2})|[0-9]+(?:[.,]\d{2}))/g);
      if(mm){
        mm.forEach(v=>{
          const p = parsePrice(v);
          if(p!=null) amounts.push(p);
        });
      }
    }
    if(amounts.length) total = Math.max(...amounts);
  }

  // ===== productos =====
  const productosDetectados = parseItemsFromLines(lines);

  return { numero, fecha: fechaISO, total: total!=null ? total.toFixed(2) : null, productosDetectados };
}

/* ====== OCR mejorado para tickets ====== */
async function recognizeImageToText(file){
  const img = await createImageBitmap(file);
  // Escala objetivo ~1800-2200 px de alto (mejora OCR de texto termoimpreso)
  const targetH = 2000;
  const scale = Math.max(1, Math.min(2.4, targetH / img.height));
  const c = Object.assign(document.createElement('canvas'), {
    width:  Math.round(img.width * scale),
    height: Math.round(img.height * scale)
  });
  const ctx = c.getContext('2d');

  // Filtros suaves: grises + leve sharpen
  ctx.filter = 'grayscale(1) contrast(1.18) brightness(1.06)';
  ctx.drawImage(img, 0, 0, c.width, c.height);

  // (Opcional) umbral simple
  // const imgData = ctx.getImageData(0,0,c.width,c.height);
  // ... (se podría binarizar, pero con contrast ya suele bastar)
  // ctx.putImageData(imgData,0,0);

  const blob = await new Promise(res=>c.toBlob(res, 'image/jpeg', 0.95));

  const { data:{ text } } = await Tesseract.recognize(blob, 'spa+eng', {
    logger: m => console.log(m),
    tessedit_pageseg_mode: 6,
    preserve_interword_spaces: '1',
    user_defined_dpi: '300',
    // Reducimos confusiones: preferimos dígitos, letras y separadores comunes de tickets
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-:#/$., ',
  });
  return text;
}

/* ====== FUNCIÓN PRINCIPAL ====== */
async function leerTicket(){
  const input = document.getElementById("ticketImage") || document.getElementById("ticketFile");
  const file  = input?.files?.[0];
  if (!file) return alert("Selecciona una imagen");

  const statusEl = document.getElementById("ocrResult");
  if (statusEl){ statusEl.textContent = "🕐 Escaneando ticket…"; statusEl.classList?.add('loading-dots'); }

  try{
    const text = await recognizeImageToText(file);
    if (statusEl){ statusEl.classList?.remove('loading-dots'); statusEl.textContent = text; }

    const user = auth.currentUser;
    if (!user) return alert("Debes iniciar sesión");

    const { numero, fecha, total, productosDetectados } = parseTicketText(text);

    // Rellena inputs si existen
    const iNum   = document.getElementById('inputTicketNumero');
    const iFecha = document.getElementById('inputTicketFecha');
    const iTotal = document.getElementById('inputTicketTotal');
    if (iNum && numero)   iNum.value   = numero;
    if (iFecha && fecha)  iFecha.value = fecha;
    if (iTotal && total)  iTotal.value = parseFloat(total).toFixed(2);

    // Puntos
    let totalPts = 0;
    const detalle = productosDetectados.map(p=>{
      const pu  = POINTS_MAP[p.name] || 0;
      const sub = pu * p.qty;
      totalPts += sub;
      return { producto: p.name, cantidad: p.qty, puntos_unitarios: pu, puntos_subtotal: sub };
    });

    // Duplicado por número (si lo hallamos)
    const ticketsRef = db.collection('users').doc(user.uid).collection('tickets');
    if (numero){
      const dup = await ticketsRef.where('numero','==',numero).limit(1).get();
      if (!dup.empty) return alert("❌ Este ticket ya fue escaneado.");
    }

    // Límite 3 al día
    const start = new Date(); start.setHours(0,0,0,0);
    const end   = new Date(); end.setHours(23,59,59,999);
    const daySnap = await ticketsRef
      .where('createdAt','>=',firebase.firestore.Timestamp.fromDate(start))
      .where('createdAt','<=',firebase.firestore.Timestamp.fromDate(end))
      .get();
    if (daySnap.size >= 3) return alert("⚠️ Ya escaneaste 3 tickets hoy.");

    // Fechas
    const fechaDate = fecha ? new Date(`${fecha}T00:00:00`) : new Date();
    const vence     = new Date(fechaDate); vence.setMonth(vence.getMonth()+6);

    // Guarda
    await ticketsRef.add({
      numero: numero || "SIN-ID",
      fecha: firebase.firestore.Timestamp.fromDate(fechaDate),
      total: total ? parseFloat(total) : 0,
      productos: productosDetectados.map(p => ({
        nombre: p.name,
        cantidad: p.qty,
        // opcional: guarda precios por línea si los detectó
        precioLinea: p.linePrice ?? null
      })),
      puntos: { total: totalPts, detalle },
      vencePuntos: firebase.firestore.Timestamp.fromDate(vence),
      textoOCR: text,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    alert(`✅ Ticket guardado. Puntos ganados: ${totalPts}`);
  } catch(e){
    console.error(e);
    if (statusEl){ statusEl.classList?.remove('loading-dots'); statusEl.textContent = "❌ Error al leer el ticket."; }
    alert("No pude leer el ticket. Intenta con más luz, sin sombras y lo más recto posible.");
  }
}

document.getElementById('btnProcesarTicket')?.addEventListener('click', leerTicket);
