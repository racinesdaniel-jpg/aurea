/* Texto completo de las cápsulas: vive en Firestore (capsulas/{id}) y solo lo puede leer quien tiene la prueba
   vigente o una suscripción activa (ver firestore.rules). La app solo trae títulos y datos generales.
   El administrador publica el contenido desde Administración (se hace solo al entrar si cambió la versión). */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getFirestore } = require("firebase-admin/firestore");

const ADMINS = ["racinesdaniel@gmail.com"];
const db = () => getFirestore();

exports.cargarCapsulas = onCall({ region: "us-central1", maxInstances: 2, timeoutSeconds: 60, memory: "256MiB" }, async (req) => {
  const t = req.auth && req.auth.token;
  if (!t || !t.email_verified || !ADMINS.includes(String(t.email || "").toLowerCase())) {
    throw new HttpsError("permission-denied", "Solo el administrador puede hacer esto.");
  }
  const { v, caps } = require("./capsulas.json");
  const ids = Object.keys(caps);
  const b = db().batch();
  for (const id of ids) b.set(db().doc("capsulas/" + id), { es: caps[id].es, en: caps[id].en, v, updatedAt: Date.now() });
  b.set(db().doc("admin/capsulas"), { v, n: ids.length, updatedAt: Date.now() });
  await b.commit();
  return { v, n: ids.length };
});
