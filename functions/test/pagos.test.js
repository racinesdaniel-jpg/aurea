/* Pruebas de las reglas de pago (node --test). No llaman a PayPal, Payphone ni Firestore. */
const test = require("node:test");
const assert = require("node:assert");
const { montos, nuevoFin, planAceptado } = require("../pagos")._test;

const precios = { priceM: 14.45, priceA: 139.6 };

test("PayPal: acepta el plan nuevo con el precio vigente", () => {
  assert.ok(planAceptado("live_mensual_1445", "live", precios, false));
  assert.ok(planAceptado("live_anual_13960", "live", precios, false));
});

test("PayPal: rechaza un plan viejo (por ejemplo el de $1) en una suscripción nueva", () => {
  assert.ok(!planAceptado("live_mensual_100", "live", precios, false));
  assert.ok(!planAceptado("live_anual_7900", "live", precios, false));
});

test("PayPal: una renovación de una suscripción que ya era de la persona conserva su precio", () => {
  assert.ok(planAceptado("live_mensual_999", "live", precios, true));
});

test("PayPal: nunca acepta planes de otro entorno ni claves raras", () => {
  assert.ok(!planAceptado("sandbox_mensual_1445", "live", precios, false));
  assert.ok(!planAceptado("sandbox_mensual_1445", "live", precios, true));
  assert.ok(!planAceptado("product_live", "live", precios, true));
  assert.ok(!planAceptado("", "live", precios, true));
  assert.ok(!planAceptado("live_mensual_0", "live", { priceM: 0 }, false));
});

test("Payphone: montos con IVA incluido suman el total", () => {
  const m = montos(14.45, 15);
  assert.strictEqual(m.amount, 1445);
  assert.strictEqual(m.amountWithTax + m.tax, 1445);
  assert.strictEqual(montos(10, 0).amountWithoutTax, 1000);
});

test("Fin de período: un mes o un año desde hoy", () => {
  const ahora = Date.now();
  assert.ok(nuevoFin(0, "mensual") > ahora + 27 * 864e5);
  assert.ok(nuevoFin(0, "anual") > ahora + 364 * 864e5);
});
