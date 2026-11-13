/* Tráfico de la landing (analítica propia, sin cookies ni servicios externos).
   La landing envía a /api/t una vista por cada visita y un evento por cada clic en un botón o enlace.
   Se guardan solo contadores por hora (hora de Ecuador) en trafico/{AAAA-MM-DD}: nada que identifique a la persona.
   La ubicación es aproximada: la zona horaria del navegador (por ejemplo America/Guayaquil). */
const { onRequest } = require("firebase-functions/v2/https");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

const TZ = "America/Guayaquil";
const db = () => getFirestore();
const inc = FieldValue.increment(1);

function limpio(s, n) { return String(s == null ? "" : s).replace(/[^\p{L}\p{N} ·:.\-_/+]/gu, "").replace(/\s+/g, " ").trim().slice(0, n); }
function cuando(ms) {
  const d = new Date(ms);
  const dia = d.toLocaleDateString("en-CA", { timeZone: TZ });
  const hora = String(+d.toLocaleString("en-US", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }) % 24).padStart(2, "0");
  return { dia, hora };
}
/* Convierte un evento de la landing en los contadores que hay que sumar (o null si no es válido) */
function contadores(b, ms) {
  if (!b || typeof b !== "object") return null;
  const tipo = b.t === "c" ? "c" : b.t === "v" ? "v" : null;
  if (!tipo) return null;
  const { dia, hora } = cuando(ms);
  const h = {};
  if (tipo === "v") {
    h.v = inc;
    if (b.n === 1) h.u = inc;
    const z = limpio(b.tz, 40); if (/^[A-Za-z]+\/[A-Za-z_\-/]+$/.test(z)) h.z = { [z]: inc };
    const f = limpio(b.r, 60).toLowerCase(); h.f = { [f && /^[a-z0-9.-]+$/.test(f) ? f : "directo"]: inc };
    h.d = { [b.m === 1 ? "movil" : "computadora"]: inc };
    h.l = { [b.l === "en" ? "en" : "es"]: inc };
  } else {
    const etiqueta = limpio(b.b, 60);
    if (!etiqueta) return null;
    h.c = { [etiqueta]: inc };
    h.ct = inc;
  }
  return { dia, data: { h: { [hora]: h }, updatedAt: ms } };
}

exports.trafico = onRequest({ region: "us-central1", maxInstances: 3, timeoutSeconds: 10, memory: "256MiB", concurrency: 80 }, async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).send("");
  try {
    let b = req.body;
    if (typeof b === "string") { if (b.length > 1500) return res.status(413).send(""); b = JSON.parse(b); }
    else if (Buffer.isBuffer(b)) { if (b.length > 1500) return res.status(413).send(""); b = JSON.parse(b.toString("utf8")); }
    const ua = String(req.get("user-agent") || "");
    if (/bot|crawl|spider|slurp|preview|lighthouse|headless/i.test(ua)) return res.status(204).send("");
    const x = contadores(b, Date.now());
    if (x) await db().doc("trafico/" + x.dia).set(x.data, { merge: true });
  } catch (e) { /* un evento malformado no debe romper nada */ }
  res.status(204).send("");
});

exports._test = { contadores, cuando, limpio };
