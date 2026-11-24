// Contenido diario para Instagram: plan, fechas, texto de envío y que no se mande dos veces.
import { test, before } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.ANTHROPIC_API_KEY = "";
process.env.GEMINI_API_KEY = "";
const { openDb, logEvent } = await import("../src/db.js");
const { FORMATOS, fechasProximas, leerPlan, promptPlan, textoContenido, revisarContenidoIG } = await import("../src/services/contenido-ig.js");
const { getNegocio } = await import("../src/config.js");

before(() => openDb(":memory:"));

const plan = {
  tema: "Menú digital",
  formato: "Antes / después",
  escenas: [1, 2, 3, 4].map((i) => ({ etiqueta: `E${i}`, texto: `texto ${i}`, busqueda: "restaurant" })),
  cierre: "¿Lo quieres?",
  carrusel: [1, 2, 3, 4, 5].map((i) => ({ titulo: `T${i}`, texto: `x${i}` })),
  caption: "Caption de prueba",
  hashtags: "#Torreón #LaLaguna",
  hora: "19:00",
};

test("hay un formato distinto para cada día de la semana", () => {
  assert.equal(FORMATOS.length, 7);
  assert.equal(new Set(FORMATOS.map((f) => f.nombre)).size, 7);
});

test("avisa de las fechas comerciales que vienen", () => {
  const f = fechasProximas(new Date("2026-12-01T18:00:00Z"));
  assert.ok(f.some((x) => x.startsWith("Día de la Virgen de Guadalupe (en 11 días)")));
  assert.ok(!f.some((x) => x.startsWith("Nochebuena")), "faltan 23 días: todavía no");
  assert.ok(fechasProximas(new Date("2026-12-10T18:00:00Z")).some((x) => x.startsWith("Nochebuena")));
  assert.ok(!f.some((x) => x.startsWith("San Valentín")));
});

test("lee el JSON aunque venga envuelto en ```json y rechaza planes incompletos", () => {
  const p = leerPlan("```json\n" + JSON.stringify(plan) + "\n```");
  assert.equal(p.escenas.length, 4);
  assert.throws(() => leerPlan('{"tema":"x","escenas":[]}'), /incompleto/);
  assert.throws(() => leerPlan("no hay json"), /JSON/);
});

test("el prompt lleva las tendencias, las fechas y los temas a no repetir", () => {
  const p = promptPlan({ fecha: "lunes", negocio: getNegocio(), formato: FORMATOS[1], servicio: null, tendencias: ["impuesto predial"], fechas: ["Navidad (en 30 días)"], web: "", recientes: ["Menú digital"] });
  assert.match(p, /impuesto predial/);
  assert.match(p, /Navidad/);
  assert.match(p, /"Menú digital"/);
  assert.match(p, /EN INGLÉS/);
});

test("con video manda el caption; sin video manda el guion completo", () => {
  assert.match(textoContenido(plan, { conVideo: true }), /Caption de prueba/);
  assert.doesNotMatch(textoContenido(plan, { conVideo: true }), /guion/);
  const g = textoContenido(plan, { conVideo: false });
  assert.match(g, /guion/);
  assert.match(g, /4\. E4 · texto 4/);
});

test("sin IA no hace nada; si ya se mandó hoy, tampoco", async () => {
  const salen = [];
  const enviar = { texto: async (t) => (salen.push(t), true), video: async () => true, imagen: async () => true };
  assert.equal(await revisarContenidoIG(new Date("2026-11-23T18:00:00Z"), enviar), null);
  logEvent("contenido_ig", null, { clave: "2026-11-23", tema: "x" });
  process.env.GEMINI_API_KEY = "x";
  assert.equal(await revisarContenidoIG(new Date("2026-11-23T18:00:00Z"), enviar), null);
  process.env.GEMINI_API_KEY = "";
  assert.deepEqual(salen, []);
});
