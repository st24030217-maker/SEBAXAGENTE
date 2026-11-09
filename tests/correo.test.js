// Tests del canal de correo (no se conecta a Gmail ni a Claude):  npm test
import { test, before } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
// Vacías (no borradas): así el .env real no las rellena y las pruebas nunca llaman a una IA.
process.env.ANTHROPIC_API_KEY = "";
process.env.ANTHROPIC_AUTH_TOKEN = "";
process.env.GEMINI_API_KEY = "";
process.env.SMTP_USER = "";

const { openDb, getDb, getConversation, getLead } = await import("../src/db.js");
const { limpiarRespuesta, esBaja, procesarCorreo } = await import("../src/channels/email.js");
const { guardarProspecto } = await import("../src/prospeccion/servicio.js");

before(() => {
  openDb(":memory:");
  getDb().exec(`CREATE TABLE IF NOT EXISTS correos_procesados (message_id TEXT PRIMARY KEY, creado TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS correo_hilos (email TEXT PRIMARY KEY, asunto TEXT, message_id TEXT, referencias TEXT, actualizado TEXT NOT NULL);`);
  guardarProspecto({ fuente: "denue", externo_id: "1", nombre: "Barbería Ruiz", rubro: "Barberías", ciudad: "Torreón", email: "ruiz@negocio.mx", telefono: "8711111111" });
  guardarProspecto({ fuente: "denue", externo_id: "2", nombre: "Tacos Pepe", rubro: "Taquerías y comida", ciudad: "Lerdo", email: "pepe@negocio.mx" });
  getDb().prepare("UPDATE prospectos SET estado = 'enviado', asunto = 'Barbería Ruiz en internet', correo = 'Hola...'").run();
});

test("quita la parte citada de una respuesta de Gmail", () => {
  const t = "Sí me interesa, ¿cuánto cuesta?\n\nEl lun, 9 nov 2026 a las 10:00, Sebastián <x@y.com> escribió:\n> Hola, equipo de...";
  assert.equal(limpiarRespuesta(t), "Sí me interesa, ¿cuánto cuesta?");
  assert.equal(limpiarRespuesta("Ok\n\nOn Mon, Nov 9 Sebastián wrote:\n> hi"), "Ok");
  assert.equal(limpiarRespuesta("Va\nEnviado desde mi iPhone"), "Va");
});

test("detecta pedidos de baja", () => {
  assert.ok(esBaja("BAJA"));
  assert.ok(esBaja("baja por favor"));
  assert.ok(!esBaja("Me interesa, pero ¿bajan el precio?"));
});

test("ignora correos de quien no es prospecto (tus correos personales)", async () => {
  assert.equal(await procesarCorreo({ de: "mama@gmail.com", asunto: "Hola", texto: "¿Vienes a comer?", messageId: "<a@x>" }), "ignorado");
  assert.equal(getConversation("email:mama@gmail.com"), undefined);
});

test("una respuesta de prospecto abre conversación, crea lead y lo marca como respondió", async () => {
  const r = await procesarCorreo({ de: "Ruiz@Negocio.mx", nombre: "Juan Ruiz", asunto: "Re: Barbería Ruiz en internet", texto: "Sí me interesa\n\n> cita", messageId: "<b@x>" });
  assert.equal(r, "sin_ia"); // sin API key no contesta solo; queda registrado para Sebastián
  const conv = getConversation("email:ruiz@negocio.mx");
  assert.ok(conv);
  assert.equal(getLead(conv.id).empresa, "Barbería Ruiz");
  assert.equal(getDb().prepare("SELECT estado FROM prospectos WHERE email = 'ruiz@negocio.mx'").get().estado, "respondio");
  const msgs = getDb().prepare("SELECT rol, texto FROM mensajes WHERE conversacion_id = ?").all(conv.id);
  assert.ok(msgs.some((m) => m.rol === "cliente" && m.texto === "Sí me interesa"));
});

test("si responde BAJA, no se le contesta y queda bloqueado", async () => {
  assert.equal(await procesarCorreo({ de: "pepe@negocio.mx", asunto: "Re: hola", texto: "BAJA", messageId: "<c@x>" }), "baja");
  assert.equal(getDb().prepare("SELECT estado FROM prospectos WHERE email = 'pepe@negocio.mx'").get().estado, "no_contactar");
  assert.equal(await procesarCorreo({ de: "pepe@negocio.mx", asunto: "Re: hola", texto: "otra vez", messageId: "<d@x>" }), "baja_previa");
});
