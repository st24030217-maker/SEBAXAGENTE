// Tests del canal de WhatsApp con chip (no se conecta a WhatsApp ni a ninguna IA):  npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.ANTHROPIC_API_KEY = "";
process.env.GEMINI_API_KEY = "";
process.env.SMTP_USER = "";
process.env.OWNER_WEBHOOK_URL = "";

const { openDb, getDb, getConversation, getLead } = await import("../src/db.js");
const { procesarMensaje, esBaja, esRespuestaAutomatica, esRespuestaInstantanea, diezDigitos, numeroDueno, seguimientosPendientesWa, textoSeguimiento, conPortafolio } = await import("../src/channels/wa-web.js");
const { logEvent } = await import("../src/db.js");
const { prepararSeguimientos } = await import("../src/prospeccion/servicio.js");
const { guardarProspecto } = await import("../src/prospeccion/servicio.js");
const { getProspeccion } = await import("../src/prospeccion/config.js");

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
  // La prueba fija sus 4 días: no depende de cómo esté hoy config/prospeccion.yaml (puede estar en 0).
  const envio = getProspeccion().envio, antes = envio.dias_para_seguimiento;
  envio.dias_para_seguimiento = 4;
  let ids;
  try { ids = seguimientosPendientesWa().map((p) => p.id); } finally { envio.dias_para_seguimiento = antes; }
  assert.deepEqual(ids, [Number(a)]);
  envio.dias_para_seguimiento = 0;
  try { assert.deepEqual(seguimientosPendientesWa(), [], "en 0 no hay seguimientos"); } finally { envio.dias_para_seguimiento = antes; }
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

test("video de proyectos: se reconoce el del repo, solo por WhatsApp y nunca dos veces al mismo cliente", async () => {
  const { videoProyectos } = await import("../src/channels/wa-web.js");
  const { executeTool } = await import("../src/agent/tools.js");
  const { getNegocio } = await import("../src/config.js");
  assert.match(String(videoProyectos()), /proyectos\.mp4$/);
  const conv = { id: "wa:8712222222", canal: "wa", externo_id: "8712222222" };
  const web = await executeTool("enviar_video_proyectos", {}, { convId: "web:x", canal: "web", conv, negocio: getNegocio() });
  assert.equal(web.ok, false);
  logEvent("video_proyectos_enviado", conv.id, {});
  const r = await executeTool("enviar_video_proyectos", {}, { convId: conv.id, canal: "wa", conv, negocio: getNegocio() });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /ya recibió/);
});

test("detecta respuestas automáticas de WhatsApp Business y no confunde a personas", () => {
  for (const t of [
    "Hola, gracias por comunicarte a Loncheria Mingo. Nuestro horario de servicio es de 1 de la tarde a 12 de la noche todos los días ⏱️ . En cuanto retomemos nuestro servicio con gusto te atenderemos.",
    "Gracias por comunicarte a Consultoría Integral En Seguros Y Fianzas. ¿Cómo podemos ayudarte? 😃",
    "Gracias por comunicarte con M&M Álvarez Agente De Seguros Y De Fianzas. Por favor, haznos saber cómo podemos ayudarte.",
    "En este momento estamos fuera de horario, te responderemos pronto.",
    "* Agradecemos su preferencia. \nCon el fin de poder brindarle atención especializada, no realizamos consultas vía WhatsApp ni por nuestras redes sociales.",
    "Le recordamos que está cuenta es manejada por personal administrativo, con el fin de realizar agenda de citas.",
    "¡Hola! Bienvenido(a) a Gorditas Atotonilco. Únicamente atendemos pedidos por llamada telefónica.",
  ]) assert.equal(esRespuestaAutomatica(t), true, t);
  for (const t of [
    "Lo comparto a Gerencia",
    "Gracias pero no me interesa joven",
    "Gracias , por tenernos en cuenta , como le comento ya tenemos quien maneje nuestra publicidad",
    "Esta bien el jueves a las 9",
    "¿Cuál es su horario para pasar?",
    "Agradecemos mucho, pero por ahora no",
  ]) assert.equal(esRespuestaAutomatica(t), false, t);
});

test("un texto largo que llega segundos después de nuestro mensaje es respuesta automática", () => {
  const largo = "Por su bienestar le recordamos que todas las valoraciones requieren una valoración médica en consultorio.";
  assert.equal(esRespuestaInstantanea(largo, 0.14), true);
  assert.equal(esRespuestaInstantanea(largo, 90), false); // ya le dio tiempo de leer y escribir
  assert.equal(esRespuestaInstantanea("Ok", 2), false); // corto: una persona sí contesta así de rápido
  assert.equal(esRespuestaInstantanea(largo, 3, true), false); // venía platicando: pudo estar escribiendo
  assert.equal(esRespuestaInstantanea(largo, null), false); // nunca le escribimos
});

test("el primer mensaje siempre lleva el portafolio, antes de la pregunta final y sin repetirlo", () => {
  const url = getProspeccion().remitente.portafolio;
  const conMuestra = "Hola, buen día. Soy Sebastián.\n\nLes preparé una muestra:\nhttps://x.io/m/abc\n\n¿Qué les parece?";
  const r = conPortafolio(conMuestra);
  assert.ok(r.includes(url));
  assert.ok(r.indexOf(url) < r.indexOf("¿Qué les parece?"));
  assert.ok(r.trimEnd().endsWith("¿Qué les parece?"));
  assert.equal(conPortafolio(r), r);
  assert.ok(conPortafolio("Hola, soy Sebastián.").endsWith(url));
});
