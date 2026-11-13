/* Pruebas de los contadores de tráfico de la landing (node --test). */
const test = require("node:test");
const assert = require("node:assert");
const { contadores, cuando } = require("../trafico")._test;

const MS = Date.UTC(2026, 10, 13, 15, 30); // 10:30 en Ecuador (UTC-5)

test("Tráfico: la hora es la de Ecuador", () => {
  assert.deepStrictEqual(cuando(MS), { dia: "2026-11-13", hora: "10" });
  assert.deepStrictEqual(cuando(Date.UTC(2026, 10, 14, 3, 0)), { dia: "2026-11-13", hora: "22" });
});

test("Tráfico: una vista suma visita, persona nueva, zona, fuente, dispositivo e idioma", () => {
  const x = contadores({ t: "v", n: 1, tz: "America/Guayaquil", r: "instagram.com", m: 1, l: "es" }, MS);
  const h = x.data.h["10"];
  assert.strictEqual(x.dia, "2026-11-13");
  assert.ok(h.v && h.u);
  assert.deepStrictEqual(Object.keys(h.z), ["America/Guayaquil"]);
  assert.deepStrictEqual(Object.keys(h.f), ["instagram.com"]);
  assert.deepStrictEqual(Object.keys(h.d), ["movil"]);
});

test("Tráfico: un clic suma el botón", () => {
  const x = contadores({ t: "c", b: "Inicio · Comenzar prueba gratuita" }, MS);
  assert.deepStrictEqual(Object.keys(x.data.h["10"].c), ["Inicio · Comenzar prueba gratuita"]);
});

test("Tráfico: limpia datos raros y descarta eventos inválidos", () => {
  assert.strictEqual(contadores({ t: "x" }, MS), null);
  assert.strictEqual(contadores({ t: "c", b: "<<<>>>" }, MS), null);
  const h = contadores({ t: "v", tz: "<script>", r: "javascript:alert(1)" }, MS).data.h["10"];
  assert.strictEqual(h.z, undefined);
  assert.deepStrictEqual(Object.keys(h.f), ["directo"]);
  assert.strictEqual(h.u, undefined);
});
