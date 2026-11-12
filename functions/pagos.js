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
exports.subsDaily = onSchedule({ schedule: "0 3 * * *", timeZone: "America/Guayaquil", region: "us-central1", secrets: ["PAYPAL_CLIENT_ID", "PAYPAL_SECRET"] }, async () => {
  const now = Date.now();
  const q = await db().collection("subs").where("currentPeriodEnd", "<", now).get();
  let vencidas = q.docs.filter((d) => d.data().active === true);
  const quedan = [];
  for (const d of vencidas) {
    const v = d.data();
    if (v.provider === "paypal" && v.paypalSub && PAYPAL_CLIENT_ID.value()) {
      try { const r = await ppSync(v.paypalSub); if (r.active) continue; } catch (e) { console.error("PayPal sync", d.id, e.message); }
    }
    quedan.push(d);
  }
  vencidas = quedan;
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

/* ===================== PayPal Suscripciones (clientes fuera de Ecuador) =====================
   PayPal cobra solo cada mes o cada año. El servidor crea los planes en PayPal (uno por precio), verifica cada
   suscripción consultando a PayPal (nunca confía en lo que envía el navegador) y la renueva o la cierra según su estado. */
const PAYPAL_SECRET = defineSecret("PAYPAL_SECRET");
const PAYPAL_CLIENT_ID = defineSecret("PAYPAL_CLIENT_ID"); // no es secreto, pero así se guarda igual que el Secret
const PAYPAL_ENV = defineString("PAYPAL_ENV", { default: "sandbox" }); // "sandbox" (pruebas) o "live"
const ppBase = () => (PAYPAL_ENV.value() === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com");
const GRACIA = 3 * 864e5; // días de margen tras la fecha de cobro, por si PayPal tarda en cobrar

let ppTok = null;
async function ppToken() {
  if (ppTok && ppTok.exp > Date.now() + 60000) return ppTok.v;
  const r = await fetch(ppBase() + "/v1/oauth2/token", {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(PAYPAL_CLIENT_ID.value() + ":" + PAYPAL_SECRET.value()).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const j = await r.json();
  if (!r.ok) throw new Error("PayPal token " + r.status + " " + (j.error_description || ""));
  ppTok = { v: j.access_token, exp: Date.now() + (j.expires_in || 300) * 1000 };
  return ppTok.v;
}
async function pp(method, path, body) {
  const r = await fetch(ppBase() + path, {
    method,
    headers: { Authorization: "Bearer " + (await ppToken()), "Content-Type": "application/json", Prefer: "return=representation" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let j = {};
  try { j = txt ? JSON.parse(txt) : {}; } catch (e) { j = { message: txt.slice(0, 300) }; }
  if (!r.ok) { const e = new Error(j.message || "PayPal " + r.status); e.paypal = j; e.status = r.status; throw e; }
  return j;
}
/* Plan de PayPal para un plan y un precio; se crea la primera vez y se guarda en admin/paypal. */
async function ppPlan(plan, price) {
  const key = PAYPAL_ENV.value() + "_" + plan + "_" + Math.round(price * 100);
  const ref = db().doc("admin/paypal");
  const saved = ((await ref.get()).data() || {});
  if (saved[key]) return saved[key];
  let product = saved["product_" + PAYPAL_ENV.value()];
  if (!product) {
    product = (await pp("POST", "/v1/catalogs/products", { name: "Áurea", description: "Mentoría La Espiral de la Plenitud", type: "SERVICE", category: "SOFTWARE" })).id;
    await ref.set({ ["product_" + PAYPAL_ENV.value()]: product }, { merge: true });
  }
  const anual = plan === "anual";
  const p = await pp("POST", "/v1/billing/plans", {
    product_id: product,
    name: anual ? "Áurea anual" : "Áurea mensual",
    billing_cycles: [{ frequency: { interval_unit: anual ? "YEAR" : "MONTH", interval_count: 1 }, tenure_type: "REGULAR", sequence: 1, total_cycles: 0,
      pricing_scheme: { fixed_price: { value: price.toFixed(2), currency_code: "USD" } } }],
    payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 2 },
  });
  await ref.set({ [key]: p.id }, { merge: true });
  return p.id;
}
/* Lleva a subs/{uid} el estado real de una suscripción de PayPal. */
async function ppSync(subId, uidEsperado) {
  const s = await pp("GET", "/v1/billing/subscriptions/" + encodeURIComponent(subId));
  const uid = s.custom_id;
  if (!uid || (uidEsperado && uid !== uidEsperado)) throw new Error("La suscripción no corresponde a esta cuenta");
  const map = ((await db().doc("admin/paypal").get()).data() || {});
  const plan = Object.keys(map).find((k) => map[k] === s.plan_id);
  if (!plan) throw new Error("Plan de PayPal desconocido");
  const next = s.billing_info && s.billing_info.next_billing_time ? Date.parse(s.billing_info.next_billing_time) : 0;
  const activa = s.status === "ACTIVE";
  const ref = db().doc("subs/" + uid);
  const cur = (await ref.get()).data() || {};
  // Si la persona canceló, conserva el acceso hasta el fin del período que ya pagó
  const fin = activa ? (next ? next + GRACIA : nuevoFin(0, plan.includes("_anual_") ? "anual" : "mensual")) : (cur.paypalSub === subId ? cur.currentPeriodEnd || 0 : 0);
  const d = { provider: "paypal", paypalSub: subId, paypalStatus: s.status, plan: plan.includes("_anual_") ? "anual" : "mensual",
    active: activa || fin > Date.now(), currentPeriodEnd: fin, autoRenew: activa, updatedAt: Date.now() };
  await ref.set(d, { merge: true });
  return { uid, ...d };
}

/* La app pide los datos para mostrar el botón de PayPal del plan elegido. */
exports.paypalPlan = onCall(
  { secrets: [PAYPAL_CLIENT_ID, PAYPAL_SECRET], region: "us-central1", maxInstances: 5, timeoutSeconds: 30, memory: "256MiB" },
  async (req) => {
    if (!req.auth) throw new HttpsError("unauthenticated", "Inicia sesión para suscribirte.");
    if (!PAYPAL_CLIENT_ID.value()) throw new HttpsError("failed-precondition", "El pago con PayPal aún no está configurado.");
    const plan = req.data && req.data.plan === "mensual" ? "mensual" : "anual";
    const s = { ...DEF, ...((await db().doc("settings/app").get()).data() || {}) };
    const price = plan === "anual" ? +s.priceA : +s.priceM;
    try {
      return { clientId: PAYPAL_CLIENT_ID.value(), planId: await ppPlan(plan, price), uid: req.auth.uid };
    } catch (e) {
      console.error("PayPal plan", e.status, JSON.stringify(e.paypal || e.message));
      throw new HttpsError("unavailable", "No pude preparar el pago con PayPal. Intenta de nuevo en unos minutos.");
    }
  }
);
/* Tras aprobar en PayPal, la app envía el id de la suscripción; el servidor lo verifica con PayPal. */
exports.paypalConfirm = onCall(
  { secrets: [PAYPAL_CLIENT_ID, PAYPAL_SECRET], region: "us-central1", maxInstances: 5, timeoutSeconds: 30, memory: "256MiB" },
  async (req) => {
    if (!req.auth) throw new HttpsError("unauthenticated", "Inicia sesión para suscribirte.");
    const id = String((req.data && req.data.subscriptionID) || "");
    if (!/^I-[A-Z0-9]{6,40}$/.test(id)) throw new HttpsError("invalid-argument", "Suscripción no válida.");
    try {
      const d = await ppSync(id, req.auth.uid);
      return { active: d.active, currentPeriodEnd: d.currentPeriodEnd, plan: d.plan };
    } catch (e) {
      console.error("PayPal confirm", e.status, JSON.stringify(e.paypal || e.message));
      throw new HttpsError("failed-precondition", "No pude confirmar tu suscripción con PayPal. Si se hizo el cobro, escríbenos a info@aureamentor.com.");
    }
  }
);
/* La persona cancela la renovación desde su perfil; mantiene el acceso hasta el fin del período pagado. */
exports.subCancel = onCall(
  { secrets: [PAYPAL_CLIENT_ID, PAYPAL_SECRET], region: "us-central1", maxInstances: 5, timeoutSeconds: 30, memory: "256MiB" },
  async (req) => {
    if (!req.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
    const ref = db().doc("subs/" + req.auth.uid);
    const s = (await ref.get()).data() || {};
    if (s.provider === "paypal" && s.paypalSub && s.paypalStatus === "ACTIVE") {
      await pp("POST", "/v1/billing/subscriptions/" + encodeURIComponent(s.paypalSub) + "/cancel", { reason: "Cancelada por la persona desde Áurea" });
      const d = await ppSync(s.paypalSub, req.auth.uid);
      return { active: d.active, currentPeriodEnd: d.currentPeriodEnd };
    }
    await ref.set({ autoRenew: false, updatedAt: Date.now() }, { merge: true });
    return { active: !!s.active, currentPeriodEnd: s.currentPeriodEnd || 0 };
  }
);
/* Avisos de PayPal (cobro hecho, cancelación, suspensión). No se confía en el contenido del aviso:
   solo se usa el id para volver a consultar la suscripción a PayPal. */
exports.paypalWebhook = onRequest(
  { secrets: [PAYPAL_CLIENT_ID, PAYPAL_SECRET], region: "us-central1", maxInstances: 5, timeoutSeconds: 30, memory: "256MiB" },
  async (req, res) => {
    const b = req.body || {};
    const r = b.resource || {};
    const id = /^BILLING\.SUBSCRIPTION\./.test(b.event_type || "") ? r.id : r.billing_agreement_id;
    if (id && /^I-[A-Z0-9]{6,40}$/.test(id)) {
      try { await ppSync(id); } catch (e) { console.error("PayPal webhook", b.event_type, e.message); }
    }
    res.status(200).send("ok");
  }
);
exports._ppSync = ppSync;
exports._pp = pp;
