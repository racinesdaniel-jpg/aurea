/* Pagos con tarjeta de Áurea por Payphone (Ecuador).
   Fase 1: pago de un período (mensual o anual) con el Botón de Pago de Payphone. Al volver, el servidor confirma el
   cobro con Payphone y activa subs/{uid} hasta la fecha de fin del período. Una tarea diaria desactiva las vencidas.
   Fase 2 (cuando Payphone autorice la tokenización): cobro automático de la renovación con la tarjeta guardada.
   El token de Payphone vive solo aquí, como secreto de Firebase (PAYPHONE_TOKEN); nunca llega al navegador. */
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret, defineString } = require("firebase-functions/params");
const { getFirestore } = require("firebase-admin/firestore");
const crypto = require("crypto");

const PAYPHONE_TOKEN = defineSecret("PAYPHONE_TOKEN");
const PAYPHONE_STORE_ID = defineString("PAYPHONE_STORE_ID", { default: "" });
const SITE = "https://www.aureamentor.com";
const API = "https://pay.payphonetodoesposible.com/api";
const DEF = { priceM: 9.99, priceA: 79, payIva: 15 };

const db = () => getFirestore();

/* Precio en centavos, con el IVA incluido en el precio publicado (payIva en settings/app; 0 si no se cobra IVA). */
function montos(total, iva) {
  const amount = Math.round(total * 100);
  if (!(iva > 0)) return { amount, amountWithoutTax: amount, amountWithTax: 0, tax: 0 };
  const base = Math.round(amount / (1 + iva / 100));
  return { amount, amountWithoutTax: 0, amountWithTax: base, tax: amount - base };
}
/* Suma un mes o un año a partir de la fecha de fin vigente (si aún no venció) o desde hoy. */
function nuevoFin(desde, plan) {
  const d = new Date(Math.max(desde || 0, Date.now()));
  if (plan === "anual") d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d.getTime();
}
async function payphone(path, body, token) {
  const r = await fetch(API + path, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  let j = {};
  try { j = JSON.parse(txt); } catch (e) { j = { message: txt.slice(0, 300) }; }
  if (!r.ok) { const e = new Error(j.message || "Payphone " + r.status); e.payphone = j; e.status = r.status; throw e; }
  return j;
}

/* 1) La app pide un enlace de pago para el plan elegido. */
exports.payphoneStart = onCall(
  { secrets: [PAYPHONE_TOKEN], region: "us-central1", maxInstances: 5, timeoutSeconds: 30, memory: "256MiB" },
  async (req) => {
    if (!req.auth) throw new HttpsError("unauthenticated", "Inicia sesión para suscribirte.");
    const plan = req.data && req.data.plan === "mensual" ? "mensual" : "anual";
    const s = { ...DEF, ...((await db().doc("settings/app").get()).data() || {}) };
    const total = plan === "anual" ? +s.priceA : +s.priceM;
    if (!(total > 0)) throw new HttpsError("failed-precondition", "El precio del plan no está configurado.");
    const m = montos(total, +s.payIva);
    const ref = db().collection("pagos").doc();
    const clientTransactionId = ref.id; // único, 20 caracteres
    await ref.set({ uid: req.auth.uid, email: req.auth.token.email || "", plan, ...m, currency: "USD", provider: "payphone", status: "pendiente", createdAt: Date.now() });
    const body = {
      ...m,
      currency: "USD",
      clientTransactionId,
      reference: "Áurea, plan " + plan,
      responseUrl: SITE + "/pago/payphone",
      cancellationUrl: SITE + "/app.html?pago=cancelado",
    };
    if (PAYPHONE_STORE_ID.value()) body.storeId = PAYPHONE_STORE_ID.value();
    if (req.auth.token.email) body.email = req.auth.token.email;
    try {
      const r = await payphone("/button/Prepare", body, PAYPHONE_TOKEN.value());
      if (!r.payWithCard) throw new Error("Payphone no devolvió el enlace de pago");
      await ref.update({ paymentId: r.paymentId || null });
      return { url: r.payWithCard };
    } catch (e) {
      console.error("Payphone Prepare", e.status, JSON.stringify(e.payphone || e.message));
      await ref.update({ status: "error", error: String(e.message).slice(0, 200) });
      throw new HttpsError("unavailable", "No pude abrir el pago en este momento. Intenta de nuevo en unos minutos.");
    }
  }
);

/* 2) Payphone devuelve a la persona aquí (/pago/payphone?id=…&clientTransactionId=…).
   Se confirma en el servidor (Payphone revierte el cobro si no se confirma en 5 minutos) y se activa la suscripción. */
exports.payphoneReturn = onRequest(
  { secrets: [PAYPHONE_TOKEN], region: "us-central1", maxInstances: 5, timeoutSeconds: 30, memory: "256MiB" },
  async (req, res) => {
    const id = parseInt(req.query.id, 10);
    const tx = String(req.query.clientTransactionId || req.query.clientTxId || "").slice(0, 50);
    const back = (r) => res.redirect(302, SITE + "/app.html?pago=" + r);
    if (!id || !/^[A-Za-z0-9]{10,50}$/.test(tx)) return back("error");
    const ref = db().doc("pagos/" + tx);
    const snap = await ref.get();
    if (!snap.exists) return back("error");
    const p = snap.data();
    if (p.status === "aprobado") return back("ok");
    let c;
    try {
      c = await payphone("/button/V2/Confirm", { id, clientTxId: tx }, PAYPHONE_TOKEN.value());
    } catch (e) {
      console.error("Payphone Confirm", e.status, JSON.stringify(e.payphone || e.message));
      await ref.update({ status: "error", error: String(e.message).slice(0, 200) });
      return back("error");
    }
    const ok = c.statusCode === 3 && +c.amount === +p.amount && String(c.clientTransactionId || tx) === tx;
    if (!ok) {
      await ref.update({ status: c.statusCode === 2 ? "cancelado" : "rechazado", transactionId: c.transactionId || id, statusCode: c.statusCode || null, updatedAt: Date.now() });
      return back(c.statusCode === 2 ? "cancelado" : "rechazado");
    }
    const subRef = db().doc("subs/" + p.uid);
    await db().runTransaction(async (t) => {
      const cur = (await t.get(ref)).data();
      if (cur.status === "aprobado") return; // ya se procesó (por ejemplo, la persona recargó la página)
      const sub = (await t.get(subRef)).data() || {};
      const fin = nuevoFin(sub.active ? sub.currentPeriodEnd : 0, p.plan);
      t.update(ref, { status: "aprobado", transactionId: c.transactionId || id, authorizationCode: c.authorizationCode || "", cardBrand: c.cardBrand || "", lastDigits: c.lastDigits || "", approvedAt: Date.now() });
      t.set(subRef, { active: true, plan: p.plan, provider: "payphone", currentPeriodEnd: fin, lastPayment: tx, updatedAt: Date.now() }, { merge: true });
    });
    return back("ok");
  }
);

/* 3) Cada día a las 03:00 (Ecuador): desactivar las suscripciones cuyo período terminó. */
exports.subsDaily = onSchedule({ schedule: "0 3 * * *", timeZone: "America/Guayaquil", region: "us-central1" }, async () => {
  const now = Date.now();
  const q = await db().collection("subs").where("currentPeriodEnd", "<", now).get();
  const vencidas = q.docs.filter((d) => d.data().active === true);
  const b = db().batch();
  vencidas.forEach((d) => b.update(d.ref, { active: false, endedAt: now, updatedAt: now }));
  if (vencidas.length) await b.commit();
  console.log("Suscripciones vencidas:", vencidas.length);
});

exports._test = { montos, nuevoFin };
// Fase 2: el cifrado del titular que exige Payphone para cobrar con cardToken (AES-256-CBC, IV vacío, Base64).
exports._cifrarTitular = (nombre, clave) => {
  const c = crypto.createCipheriv("aes-256-cbc", Buffer.from(clave, "utf8"), Buffer.alloc(16));
  return Buffer.concat([c.update(nombre, "utf8"), c.final()]).toString("base64");
};
