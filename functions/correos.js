/* Correos propios de Áurea (confirmar correo y crear una contraseña nueva), enviados desde info@aureamentor.com
   por el SMTP de Hostinger. Reemplazan a las plantillas de Firebase, que están bloqueadas en este proyecto.
   El enlace lleva a www.aureamentor.com, donde la app completa la acción con el código de Firebase. */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
const nodemailer = require("nodemailer");

const SMTP_PASS = defineSecret("SMTP_PASS"); // contraseña del buzón info@aureamentor.com (la escribe Daniel)
const SMTP_USER = defineString("SMTP_USER", { default: "info@aureamentor.com" });
const SMTP_HOST = defineString("SMTP_HOST", { default: "smtp.hostinger.com" });
const SITE = "https://www.aureamentor.com/app.html";
const db = () => getFirestore();

let tx = null;
function transporte() {
  if (!tx) tx = nodemailer.createTransport({ host: SMTP_HOST.value(), port: 465, secure: true, auth: { user: SMTP_USER.value(), pass: SMTP_PASS.value() } });
  return tx;
}
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }

/* Diseño del correo: sobrio, con un solo botón */
function plantilla({ titulo, saludo, texto, boton, url, pie, en }) {
  return `<!doctype html><html lang="${en ? "en" : "es"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#F7F5F0;font-family:Helvetica,Arial,sans-serif;color:#141A2E">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F5F0;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border-radius:16px;overflow:hidden">
<tr><td style="background:#111833;padding:22px 28px"><img src="https://www.aureamentor.com/brand/aurea-mentor-oscuro.png" width="148" height="50" alt="Áurea Mentor" style="display:block;border:0"></td></tr>
<tr><td style="padding:30px 28px 8px"><h1 style="margin:0 0 14px;font-family:Georgia,serif;font-weight:400;font-size:26px;line-height:1.25">${esc(titulo)}</h1>
<p style="margin:0 0 10px;font-size:16px;line-height:1.6">${esc(saludo)}</p><p style="margin:0 0 24px;font-size:16px;line-height:1.6">${esc(texto)}</p>
<a href="${esc(url)}" style="display:inline-block;background:#0E8C78;color:#FFFFFF;text-decoration:none;font-weight:600;font-size:16px;padding:14px 26px;border-radius:999px">${esc(boton)}</a>
<p style="margin:26px 0 0;font-size:13px;line-height:1.6;color:#5D6378">${esc(pie)}</p></td></tr>
<tr><td style="padding:22px 28px 28px;font-size:13px;color:#5D6378;line-height:1.6">${en ? "With care," : "Con cariño,"}<br>${en ? "The Áurea Mentor team" : "El equipo de Áurea Mentor"}<br><a href="https://www.aureamentor.com" style="color:#0E8C78">www.aureamentor.com</a></td></tr>
</table></td></tr></table></body></html>`;
}
function codigoDe(link) { return new URL(link).searchParams.get("oobCode"); }

/* Límite: como máximo 3 correos por hora para la misma clave */
async function limite(clave) {
  const ref = db().doc("admin/correos_" + clave.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 120));
  const hora = Math.floor(Date.now() / 3600e3);
  await db().runTransaction(async (t) => {
    const d = (await t.get(ref)).data() || {};
    const n = d.hora === hora ? d.n || 0 : 0;
    if (n >= 3) throw new HttpsError("resource-exhausted", "Ya te enviamos varios correos. Revisa tu bandeja (y la carpeta de spam) o espera una hora.");
    t.set(ref, { hora, n: n + 1, at: Date.now() });
  });
}
async function enviar(para, asunto, html, texto) {
  await transporte().sendMail({ from: { name: "Áurea Mentor", address: SMTP_USER.value() }, replyTo: SMTP_USER.value(), to: para, subject: asunto, html, text: texto });
}

/* Confirmar el correo de la persona que inició sesión */
exports.correoVerificacion = onCall({ secrets: [SMTP_PASS], region: "us-central1", maxInstances: 5, timeoutSeconds: 30, memory: "256MiB" }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const email = req.auth.token.email;
  if (!email) throw new HttpsError("failed-precondition", "Tu cuenta no tiene correo.");
  if (req.auth.token.email_verified) return { ok: true, yaConfirmado: true };
  const en = req.data && req.data.lang === "en";
  await limite("v_" + req.auth.uid);
  const url = SITE + "?modo=verificar&codigo=" + encodeURIComponent(codigoDe(await getAuth().generateEmailVerificationLink(email)));
  const nombre = String((req.data && req.data.nombre) || "").slice(0, 60);
  const html = plantilla(en
    ? { en, titulo: "Confirm your email", saludo: nombre ? `Hello, ${nombre}:` : "Hello:", texto: "Welcome to Áurea Mentor. Tap the button to confirm that this email is yours.", boton: "Confirm my email", url, pie: "If you did not create an account in Áurea Mentor, you can ignore this message." }
    : { titulo: "Confirma tu correo", saludo: nombre ? `Hola, ${nombre}:` : "Hola:", texto: "Te damos la bienvenida a Áurea Mentor. Toca el botón para confirmar que este correo es tuyo.", boton: "Confirmar mi correo", url, pie: "Si no creaste una cuenta en Áurea Mentor, puedes ignorar este mensaje." });
  await enviar(email, en ? "Confirm your email · Áurea Mentor" : "Confirma tu correo · Áurea Mentor", html,
    (en ? "Confirm your email in Áurea Mentor: " : "Confirma tu correo en Áurea Mentor: ") + url);
  return { ok: true };
});

/* «¿Olvidaste tu contraseña?»: responde igual exista o no la cuenta (no revela qué correos están registrados) */
exports.correoClave = onCall({ secrets: [SMTP_PASS], region: "us-central1", maxInstances: 5, timeoutSeconds: 30, memory: "256MiB" }, async (req) => {
  const email = String((req.data && req.data.email) || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) throw new HttpsError("invalid-argument", "Escribe un correo válido.");
  const en = req.data && req.data.lang === "en";
  await limite("c_" + email);
  let link;
  try { link = await getAuth().generatePasswordResetLink(email); } catch (e) {
    if (e.code === "auth/user-not-found" || e.code === "auth/email-not-found") return { ok: true };
    throw new HttpsError("internal", "No pudimos enviar el correo. Inténtalo de nuevo en unos minutos.");
  }
  const url = SITE + "?modo=clave&codigo=" + encodeURIComponent(codigoDe(link));
  const html = plantilla(en
    ? { en, titulo: "Create a new password", saludo: "Hello:", texto: "We received a request to create a new password for your Áurea Mentor account. Tap the button to choose it.", boton: "Create a new password", url, pie: "If you did not request it, ignore this message: your current password stays the same." }
    : { titulo: "Crea una contraseña nueva", saludo: "Hola:", texto: "Recibimos una solicitud para crear una contraseña nueva para tu cuenta de Áurea Mentor. Toca el botón para elegirla.", boton: "Crear contraseña nueva", url, pie: "Si no lo pediste, ignora este mensaje: tu contraseña actual sigue igual." });
  await enviar(email, en ? "Create a new password · Áurea Mentor" : "Crea una contraseña nueva · Áurea Mentor", html,
    (en ? "Create a new password for Áurea Mentor: " : "Crea una contraseña nueva para Áurea Mentor: ") + url);
  return { ok: true };
});

exports._test = { plantilla, codigoDe };
