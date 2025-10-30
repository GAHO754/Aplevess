/* =========================================================
   ocr.js — OCR + IA (OpenAI) + Filtros Applebee’s
   =========================================================
   Flujo:
   1. Tomamos la imagen (file input o cámara)
   2. Preprocesamos (escala + contraste + opcional OpenCV)
   3. Tesseract saca el TEXTO
   4. (IA) Le pedimos a OpenAI que nos regrese JSON limpio
   5. Si IA falla → parser local
   6. Mandamos los productos a registrar.js con `ocr:productos`
   ========================================================= */

/* ================= Depuración ================= */
const DBG = { lines: [], notes: [] };
function dbgNote(s) { try { DBG.notes.push(String(s)); } catch {} }
function dbgDump() {
  const el = document.getElementById("ocrDebug");
  if (!el) return;
  el.textContent =
    "[NOTAS]\n" + DBG.notes.join("\n") +
    "\n\n[LINEAS]\n" + DBG.lines.map((s, i) => `${String(i).padStart(2, "0")}: ${s}`).join("\n");
}

/* ==================================================
   1. Config IA
   ================================================== */
/**
 * ⚠️ NO SUBAS TU API KEY A GITHUB
 * Para probar localmente puedes pegarla aquí
 * y luego borrarla antes de subir.
 *
 * Opciones para producción:
 * - window.OPENAI_API_KEY = "sk-xxxxx" (inyectado por otro script que NO está en el repo)
 * - Llamar a tu propio endpoint /api/ai-ocr que tenga la key
 */
const OPENAI_API_KEY = window.OPENAI_API_KEY || ""; // <--- BORRAR ANTES DE SUBIR
// Si vas a usar endpoint propio, ponlo aquí (si esto está, se usa este en vez del fetch directo a OpenAI)
const OPENAI_PROXY_ENDPOINT = window.OPENAI_PROXY_ENDPOINT || ""; // ej. "https://tu-funcion.vercel.app/api/ocr"

/* ==================================================
   2. Utilidades base
   ================================================== */
function fixOcrDigits(s) {
  return s
    .replace(/(?<=\d)[Oo](?=\d)/g, "0")
    .replace(/(?<=\d)S(?=\d)/g, "5")
    .replace(/(?<=\d)[lI](?=\d)/g, "1");
}

function splitLines(text) {
  const arr = String(text || "")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((s) => fixOcrDigits(s.replace(/\s{2,}/g, " ").trim()))
    .filter(Boolean);
  DBG.lines = arr.slice();
  return arr;
}

function normalizeNum(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/[^\d.,-]/g, "").trim();
  if (!s) return null;
  if (s.includes(",") && s.includes(".")) {
    if (s.lastIndexOf(".") > s.lastIndexOf(",")) s = s.replace(/,/g, "");
    else s = s.replace(/\./g, "").replace(",", ".");
  } else if (s.includes(",")) {
    const m = s.match(/,\d{2}$/);
    s = m ? s.replace(",", ".") : s.replace(/,/g, "");
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? +n.toFixed(2) : null;
}

function endsWithPrice(line) {
  const m = line.match(/(?:\$?\s*)([0-9]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))\s*$/);
  if (!m) return null;
  const price = normalizeNum(m[1]);
  if (price == null) return null;
  const namePart = line.replace(m[0], "").trim();
  return { namePart, price };
}

/* ==================================================
   3. Listas para filtrar líneas NO-producto
   ================================================== */
const NOT_PRODUCT_RX = new RegExp(
  [
    // datos fiscales / leyendas
    "regimen fiscal",
    "r.f.c", "rfc", "iva", "impt\\.?", "impuesto", "subtotal", "sub-?total",
    "forma de pago", "metodo de pago", "cambio", "saldo", "total", "visa", "master", "amex",
    "propina", "service", "servicio",
    // encabezados / dirección
    "av\\.", "avenida", "calle", "col\\.", "colonia", "cp\\s*\\d{5}", "chihuahua", "cd juarez",
    // operativos
    "mesero", "mesa", "clientes?", "reimpresion", "reimpresi[oó]n", "no\\.", "nota", "orden", "ticket",
    // despedidas
    "gracias por su visita", "gracias por tu visita", "vuelva pronto",
    // timbres
    "folio fiscal", "cfd[ii]", "sello", "cadena original"
  ].join("|"),
  "i"
);

// a veces OCR mete pedazos raros
const CODEY_RX = /^(?:[>-]{1,3}\s*)?[A-Z]{2,6}\d{2,6}[A-Z0-9\-]*$/;

/* ==================================================
   4. Detección de ventana de productos (local)
   ================================================== */
function looksLikeFoodOrDrink(nameRaw) {
  if (!nameRaw) return false;
  const n = nameRaw.toLowerCase();
  if (NOT_PRODUCT_RX.test(n)) return false;
  // palabras que sí queremos
  const OK = [
    // bebidas
    "limonada", "mojito", "margarita", "martini", "paloma", "piña colada", "pina colada",
    "coca", "pepsi", "refresco", "agua", "jugo", "iced tea", "te shake", "shake",
    // platillos
    "burger", "hamburguesa", "chicken", "pollo", "salad", "ensalada",
    "tacos", "sirloin", "arrachera", "buffalo", "salmon", "pasta", "fajita",
    // entradas
    "boneless", "alitas", "wings", "nachos", "dip", "sampler", "quesadilla",
    // postres
    "brownie", "cheesecake", "postre", "dessert", "helado"
  ];
  if (OK.some((w) => n.includes(w))) return true;
  // si tiene letras y no es fiscal ni mesa ni reimpresión, lo dejamos pasar
  return /[a-záéíóúñ]/i.test(n) && n.length >= 3 && !CODEY_RX.test(n);
}

function findProductsWindow(lines) {
  const start = lines.findIndex((l) => {
    const end = endsWithPrice(l);
    if (!end) return false;
    const left = end.namePart;
    if (!/[a-z]/i.test(left)) return false;
    if (!looksLikeFoodOrDrink(left)) return false;
    return true;
  });
  if (start < 0) return { start: -1, end: -1 };

  let end = start;
  for (let i = start; i < lines.length; i++) {
    const l = lines[i].toLowerCase();
    if (/sub-?total|iva|impuesto|^total\s*:?\s*$/i.test(l)) {
      end = i - 1;
      break;
    }
    end = i;
  }
  dbgNote(`Ventana productos ${start}..${end}`);
  return { start, end };
}

function parseItemsLocal(lines, win) {
  if (win.start < 0 || win.end < 0 || win.end < win.start) return [];

  const out = [];
  const pushItem = (name, price) => {
    if (!name || price == null || price <= 0) return;
    name = name
      .replace(/(?:^|\s)(?:x\s*)?\d{1,2}(?:\s*[x×])?(?:\s|$)/gi, " ")
      .replace(/\s{2,}/g, " ")
      .replace(/[.:,-]\s*$/, "")
      .trim();
    if (!looksLikeFoodOrDrink(name)) {
      dbgNote(`Descartado (no-food): "${name}"`);
      return;
    }
    out.push({ name, qty: 1, price });
  };

  for (let i = win.start; i <= win.end; i++) {
    const l = lines[i];
    if (NOT_PRODUCT_RX.test(l)) continue;
    const end = endsWithPrice(l);
    if (!end) continue;
    pushItem(end.namePart, end.price);
  }

  // compactar
  const comp = [];
  out.forEach((it) => {
    const j = comp.findIndex((x) => x.name.toLowerCase() === it.name.toLowerCase());
    if (j >= 0) {
      comp[j].qty += it.qty;
      comp[j].price = +(comp[j].price + it.price).toFixed(2);
    } else comp.push({ ...it });
  });

  dbgNote(`Items locales: ${comp.length}`);
  return comp;
}

/* ==================================================
   5. Total y folio locales
   ================================================== */
function detectGrandTotal(lines) {
  const isCard = (s) => /\b(visa|master|amex|tarjeta|card)\b/i.test(s);
  // 1) después de propina
  let propIdx = -1;
  for (let i = 0; i < lines.length; i++)
    if (/propina|servicio|service/i.test(lines[i])) propIdx = i;
  if (propIdx >= 0) {
    for (let j = lines.length - 1; j > propIdx; j--) {
      const l = lines[j];
      if (/\btotal\b/i.test(l) && !/sub|iva|imp\.?t|impt|impuesto/i.test(l) && !isCard(l)) {
        const mm = l.match(/([$\s]*[0-9]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))/g);
        if (mm && mm.length) {
          const v = normalizeNum(mm[mm.length - 1]);
          if (v != null) {
            dbgNote(`Total (propina): ${v}`);
            return v;
          }
        }
      }
    }
  }
  // 2) último total
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (/\btotal\b/i.test(l) && !/sub|iva|imp\.?t|impt|impuesto/i.test(l) && !isCard(l)) {
      const mm = l.match(/([$\s]*[0-9]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))/g);
      if (mm && mm.length) {
        const v = normalizeNum(mm[mm.length - 1]);
        if (v != null) {
          dbgNote(`Total (último): ${v}`);
          return v;
        }
      }
    }
  }
  // 3) máximo importe
  const nums = [];
  lines.forEach((l) => {
    if (isCard(l)) return;
    const mm = l.match(/([$\s]*[0-9]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))/g);
    if (mm) mm.forEach((v) => { const p = normalizeNum(v); if (p != null) nums.push(p); });
  });
  if (nums.length) {
    const t = Math.max(...nums);
    dbgNote(`Total (máximo): ${t}`);
    return t;
  }
  dbgNote("Total no encontrado");
  return null;
}

function extractFolio5(lines) {
  // buscamos 5 dígitos cerca de mesero/fecha/hora
  const isDate = (s) => /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](20\d{2})/.test(s);
  const isTime = (s) => /(\d{1,2}):(\d{2})\s*(am|pm)?/i.test(s);
  const iD = lines.findIndex(isDate);
  const iT = lines.findIndex(isTime);
  const iM = lines.findIndex((s) => /\bmesero\b|\bmesa\b|\bclientes?\b/i.test(s));
  const anchor = (iD >= 0 || iT >= 0) ? Math.max(iD, iT) : -1;
  const from = Math.max(iM >= 0 ? iM : 0, anchor >= 0 ? anchor : 0);
  const to = Math.min(lines.length - 1, from + 6);
  const pick5 = (s) => {
    if (/cp\s*\d{5}/i.test(s)) return null;
    const m = s.match(/\b(\d{5})\b/g);
    return m ? m[m.length - 1] : null;
  };
  for (let i = from; i <= to; i++) {
    const c = pick5(lines[i]);
    if (c) { dbgNote(`Folio detectado @${i}: ${c}`); return c; }
  }
  dbgNote("Folio no encontrado");
  return null;
}

function extractDateISO(text) {
  const m = String(text || "").match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](20\d{2})/);
  if (!m) return "";
  let d = +m[1], mo = +m[2], y = +m[3];
  if (d <= 12 && mo > 12) [d, mo] = [mo, d];
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/* ==================================================
   6. PREPROCESADO IMAGEN
   ================================================== */
async function preprocessImage(file) {
  const bmp = await createImageBitmap(file);
  const targetH = 2400;
  const scale = Math.max(1, Math.min(3, targetH / bmp.height));
  const c = Object.assign(document.createElement("canvas"), {
    width: Math.round(bmp.width * scale),
    height: Math.round(bmp.height * scale),
  });
  const ctx = c.getContext("2d");
  ctx.filter = "grayscale(1) contrast(1.25) brightness(1.05)";
  ctx.drawImage(bmp, 0, 0, c.width, c.height);

  // si hay OpenCV, lo mejoramos tantito
  if (typeof cv !== "undefined" && cv?.Mat) {
    try {
      let src = cv.imread(c);
      let gray = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
      let bw = new cv.Mat();
      cv.adaptiveThreshold(gray, bw, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY, 35, 10);
      cv.imshow(c, bw);
      src.delete(); gray.delete(); bw.delete();
    } catch (e) {
      console.warn("OpenCV preprocess falló:", e);
    }
  }

  return c;
}

/* ==================================================
   7. Tesseract
   ================================================== */
async function runTesseract(canvas) {
  const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.96));
  const { data } = await Tesseract.recognize(blob, "spa+eng", {
    tessedit_pageseg_mode: "4",
    preserve_interword_spaces: "1",
    user_defined_dpi: "320",
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-:#/$., ",
  });
  return data.text || "";
}

/* ==================================================
   8. IA con OpenAI
   ================================================== */
async function callOpenAI(rawText) {
  // si no hay key ni proxy, no hacemos nada
  if (!OPENAI_API_KEY && !OPENAI_PROXY_ENDPOINT) {
    throw new Error("No hay API KEY ni proxy configurado");
  }

  // prompt muy dirigido
  const sys = `Eres un parser de tickets de restaurante Applebee's de México.
Tu trabajo es leer TEXTO OCR desordenado y devolver solo lo que pide el sistema.
Regresa SIEMPRE JSON válido con esta forma:
{
  "folio": "50037",
  "fecha": "2025-09-24",
  "total": 716.00,
  "items": [
    { "name": "Morita Mezcal", "qty": 1, "price": 149.00 },
    { "name": "Te Shake", "qty": 1, "price": 49.00 },
    { "name": "Buffalo Salad", "qty": 1, "price": 259.00 },
    { "name": "Tacos de Sirloin", "qty": 1, "price": 259.00 }
  ]
}
Reglas:
- "items" SOLO pueden ser comidas, platillos, bebidas o postres. NO pongas "Régimen Fiscal", "Gracias por su visita", "Reimpresión", "Clientes", "Mesa", "IVA", "Subtotal", "Impt. Total", "VISA", "Tarjeta", "Propina".
- Si ves cosas raras que no son comida, NO las pongas.
- El folio es casi siempre un número de 5 dígitos cerca de "Mesero", "Clientes", "Mesa" o la hora.
- La fecha viene como dd/mm/aaaa. Devuélvela como aaaa-mm-dd.
- El total es el TOTAL de consumo, no la tarjeta. Si hay dos totales, prefiere el que está en la sección principal.`;
  const user = `TEXTO OCR:\n${rawText}\n\nDevuélveme SOLO el JSON, sin explicación.`;

  // 1) si hay proxy configurado
  if (OPENAI_PROXY_ENDPOINT) {
    const resp = await fetch(OPENAI_PROXY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: rawText })
    });
    if (!resp.ok) throw new Error("Proxy IA respondió error");
    return await resp.json();
  }

  // 2) llamada directa a OpenAI
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini", // puedes cambiar al que quieras
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user }
      ],
      temperature: 0.1,
      response_format: { type: "json_object" }
    })
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error("OpenAI error: " + txt);
  }

  const data = await resp.json();
  // el JSON ya viene en data.choices[0].message.content
  const content = data.choices?.[0]?.message?.content || "{}";
  return JSON.parse(content);
}

/* ==================================================
   9. Proceso principal
   ================================================== */
async function processTicketWithIA(file) {
  const statusEl = document.getElementById("ocrStatus");
  if (statusEl) {
    statusEl.textContent = "🕐 Escaneando ticket…";
    statusEl.className = "validacion-msg";
  }

  try {
    DBG.notes = [];
    DBG.lines = [];

    // 1) preprocesar imagen
    const canvas = await preprocessImage(file);

    // 2) OCR base
    const text = await runTesseract(canvas);
    dbgNote("OCR listo, longitud: " + text.length);

    // 3) intentar IA
    let result = null;
    try {
      result = await callOpenAI(text);
      dbgNote("IA respondió OK");
    } catch (iaErr) {
      console.warn("IA falló, usando parser local:", iaErr);
    }

    let folio = "";
    let fecha = "";
    let total = null;
    let items = [];

    if (result && typeof result === "object") {
      folio = result.folio || "";
      fecha = result.fecha || "";
      total = typeof result.total === "number" ? result.total : null;
      items = Array.isArray(result.items) ? result.items : [];
    }

    // 4) si IA no dio todo, completamos con parser local
    if (!folio || !fecha || !total || !items.length) {
      const lines = splitLines(text);
      const win = findProductsWindow(lines);
      const localItems = parseItemsLocal(lines, win);
      const localTotal = detectGrandTotal(lines);
      const localFolio = extractFolio5(lines);
      const localFecha = extractDateISO(text);

      if (!folio) folio = localFolio || "";
      if (!fecha) fecha = localFecha || "";
      if (!total) total = localTotal != null ? localTotal : null;
      if (!items.length) items = localItems;
    }

    // 5) filtrar una vez más por si IA nos deja algo feo
    const finalItems = (items || []).filter(it => {
      const n = String(it.name || "").toLowerCase();
      if (!n) return false;
      if (NOT_PRODUCT_RX.test(n)) return false;
      if (CODEY_RX.test(n)) return false;
      return true;
    });

    // 6) mandar a la UI
    const iNum = document.getElementById("inputTicketNumero");
    const iFecha = document.getElementById("inputTicketFecha");
    const iTotal = document.getElementById("inputTicketTotal");

    if (iNum) iNum.value = (folio && /^\d{5}$/.test(folio)) ? folio : (folio || "");
    if (iFecha && fecha) iFecha.value = fecha;
    if (iTotal && total != null) { iTotal.value = total.toFixed(2); iTotal.disabled = false; }

    // construir el formato que espera registrar.js
    const payload = finalItems.map(it => ({
      name: it.name,
      qty: it.qty || 1,
      price: typeof it.price === "number" ? it.price : null
    }));

    // avisar a registrar.js
    document.dispatchEvent(new CustomEvent("ocr:productos", { detail: payload }));

    if (statusEl) {
      statusEl.className = "validacion-msg ok";
      statusEl.textContent = "✓ Ticket procesado. Verifica y presiona “Registrar”.";
    }

    dbgDump();
  } catch (e) {
    console.error(e);
    const statusEl = document.getElementById("ocrStatus");
    if (statusEl) {
      statusEl.className = "validacion-msg err";
      statusEl.textContent = "❌ No pude leer el ticket. Intenta con mejor luz o que salga completo.";
    }
    alert("No se pudo leer el ticket. Vuelve a tomar la foto más cerca, recto y con buena luz.");
  }
}

/* ==================================================
   10. Bind al botón
   ================================================== */
document.getElementById("btnProcesarTicket")?.addEventListener("click", async () => {
  const inp = document.getElementById("ticketFile");
  const file = inp?.files?.[0];
  if (!file) {
    alert("Sube o toma una foto del ticket primero.");
    return;
  }
  await processTicketWithIA(file);
});
