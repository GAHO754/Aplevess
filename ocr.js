/* ===========================
   ocr.js — versión depurable
   =========================== */

/* ----- Depuración ----- */
const DBG = { lines: [], notes: [] };

function dbgNote(msg) {
  try { DBG.notes.push(String(msg)); } catch {}
}

function dbgDump() {
  const el = document.getElementById("ocrDebug");
  if (!el) return;
  el.style.display = "block";
  el.textContent =
    "[NOTAS]\n" +
    DBG.notes.join("\n") +
    "\n\n[LINEAS]\n" +
    DBG.lines.map((s, i) => `${String(i).padStart(2, "0")}: ${s}`).join("\n");
}

/* ----- utilidades base ----- */
function fixLine(s) {
  if (!s) return s;
  return s
    .replace(/(?<=\d)O(?=\d)/g, "0")
    .replace(/(?<=\d)S(?=\d)/g, "5")
    .replace(/(?<=\d)l(?=\d)/g, "1")
    .replace(/(?<=\d)I(?=\d)/g, "1");
}

function splitLines(text) {
  const arr = String(text || "")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((s) => fixLine(s.replace(/\s{2,}/g, " ").trim()))
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
  const m = line.match(
    /(?:\$?\s*)([0-9]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))\s*$/
  );
  if (!m) return null;
  const price = normalizeNum(m[1]);
  if (price == null) return null;
  const namePart = line.replace(m[0], "").trim();
  return { namePart, price };
}

function looksTextualName(s) {
  if (!s) return false;
  if (/^\d+([x×]\d+)?$/.test(s)) return false;
  const low = s.toLowerCase();
  if (
    /\b(sub-?total|subtotal|iva|impuesto|propina|servicio|service|descuento|cover|cupon|cambio|cancel|anulado|cliente|clientes|mesa|mesero|visa|master|amex|tarjeta|efectivo|cash|pago|payment|saldo|orden|order|nota|reimpres|autoriz)\b/.test(
      low
    )
  )
    return false;
  if (/\b(cp|c\.p\.|col|av|avenida|calle|domicilio)\b/i.test(low)) return false;
  return /[a-záéíóúñ]/i.test(s) && s.length >= 3;
}

/* ----- fecha ----- */
function toISODateFromText(text) {
  const m = String(text || "").match(
    /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](20\d{2})/
  );
  if (!m) return "";
  let d = +m[1],
    mo = +m[2],
    y = +m[3];
  if (d <= 12 && mo > 12) [d, mo] = [mo, d];
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/* ----- zona de productos ----- */
function findProductsWindow(lines) {
  const start = lines.findIndex((l) => {
    const end = endsWithPrice(l);
    if (!end) return false;
    const left = end.namePart;
    if (!/[a-z]/i.test(left)) return false;
    if (!looksTextualName(left)) return false;
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

function parseItems(lines, win) {
  if (win.start < 0 || win.end < 0 || win.end < win.start) return [];
  const out = [];

  function push(name, price) {
    if (!name || price == null || price <= 0) return;
    let qty = 1;
    const qm = name.match(
      /(?:^|\s)(?:x\s*)?(\d{1,2})(?:\s*[x×])?(?:\s|$)/i
    );
    if (qm) qty = Math.max(1, parseInt(qm[1], 10));
    name = name
      .replace(/(?:^|\s)(?:x\s*)?\d{1,2}(?:\s*[x×])?(?:\s|$)/gi, " ")
      .replace(/\s{2,}/g, " ")
      .replace(/[.:,-]\s*$/, "")
      .trim();
    if (!looksTextualName(name)) {
      dbgNote(`Descartado no-item: "${name}"`);
      return;
    }
    out.push({ name, qty, price });
  }

  for (let i = win.start; i <= win.end; i++) {
    const l = lines[i];
    const end = endsWithPrice(l);
    if (!end) continue;
    const left = end.namePart;
    if (!/[a-z]/i.test(left)) continue;
    push(left, end.price);
  }

  // compactar
  const comp = [];
  for (const it of out) {
    const j = comp.findIndex(
      (x) => x.name.toLowerCase() === it.name.toLowerCase()
    );
    if (j >= 0) {
      comp[j].qty += it.qty;
      comp[j].price = +(comp[j].price + it.price).toFixed(2);
    } else comp.push({ ...it });
  }
  dbgNote(`Items detectados: ${comp.length}`);
  return comp;
}

/* ----- total ----- */
function detectGrandTotal(lines) {
  const isCard = (s) => /\b(visa|master|amex|tarjeta|card)\b/i.test(s);

  // 1) después de propina
  let propIdx = -1;
  for (let i = 0; i < lines.length; i++)
    if (/propina|servicio|service/i.test(lines[i])) propIdx = i;
  if (propIdx >= 0) {
    for (let j = lines.length - 1; j > propIdx; j--) {
      const l = lines[j];
      if (
        /\btotal\b/i.test(l) &&
        !/sub|iva|imp\.?t|impt|impuesto/i.test(l) &&
        !isCard(l)
      ) {
        const mm = l.match(
          /([$\s]*[0-9]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))/g
        );
        if (mm && mm.length) {
          const v = normalizeNum(mm[mm.length - 1]);
          if (v != null) {
            dbgNote(`Total tras propina: ${v}`);
            return v;
          }
        }
      }
    }
  }

  // 2) último TOTAL
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (
      /\btotal\b/i.test(l) &&
      !/sub|iva|imp\.?t|impt|impuesto/i.test(l) &&
      !isCard(l)
    ) {
      const mm = l.match(
        /([$\s]*[0-9]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))/g
      );
      if (mm && mm.length) {
        const v = normalizeNum(mm[mm.length - 1]);
        if (v != null) {
          dbgNote(`Total por último TOTAL: ${v}`);
          return v;
        }
      }
    }
  }

  // 3) subtotal + propina
  let sub = null,
    tip = null;
  for (const l of lines) {
    if (/sub-?total|subtotal/i.test(l)) {
      const mm = l.match(
        /([$\s]*[0-9]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))/g
      );
      if (mm) sub = normalizeNum(mm[mm.length - 1]);
    } else if (/propina|servicio|service/i.test(l)) {
      const mm = l.match(
        /([$\s]*[0-9]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))/g
      );
      if (mm) tip = normalizeNum(mm[mm.length - 1]);
    }
  }
  if (sub != null && tip != null) {
    const t = +(sub + tip).toFixed(2);
    dbgNote(`Total subtotal+propina: ${t}`);
    return t;
  }

  // 4) máximo importe
  const nums = [];
  lines.forEach((l) => {
    if (isCard(l)) return;
    const mm = l.match(
      /([$\s]*[0-9]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))/g
    );
    if (mm) mm.forEach((v) => {
      const p = normalizeNum(v);
      if (p != null) nums.push(p);
    });
  });
  if (nums.length) {
    const t = Math.max(...nums);
    dbgNote(`Total por máximo importe: ${t}`);
    return t;
  }

  dbgNote("Total no encontrado");
  return null;
}

/* ----- folio 5 dígitos ----- */
function findDateIdx(lines) {
  return lines.findIndex((s) =>
    /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](20\d{2})/.test(s)
  );
}
function findTimeIdx(lines) {
  return lines.findIndex((s) =>
    /(\d{1,2}):(\d{2})\s*(am|pm)?/i.test(s)
  );
}
function findMeseroIdx(lines) {
  const i = lines.findIndex((s) =>
    /\bmesero\b|\bmesa\b|\bclientes?\b/i.test(s)
  );
  return i >= 0 ? i : 0;
}

function extractFolio5(lines) {
  const iD = findDateIdx(lines);
  const iT = findTimeIdx(lines);
  const iM = findMeseroIdx(lines);
  const anchor = iD >= 0 || iT >= 0 ? Math.max(iD, iT) : -1;
  const from = Math.max(iM, anchor >= 0 ? anchor : iM);
  const to = Math.min(lines.length - 1, from + 5);
  const pick5 = (s) => {
    if (/cp\s*\d{5}/i.test(s)) return null;
    const m = s.match(/\b(\d{5})\b/g);
    return m ? m[m.length - 1] : null;
  };
  for (let i = from; i <= to; i++) {
    const c = pick5(lines[i]);
    if (c) {
      dbgNote(`Folio cerca de fecha/hora @${i}: ${c}`);
      return c;
    }
  }
  for (let i = iM; i < Math.min(lines.length, iM + 15); i++) {
    const s = lines[i];
    if (/\b(cp|col|av|calle)\b/i.test(s)) continue;
    const m = s.match(/\b(\d{5})\b/);
    if (m) {
      dbgNote(`Folio fallback @${i}: ${m[1]}`);
      return m[1];
    }
  }
  dbgNote("Folio no encontrado");
  return null;
}

/* ----- preprocesado imagen ----- */
async function preprocess(file) {
  const bmp = await createImageBitmap(file);
  const targetH = 2200;
  const scale = Math.max(1, Math.min(3, targetH / bmp.height));
  const c = Object.assign(document.createElement("canvas"), {
    width: Math.round(bmp.width * scale),
    height: Math.round(bmp.height * scale),
  });
  const ctx = c.getContext("2d");
  ctx.filter = "grayscale(1) contrast(1.2) brightness(1.05)";
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  return c;
}

/* ----- OCR con timeout ----- */
function tesseractWithTimeout(blob, ms = 25000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("OCR tardó demasiado")),
      ms
    );
    Tesseract.recognize(blob, "spa+eng", {
      tessedit_pageseg_mode: "4",
      preserve_interword_spaces: "1",
      user_defined_dpi: "320",
      tessedit_char_whitelist:
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-:#/$., ",
    })
      .then((r) => {
        clearTimeout(timer);
        resolve(r);
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}

/* ----- Proceso principal ----- */
async function processTicket(file) {
  // 1) preprocesa
  const canvas = await preprocess(file);
  const blob = await new Promise((res) =>
    canvas.toBlob(res, "image/jpeg", 0.96)
  );

  // 2) correr OCR
  const ocrRes = await tesseractWithTimeout(blob, 25000); // 25s máximo
  const fullText = (ocrRes?.data?.text || "").trim();
  dbgNote("OCR len=" + fullText.length);

  // 3) parsear
  const lines = splitLines(fullText);
  const win = findProductsWindow(lines);
  const items = parseItems(lines, win);

  let total = detectGrandTotal(lines);
  if (total == null && items.length) {
    total = +items
      .reduce((acc, it) => acc + (it.price || 0) * (it.qty || 1), 0)
      .toFixed(2);
    dbgNote("Total por suma de items: " + total);
  }

  const folio = extractFolio5(lines);
  const fecha = toISODateFromText(fullText);

  dbgDump();
  return { folio, fecha, total, items };
}

/* ----- Handler botón ----- */
async function onClickProcesar() {
  const input =
    document.getElementById("ticketFile") ||
    document.getElementById("ticketImage");
  const file = input?.files?.[0];
  const statusEl = document.getElementById("ocrStatus");
  if (!file) {
    alert("Sube o toma una foto del ticket primero.");
    if (statusEl)
      statusEl.textContent = "❌ Falta la imagen del ticket.";
    return;
  }

  if (statusEl) statusEl.textContent = "🕐 Escaneando ticket…";

  try {
    DBG.lines = [];
    DBG.notes = [];
    const res = await processTicket(file);

    // volcar en UI
    const iNum = document.getElementById("inputTicketNumero");
    const iFecha = document.getElementById("inputTicketFecha");
    const iTotal = document.getElementById("inputTicketTotal");

    if (iNum) iNum.value = res.folio && /^\d{5}$/.test(res.folio) ? res.folio : "";
    if (iFecha) iFecha.value = res.fecha || "";
    if (iTotal) {
      iTotal.value = res.total != null ? res.total.toFixed(2) : "";
      iTotal.disabled = false;
    }

    // mandar productos a registrar.js
    window.__ocrProductos = res.items || [];
    document.dispatchEvent(
      new CustomEvent("ocr:productos", {
        detail: window.__ocrProductos,
      })
    );

    if (statusEl) {
      const okFolio = res.folio && /^\d{5}$/.test(res.folio);
      const okItems = res.items && res.items.length > 0;
      const okTotal = res.total != null;
      statusEl.textContent =
        okFolio && okItems && okTotal
          ? "✓ Ticket procesado. Verifica y presiona “Registrar”."
          : `⚠️ Procesado. ${okFolio ? "" : "Folio no detectado. "} ${
              okItems ? "" : "No detecté productos claros. "
            } ${okTotal ? "" : "Total no encontrado. "}`.trim();
    }
  } catch (e) {
    console.error(e);
    if (statusEl)
      statusEl.textContent =
        "❌ No pude leer el ticket. Intenta con mejor iluminación y acercando el ticket.";
    alert("No se pudo leer el ticket. Prueba con más luz y foto recta.");
  }
}

document
  .getElementById("btnProcesarTicket")
  ?.addEventListener("click", onClickProcesar);
