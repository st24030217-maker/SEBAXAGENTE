// Tests de bocetos (páginas de muestra) y ventas cerradas:  npm test
import { test, before } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.ANTHROPIC_API_KEY = "";
process.env.GEMINI_API_KEY = "";

const { openDb, getDb } = await import("../src/db.js");
const { guardarProspecto, getProspecto, actualizarProspecto, resumenVentas } = await import("../src/prospeccion/servicio.js");
const { claveBoceto, urlBoceto, buscarPorClave, registrarVisita, renderBoceto } = await import("../src/prospeccion/boceto.js");

before(() => openDb(":memory:"));

test("cada negocio tiene su boceto con su nombre, sin inyectar HTML", () => {
  guardarProspecto({ fuente: "denue", externo_id: "1", nombre: "Tacos <El> Güero", rubro: "Taquerías y comida", ciudad: "Torreón", colonia: "Centro", telefono: "8711111111" });
  const p = getProspecto(1);
  const clave = claveBoceto(p);
  assert.match(clave, /^[0-9a-f]{8}$/);
  assert.equal(claveBoceto(getProspecto(1)), clave, "la clave no cambia");
  assert.match(urlBoceto(getProspecto(1)), new RegExp(`/m/tacos-el-guero-${clave}$`));
  assert.equal(buscarPorClave(`cualquier-cosa-${clave}`).id, 1);
  assert.equal(buscarPorClave("tacos-zzzz"), null);
  const html = renderBoceto(getProspecto(1));
  assert.match(html, /Tacos &lt;El&gt; Güero/);
  assert.doesNotMatch(html, /<El>/);
  assert.match(html, /Quiero la mía/);
});

test("solo avisa la primera vez que el negocio lo abre (no cuenta bots ni tus vistas)", () => {
  const p = getProspecto(1);
  const cel = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)";
  assert.equal(registrarVisita(p, { userAgent: "WhatsApp/2.23 A" }), false);
  assert.equal(registrarVisita(p, { userAgent: cel, tuyo: true }), false);
  assert.equal(registrarVisita(p, { userAgent: cel }), true);
  assert.equal(registrarVisita(p, { userAgent: cel }), false);
  assert.match(getProspecto(1).notas, /Abrió su boceto/);
});

test("las ventas cerradas se suman por rubro", () => {
  guardarProspecto({ fuente: "denue", externo_id: "2", nombre: "Barbería Ruiz", rubro: "Barberías", ciudad: "Lerdo", telefono: "8712222222" });
  actualizarProspecto(1, { estado: "cliente", venta_monto: 4500, venta_servicio: "Menú digital", venta_fecha: new Date().toISOString() });
  actualizarProspecto(2, { estado: "cliente", venta_monto: 3000, venta_servicio: "Sistema de citas", venta_fecha: new Date().toISOString() });
  const v = resumenVentas();
  assert.equal(v.clientes, 2);
  assert.equal(v.total, 7500);
  assert.equal(v.mesTotal, 7500);
  assert.equal(v.porRubro[0].nombre, "Taquerías y comida");
  assert.equal(getDb().prepare("SELECT venta_servicio FROM prospectos WHERE id = 2").get().venta_servicio, "Sistema de citas");
});
