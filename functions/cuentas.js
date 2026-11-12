/* Administración de cuentas: el administrador elimina por completo a un usuario (acceso de Firebase Authentication,
   perfil, diario, conversación con el Mentor IA y suscripción) para que el mismo correo pueda volver a registrarse.
   También encuentra y borra «accesos sin datos»: cuentas de Authentication cuyo perfil ya se había borrado antes. */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

const PAYPAL_SECRET = defineSecret("PAYPAL_SECRET");
const PAYPAL_CLIENT_ID = defineSecret("PAYPAL_CLIENT_ID");
// Debe coincidir con "admins" de firebase-config.js y con firestore.rules
const ADMINS = ["racinesdaniel@gmail.com"];
const db = () => getFirestore();

function soloAdmin(req) {
  const t = req.auth && req.auth.token;
  if (!t || !t.email_verified || !ADMINS.includes(String(t.email || "").toLowerCase())) {
    throw new HttpsError("permission-denied", "Solo el administrador puede hacer esto.");
  }
}
const esAdmin = (u) => ADMINS.includes(String(u.email || "").toLowerCase());

/* Si tenía una suscripción de PayPal activa, se cancela para que no se le vuelva a cobrar. */
async function cancelarPaypal(uid) {
  const s = (await db().doc("subs/" + uid).get()).data() || {};
  if (s.provider !== "paypal" || !s.paypalSub || s.paypalStatus !== "ACTIVE") return false;
  const pagos = require("./pagos");
  await pagos._pp("POST", "/v1/billing/subscriptions/" + encodeURIComponent(s.paypalSub) + "/cancel", { reason: "Cuenta eliminada por el administrador de Áurea" });
  return true;
}

async function borrar(uid) {
  let paypal = false;
  try { paypal = await cancelarPaypal(uid); } catch (e) { console.error("No se pudo cancelar PayPal de", uid, e.message); }
  await db().recursiveDelete(db().doc("users/" + uid)); // perfil + diario + privado + ia
  await db().doc("subs/" + uid).delete();
  try { await getAuth().deleteUser(uid); } catch (e) { if (e.code !== "auth/user-not-found") throw e; }
  return paypal;
}

exports.adminCuentas = onCall(
  { secrets: [PAYPAL_CLIENT_ID, PAYPAL_SECRET], region: "us-central1", maxInstances: 3, timeoutSeconds: 120, memory: "256MiB" },
  async (req) => {
    soloAdmin(req);
    const accion = req.data && req.data.accion;

    if (accion === "eliminar") {
      let uid = String((req.data && req.data.uid) || "");
      const correo = String((req.data && req.data.correo) || "").trim().toLowerCase();
      if (!uid && correo) { try { uid = (await getAuth().getUserByEmail(correo)).uid; } catch (e) { /* sin acceso */ } }
      if (!/^[A-Za-z0-9]{6,128}$/.test(uid)) throw new HttpsError("invalid-argument", "Usuario no válido.");
      if (uid === req.auth.uid) throw new HttpsError("failed-precondition", "No puedes eliminar tu propia cuenta de administrador.");
      const paypal = await borrar(uid);
      return { ok: true, paypal };
    }

    // Accesos de Authentication sin perfil (quedaron de eliminaciones anteriores): listarlos o borrarlos
    if (accion === "huerfanas" || accion === "limpiar") {
      const sin = [];
      let token;
      do {
        const r = await getAuth().listUsers(1000, token);
        const refs = r.users.map((u) => db().doc("users/" + u.uid));
        const docs = refs.length ? await db().getAll(...refs) : [];
        r.users.forEach((u, i) => { if (!docs[i].exists && !esAdmin(u) && u.uid !== req.auth.uid) sin.push({ uid: u.uid, correo: u.email || "", creado: Date.parse(u.metadata.creationTime) || 0 }); });
        token = r.pageToken;
      } while (token);
      if (accion === "huerfanas") return { cuentas: sin };
      for (const c of sin) await borrar(c.uid);
      return { borradas: sin.length };
    }
    throw new HttpsError("invalid-argument", "Acción desconocida.");
  }
);
