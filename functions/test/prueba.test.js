/* Pruebas de la fecha de fin de la prueba gratuita (node --test). */
const test = require("node:test");
const assert = require("node:assert");
const { calcularFin } = require("../prueba")._test;
const DIA = 864e5;

test("Prueba: fin = creación de la cuenta + días de prueba", () => {
  assert.strictEqual(calcularFin(1000, 15, 0), 1000 + 15 * DIA);
});

test("Prueba: una extensión antigua del administrador (dayOffset negativo) se respeta", () => {
  assert.strictEqual(calcularFin(0, 15, -7), 22 * DIA);
});

test("Prueba: un dayOffset manipulado no alarga la prueba más de 60 días ni la acorta", () => {
  assert.strictEqual(calcularFin(0, 15, -100000), 75 * DIA);
  assert.strictEqual(calcularFin(0, 15, 30), 15 * DIA);
  assert.strictEqual(calcularFin(0, 15, "x"), 15 * DIA);
});
