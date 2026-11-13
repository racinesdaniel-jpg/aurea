/* Prueba gratuita calculada en el servidor.
   La fecha de fin vive en subs/{uid}.trialEnd, que la persona no puede escribir (solo el servidor y el administrador).
   Se calcula una sola vez desde la fecha real de creación de la cuenta en Firebase Authentication. */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

const DIA = 864e5;
const db = () => getFirestore();

/* Fin de la prueba para una cuenta creada en `creada` con `dias` de prueba.
   `offset` es el ajuste antiguo (dayOffset) que guardaba la app: solo se respeta como extensión (negativo) y hasta 60 días. */
function calcularFin(creada, dias, offset) {
  const extra = Math.min(60, Math.max(0, -(+offset || 0)));
  return creada + (Math.max(0, +dias || 0) + extra) * DIA;
}

async function finPrueba(uid) {
  const ref = db().doc("subs/" + uid);
  const s = (await ref.get()).data() || {};
  if (typeof s.trialEnd === "number") return s.trialEnd;
  const cfg = (await db().doc("settings/app").get()).data() || {};
  const dias = cfg.trialDays != null ? +cfg.trialDays : 15;
  let creada = Date.now();
  try { creada = Date.parse((await getAuth().getUser(uid)).metadata.creationTime) || creada; } catch (e) { /* sin acceso: desde hoy */ }
  let offset = 0;
  try { offset = JSON.parse(((await db().doc("users/" + uid).get()).data() || {}).state || "{}").dayOffset || 0; } catch (e) { offset = 0; }
  const fin = calcularFin(creada, dias, offset);
  await ref.set({ trialEnd: fin, updatedAt: Date.now() }, { merge: true });
  return fin;
}

/* La app pide la fecha de fin de su prueba (la crea la primera vez). */
exports.miPrueba = onCall({ region: "us-central1", maxInstances: 5, timeoutSeconds: 20, memory: "256MiB" }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  return { trialEnd: await finPrueba(req.auth.uid) };
});

exports.finPrueba = finPrueba;
exports._test = { calcularFin };
