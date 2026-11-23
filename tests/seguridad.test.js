// Protecciones: bloqueo de la clave del panel, techo diario del chat público y solo sitios públicos al leer páginas.
import { test, before } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.ANTHROPIC_API_KEY = "";
process.env.GEMINI_API_KEY = "";
const { openDb, getDb, getOrCreateConversation } = await import("../src/db.js");
const { bloqueadoPorFallos, registrarFallo } = await import("../src/admin/routes.js");
const { superaTechoDiario } = await import("../src/channels/web.js");
const { esPublica } = await import("../src/prospeccion/marca.js");

before(() => openDb(":memory:"));

test("10 claves equivocadas bloquean la IP 15 minutos, y luego se libera", () => {
  const t0 = Date.parse("2026-11-23T12:00:00Z");
  for (let i = 0; i < 9; i++) registrarFallo("1.2.3.4", t0 + i * 1000);
  assert.equal(bloqueadoPorFallos("1.2.3.4", t0 + 10_000), false);
  registrarFallo("1.2.3.4", t0 + 11_000);
  assert.equal(bloqueadoPorFallos("1.2.3.4", t0 + 12_000), true);
  assert.equal(bloqueadoPorFallos("5.6.7.8", t0 + 12_000), false, "otra IP no se afecta");
  assert.equal(bloqueadoPorFallos("1.2.3.4", t0 + 16 * 60_000), false);
});

test("el chat web tiene techo diario", () => {
  process.env.CHAT_WEB_MAX_DIA = "3";
  const ins = getDb().prepare("INSERT INTO mensajes (conversacion_id, rol, texto, creado) VALUES (?, 'cliente', 'hola', ?)");
  const ahora = Date.parse("2026-11-23T18:00:00Z");
  for (const [c, id] of [["web", "abcdefgh1"], ["web", "abcdefgh2"], ["web", "abcdefgh3"], ["web", "abcdefgh4"], ["wa", "8711111111"]]) getOrCreateConversation(c, id, "x");
  ins.run("web:abcdefgh1", new Date(ahora - 3600_000).toISOString());
  ins.run("web:abcdefgh2", new Date(ahora - 7200_000).toISOString());
  ins.run("wa:8711111111", new Date(ahora - 600_000).toISOString()); // WhatsApp no cuenta
  ins.run("web:abcdefgh3", new Date(ahora - 30 * 3600_000).toISOString()); // de ayer no cuenta
  assert.equal(superaTechoDiario(ahora), false);
  ins.run("web:abcdefgh4", new Date(ahora - 60_000).toISOString());
  assert.equal(superaTechoDiario(ahora), true);
  process.env.CHAT_WEB_MAX_DIA = "0";
  assert.equal(superaTechoDiario(ahora), false, "0 = sin techo");
  delete process.env.CHAT_WEB_MAX_DIA;
});

test("solo lee páginas públicas", () => {
  for (const u of ["https://cafetrendetroya.com.mx", "http://www.negocio.mx/menu"]) assert.equal(esPublica(u), true, u);
  for (const u of ["http://localhost:3000/admin", "http://127.0.0.1/", "http://192.168.1.1/", "http://10.0.0.5", "http://172.20.1.1", "http://169.254.169.254/latest", "file:///C:/x", "http://[::1]/", "http://user:pass@sitio.mx", "http://intranet/"]) assert.equal(esPublica(u), false, u);
});
