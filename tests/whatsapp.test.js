// Tests del canal de WhatsApp con chip (no se conecta a WhatsApp ni a ninguna IA):  npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.ANTHROPIC_API_KEY = "";
process.env.GEMINI_API_KEY = "";
process.env.SMTP_USER = "";
process.env.OWNER_WEBHOOK_URL = "";

const { openDb, getDb, getConversation, getLead } = await import("../src/db.js");
const { procesarMensaje, esBaja, diezDigitos, numeroDueno, seguimientosPendientesWa, textoSeguimiento } = await import("../src/channels/wa-web.js");
const { logEvent } = await import("../src/db.js");
const { prepararSeguimientos } = await import("../src/prospeccion/servicio.js");
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
  assert.ok(esBaja("No me interesa"));
  assert.ok(esBaja("no, gracias"));
  assert.ok(esBaja("No nos interesa por el momento, gracias."));
  assert.ok(!esBaja("No sé, ¿cuánto cuesta?"));
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

test("si el dueño le escribe al chip, el agente no le contesta como a un cliente", async () => {
  const yo = numeroDueno();
  assert.match(yo, /^[0-9]{10}$/);
  const antes = enviados.length;
  assert.equal(await procesarMensaje({ id: yo, jid: `521${yo}@s.whatsapp.net`, texto: "ok, gracias", nombre: "Sebas" }, enviarFalso), "dueno");
  assert.equal(enviados.length, antes);
  assert.ok(!getConversation(`wa:${yo}`), "no se abre conversación con el dueño");
});

test("seguimiento por WhatsApp: solo a quien se le escribió por WhatsApp hace N días y no contestó", () => {
  const hace5 = new Date(Date.now() - 5 * 86400_000).toISOString();
  const ins = (ext, nombre, tel, cuando) => {
    guardarProspecto({ fuente: "denue", externo_id: ext, nombre, rubro: "Barberías", ciudad: "Torreón", telefono: tel });
    const id = getDb().prepare("SELECT id FROM prospectos WHERE externo_id = ?").get(ext).id;
    getDb().prepare("UPDATE prospectos SET estado = 'enviado', envios = 1, ultimo_envio = ?, whatsapp_texto = 'hola' WHERE id = ?").run(cuando, id);
    return id;
  };
  const a = ins("s1", "Barbería Uno", "8711111111", hace5);
  ins("s2", "Barbería Dos (por correo)", "8712222222", hace5);
  const c = ins("s3", "Barbería Tres (reciente)", "8713333333", new Date().toISOString());
  for (const id of [a, c]) logEvent("prospecto_whatsapp", null, { prospecto: Number(id), telefono: "x" });
  const ids = seguimientosPendientesWa().map((p) => p.id);
  assert.deepEqual(ids, [Number(a)]);
  assert.match(textoSeguimiento({ nombre: "Barbería Uno", rubro: "Barberías" }), /no les vuelvo a escribir/);
});

test("sin correo configurado, el seguimiento de correo no toca a los de WhatsApp", async () => {
  assert.equal(await prepararSeguimientos(), 0);
  assert.equal(getDb().prepare("SELECT estado FROM prospectos WHERE externo_id = 's1'").get().estado, "enviado");
});

test("sin video cargado, el agente no intenta mandarlo y el primer mensaje sigue siendo texto", async () => {
  const { videoPresentacion } = await import("../src/channels/wa-web.js");
  const { executeTool } = await import("../src/agent/tools.js");
  const { getNegocio } = await import("../src/config.js");
  const { getProspeccion } = await import("../src/prospeccion/config.js");
  const envio = getProspeccion().envio;
  const original = envio.video_presentacion;
  assert.match(String(videoPresentacion()), /presentacion\.mp4$/, "el video del repo se reconoce");
  envio.video_presentacion = "public/no-existe.mp4";
  after(() => (envio.video_presentacion = original));
  assert.equal(videoPresentacion(), null);
  const conv = { id: "wa:8711111111", canal: "wa", externo_id: "8711111111" };
  const r = await executeTool("enviar_video_presentacion", {}, { convId: conv.id, canal: "wa", conv, negocio: getNegocio() });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /portafolio/);
});
