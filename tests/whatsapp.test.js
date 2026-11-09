// Tests del canal de WhatsApp con chip (no se conecta a WhatsApp ni a ninguna IA):  npm test
import { test, before } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.ANTHROPIC_API_KEY = "";
process.env.GEMINI_API_KEY = "";
process.env.SMTP_USER = "";
process.env.OWNER_WEBHOOK_URL = "";

const { openDb, getDb, getConversation, getLead } = await import("../src/db.js");
const { procesarMensaje, esBaja, diezDigitos } = await import("../src/channels/wa-web.js");
const { guardarProspecto } = await import("../src/prospeccion/servicio.js");

const enviados = [];
const enviarFalso = async (jid, texto) => enviados.push({ jid, texto });

before(() => {
  openDb(":memory:");
  getDb().exec("CREATE TABLE IF NOT EXISTS wa_contactos (id TEXT PRIMARY KEY, jid TEXT NOT NULL, actualizado TEXT NOT NULL);");
  guardarProspecto({ fuente: "denue", externo_id: "1", nombre: "Barbería Ruiz", rubro: "Barberías", ciudad: "Torreón", telefono: "8718458221" });
  guardarProspecto({ fuente: "denue", externo_id: "2", nombre: "Tacos Pepe", rubro: "Taquerías y comida", ciudad: "Lerdo", telefono: "8710000002" });
  getDb().prepare("UPDATE prospectos SET estado = 'enviado', envios = 1, whatsapp_texto = 'Hola, soy Sebastián...'").run();
});

test("normaliza números de WhatsApp a 10 dígitos", () => {
  assert.equal(diezDigitos("5218718458221@s.whatsapp.net"), "8718458221");
  assert.equal(diezDigitos("528718458221"), "8718458221");
});

test("detecta pedidos de baja sin confundir preguntas normales", () => {
  assert.ok(esBaja("BAJA"));
  assert.ok(esBaja("No me vuelvas a escribir"));
  assert.ok(!esBaja("¿Cuánto cuesta la página?"));
  assert.ok(!esBaja("No me interesa el menú pero sí la página"));
});

test("cuando un prospecto responde: abre conversación, crea lead y lo marca como respondió", async () => {
  const r = await procesarMensaje({ id: "8718458221", jid: "5218718458221@s.whatsapp.net", texto: "Hola, sí me interesa", nombre: "Juan" }, enviarFalso);
  assert.equal(r, "sin_ia"); // sin IA configurada queda registrado para Sebastián y no contesta nada
  assert.equal(enviados.length, 0);
  const conv = getConversation("wa:8718458221");
  assert.ok(conv);
  assert.equal(getLead(conv.id).empresa, "Barbería Ruiz");
  assert.equal(getDb().prepare("SELECT estado FROM prospectos WHERE telefono = '8718458221'").get().estado, "respondio");
  const hist = getDb().prepare("SELECT historial FROM conversaciones WHERE id = ?").get(conv.id).historial;
  assert.match(hist, /Le escribimos primero a este negocio/, "el agente recibe el contexto del primer mensaje");
});

test("si pide BAJA: se confirma una sola vez, se bloquea y se pausa el agente", async () => {
  const r = await procesarMensaje({ id: "8710000002", jid: "5218710000002@s.whatsapp.net", texto: "Baja", nombre: null }, enviarFalso);
  assert.equal(r, "baja");
  assert.equal(enviados.length, 1);
  assert.equal(getDb().prepare("SELECT estado FROM prospectos WHERE telefono = '8710000002'").get().estado, "no_contactar");
  assert.equal(getConversation("wa:8710000002").bot_activo, 0);
});
