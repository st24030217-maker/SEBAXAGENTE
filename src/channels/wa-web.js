// WhatsApp con un chip aparte, conectado como "dispositivo vinculado" (igual que WhatsApp Web).
// - Se vincula una vez escaneando un QR desde el panel. La sesión queda en data/whatsapp-sesion.
// - Envía los mensajes de prospección aprobados, con límites y pausas para cuidar el número.
// - Cuando alguien escribe, el agente conversa, resuelve dudas y agenda la cita.
// Nota: esto no usa la API oficial de Meta. Para no arriesgar el chip: pocos mensajes al día,
// espaciados, solo en horario laboral, personalizados y respetando a quien pide "BAJA".
import fs from "node:fs";
import path from "node:path";
import QRCode from "qrcode";
import pino from "pino";
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } from "baileys";
import { settings, ROOT } from "../config.js";
import { getDb, now, logEvent, getOrCreateConversation, loadHistory, upsertLead, setBotActive, addTranscript } from "../db.js";
import { handleIncoming, recordOutgoing, MENSAJE_ERROR } from "../agent/agent.js";
import { notifyOwner } from "../services/notify.js";
import { getProspeccion } from "../prospeccion/config.js";
import { dentroDeHorarioEnvio } from "../prospeccion/servicio.js";
import { iaDisponible } from "../ia/proveedor.js";

const CARPETA = path.join(path.dirname(settings.dbPath === ":memory:" ? path.join(ROOT, "data", "x") : settings.dbPath), "whatsapp-sesion");
const db = () => getDb();
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const azar = (a, b) => a + Math.random() * (b - a);

let sock = null;
let estado = "apagado"; // apagado | conectando | esperando_qr | conectado
let qrActual = null;
let numero = null;
let reintentos = 0;

export const waActivo = () => !/^(0|false|no)$/i.test(process.env.WHATSAPP_CHIP ?? "true");
export const waConectado = () => estado === "conectado" && !!sock;

function asegurarTablas() {
  db().exec(`CREATE TABLE IF NOT EXISTS wa_contactos (id TEXT PRIMARY KEY, jid TEXT NOT NULL, actualizado TEXT NOT NULL);`);
}

/** Últimos 10 dígitos (número mexicano sin lada de país). */
export const diezDigitos = (s) => String(s || "").replace(/\D/g, "").slice(-10);

export const esBaja = (t) => /^\s*(baja|alto|stop|no me (vuelvas a |vuelvan a )?escrib|no me interesa,? gracias$|ya no me (escribas|manden))/i.test(String(t || "").trim());

// ---------- Conexión ----------

export async function startWaWeb() {
  if (!waActivo()) return;
  asegurarTablas();
  fs.mkdirSync(CARPETA, { recursive: true });
  await conectar();
  // Cola de envío de prospección: revisa cada minuto si toca mandar el siguiente.
  setInterval(() => enviarSiguienteWa().catch((e) => console.error("[whatsapp] cola:", e.message)), 60_000);
}

async function conectar() {
  estado = "conectando";
  const { state, saveCreds } = await useMultiFileAuthState(CARPETA);
  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {}
  sock = makeWASocket({
    auth: state,
    ...(version ? { version } : {}),
    logger: pino({ level: "silent" }),
    browser: Browsers.macOS("Agente Sebax"),
    markOnlineOnConnect: false, // para que tu celular siga recibiendo notificaciones
    syncFullHistory: false,
  });
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", async (u) => {
    if (u.qr) {
      estado = "esperando_qr";
      qrActual = await QRCode.toDataURL(u.qr, { margin: 1, width: 320 });
    }
    if (u.connection === "open") {
      estado = "conectado";
      qrActual = null;
      reintentos = 0;
      numero = diezDigitos(sock.user?.id?.split(":")[0]);
      console.log(`[whatsapp] conectado como ${numero}`);
      logEvent("whatsapp_conectado", null, { numero });
    }
    if (u.connection === "close") {
      const codigo = u.lastDisconnect?.error?.output?.statusCode;
      sock = null;
      if (codigo === DisconnectReason.loggedOut) {
        // Se desvinculó desde el celular: se borra la sesión y se pide un QR nuevo.
        estado = "apagado";
        numero = null;
        fs.rmSync(CARPETA, { recursive: true, force: true });
        fs.mkdirSync(CARPETA, { recursive: true });
        notifyOwner("error", "El chip de WhatsApp se desvinculó. Entra al panel y escanea el QR otra vez.");
      }
      reintentos++;
      const pausa = Math.min(60_000, 3000 * reintentos);
      setTimeout(() => conectar().catch((e) => console.error("[whatsapp] reconexión:", e.message)), pausa);
    }
  });
  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) recibir(m).catch((e) => console.error("[whatsapp] mensaje:", e.message));
  });
}

export const numeroChip = () => diezDigitos(process.env.WA_NUMERO || "");

export async function estadoWa() {
  return { activo: waActivo(), estado, qr: qrActual, numero, numeroChip: numeroChip() || null };
}

/**
 * Vinculación con código de 8 caracteres (alternativa al QR): en el celular del chip se elige
 * "Vincular con número de teléfono" y se escribe el código.
 */
export async function pedirCodigoVinculacion(tel10 = numeroChip()) {
  const tel = diezDigitos(tel10);
  if (!/^\d{10}$/.test(tel)) throw new Error("Escribe el número del chip a 10 dígitos (WA_NUMERO en .env).");
  if (estado === "conectado") throw new Error("El chip ya está vinculado.");
  if (!sock) throw new Error("Todavía se está preparando la conexión; intenta en unos segundos.");
  const codigo = await sock.requestPairingCode(`52${tel}`);
  return { codigo: String(codigo).replace(/^(.{4})(.{4})$/, "$1-$2"), numero: tel };
}

export async function desconectarWa() {
  try {
    await sock?.logout();
  } catch {}
}

// ---------- Recibir y conversar ----------

/** Identidad del contacto: su número (10 dígitos) si WhatsApp lo da; si no, su id interno. */
function contactoDe(m) {
  const k = m.key || {};
  const candidatos = [k.remoteJid, k.remoteJidAlt, k.senderPn, k.participant].filter(Boolean);
  const pn = candidatos.find((j) => j.endsWith("@s.whatsapp.net"));
  const jid = k.remoteJid;
  return { id: pn ? diezDigitos(pn) : jid, jid };
}

const textoDe = (m) =>
  m.message?.conversation ||
  m.message?.extendedTextMessage?.text ||
  m.message?.imageMessage?.caption ||
  m.message?.videoMessage?.caption ||
  m.message?.ephemeralMessage?.message?.conversation ||
  m.message?.ephemeralMessage?.message?.extendedTextMessage?.text ||
  "";

// Si el cliente manda varios mensajes seguidos, se espera a que termine y se responde una vez.
const pendientes = new Map();

async function recibir(m) {
  const jid = m.key?.remoteJid || "";
  if (m.key?.fromMe || !jid || jid.endsWith("@g.us") || jid === "status@broadcast" || jid.endsWith("@newsletter")) return;
  const { id } = contactoDe(m);
  db().prepare("INSERT INTO wa_contactos (id, jid, actualizado) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET jid = excluded.jid, actualizado = excluded.actualizado").run(id, jid, now());
  let texto = textoDe(m).trim();
  if (!texto) {
    if (m.message?.audioMessage) texto = "[El cliente mandó un audio que no puedes escuchar. Pídele amablemente que lo escriba.]";
    else if (m.message) texto = "[El cliente mandó una imagen, sticker o archivo sin texto. Pídele que te lo describa por escrito.]";
    else return;
  }
  const p = pendientes.get(id) || { textos: [], nombre: m.pushName || null, timer: null };
  p.textos.push(texto);
  clearTimeout(p.timer);
  p.timer = setTimeout(() => {
    pendientes.delete(id);
    procesarMensaje({ id, jid, texto: p.textos.join("\n"), nombre: p.nombre }).catch((e) => {
      console.error(`[whatsapp] ${id}:`, e.message);
      notifyOwner("error", `No se pudo responder el WhatsApp de ${p.nombre || id}: ${e.message}`);
    });
  }, Number(process.env.WA_ESPERA_MS || 7000));
  pendientes.set(id, p);
}

/** Lógica de un mensaje entrante (separada de la conexión para poder probarla). */
export async function procesarMensaje({ id, jid, texto, nombre }, enviar = enviarTexto) {
  const tel = /^\d{10}$/.test(id) ? id : null;
  const prospecto = tel ? db().prepare("SELECT * FROM prospectos WHERE telefono = ? ORDER BY id DESC LIMIT 1").get(tel) : null;
  const convId = `wa:${id}`;

  if (esBaja(texto)) {
    if (prospecto) db().prepare("UPDATE prospectos SET estado = 'no_contactar', actualizado = ? WHERE id = ?").run(now(), prospecto.id);
    const c = getOrCreateConversation("wa", id, nombre);
    addTranscript(c.id, "cliente", texto);
    setBotActive(c.id, false);
    await enviar(jid, "Entendido, no te volveremos a escribir. Que tengas excelente día.");
    logEvent("prospecto_baja", c.id, { via: "whatsapp" });
    return "baja";
  }

  const c = getOrCreateConversation("wa", id, nombre || prospecto?.nombre || null);
  if (prospecto && loadHistory(c.id).length === 0) {
    const razones = (() => { try { return JSON.parse(prospecto.razones || "[]").join(", "); } catch { return ""; } })();
    if (prospecto.envios > 0 && prospecto.whatsapp_texto) {
      await recordOutgoing(
        c.id,
        prospecto.whatsapp_texto,
        "agente",
        `[Prospección] Le escribimos primero a este negocio (${prospecto.nombre}, ${prospecto.giro || prospecto.rubro || ""}, ${[prospecto.colonia, prospecto.ciudad].filter(Boolean).join(", ")}). Situación detectada: ${razones}. Este fue el mensaje de WhatsApp que se le envió y ahora está respondiendo`
      );
    }
    upsertLead(c.id, { empresa: prospecto.nombre, telefono: tel, email: prospecto.email || undefined, necesidad: `Prospecto ${prospecto.rubro || ""}: ${razones}`.slice(0, 300), etapa: "interesado" });
    if (["enviado", "whatsapp", "aprobado", "por_revisar"].includes(prospecto.estado)) {
      db().prepare("UPDATE prospectos SET estado = 'respondio', actualizado = ? WHERE id = ?").run(now(), prospecto.id);
    }
    notifyOwner("lead_nuevo", `${prospecto.nombre} respondió por WhatsApp: "${texto.slice(0, 160)}"`, { prospecto: prospecto.id, telefono: tel });
  }

  if (!iaDisponible()) {
    addTranscript(c.id, "cliente", texto);
    notifyOwner("derivacion", `${nombre || id} te escribió por WhatsApp y no hay IA configurada para responder.`, { id });
    return "sin_ia";
  }
  const { respuesta } = await handleIncoming({ canal: "wa", externoId: id, texto, nombre });
  if (!respuesta) return "pausado";
  if (respuesta === MENSAJE_ERROR) {
    notifyOwner("error", `El agente no pudo responder el WhatsApp de ${nombre || id}. Revisa la conversación en el panel.`, { id });
    return "error_ia";
  }
  await enviar(jid, respuesta);
  return "respondido";
}

/** Envía texto simulando que se escribe (pausa proporcional al largo). */
async function enviarTexto(jid, texto) {
  if (!waConectado()) throw new Error("El chip de WhatsApp no está conectado");
  try {
    await sock.presenceSubscribe(jid);
    await sock.sendPresenceUpdate("composing", jid);
  } catch {}
  await espera(Math.min(9000, 1200 + texto.length * 35));
  await sock.sendMessage(jid, { text: texto });
  try {
    await sock.sendPresenceUpdate("paused", jid);
  } catch {}
}

/** Para sendToChannel (mensajes del panel, seguimientos, recordatorios de cita). */
export async function sendWaWeb(id, texto) {
  const fila = db().prepare("SELECT jid FROM wa_contactos WHERE id = ?").get(String(id));
  let jid = fila?.jid;
  if (!jid && /^\d{10}$/.test(String(id))) jid = await resolverJid(id);
  if (!jid) throw new Error("No se encontró el chat de WhatsApp de este contacto");
  await enviarTexto(jid, texto);
}

/** Busca si el número tiene WhatsApp y devuelve su id (o null si es fijo / no usa WhatsApp). */
async function resolverJid(tel10) {
  const [r] = (await sock.onWhatsApp(`52${tel10}`)) || [];
  return r?.exists ? r.jid : null;
}

// ---------- Cola de prospección ----------

export function enviadosWaHoy(ahora = new Date()) {
  const desde = new Date(ahora.getTime() - 24 * 3600_000).toISOString();
  return db().prepare("SELECT COUNT(*) n FROM eventos WHERE tipo = 'prospecto_whatsapp' AND creado >= ?").get(desde).n;
}

/**
 * Límite de hoy con calentamiento: arranca en whatsapp_limite_diario y sube whatsapp_subir_por_semana
 * cada semana desde el primer envío, hasta whatsapp_limite_maximo. Si en los últimos 7 días al menos
 * el 15 % de los contactados pidió BAJA, se frena en el límite inicial (señal de que molesta).
 */
export function limiteWaHoy(ahora = new Date()) {
  const e = getProspeccion().envio;
  const base = Number(e.whatsapp_limite_diario) || 0;
  const paso = Number(e.whatsapp_subir_por_semana) || 0;
  const maximo = Math.max(base, Number(e.whatsapp_limite_maximo) || base);
  const primero = db().prepare("SELECT MIN(creado) t FROM eventos WHERE tipo = 'prospecto_whatsapp'").get().t;
  const semanas = primero ? Math.max(0, Math.floor((ahora - new Date(primero)) / (7 * 86400_000))) : 0;
  const hace7 = new Date(ahora.getTime() - 7 * 86400_000).toISOString();
  const enviados7 = db().prepare("SELECT COUNT(*) n FROM eventos WHERE tipo = 'prospecto_whatsapp' AND creado >= ?").get(hace7).n;
  const bajas7 = db().prepare("SELECT COUNT(*) n FROM eventos WHERE tipo = 'prospecto_baja' AND creado >= ?").get(hace7).n;
  const frenado = enviados7 >= 10 && bajas7 / enviados7 >= 0.15;
  const limite = frenado ? base : Math.min(maximo, base + semanas * paso);
  return { limite, base, maximo, paso, semanas, frenado, bajas7, enviados7 };
}

let enviando = false;
let proximoEnvio = 0;

/** Manda UN mensaje de prospección si toca (horario, límite diario y pausa al azar entre mensajes). */
export async function enviarSiguienteWa(ahora = new Date()) {
  if (enviando || !waConectado()) return null;
  const cfg = getProspeccion();
  const e = cfg.envio;
  if (!dentroDeHorarioEnvio(cfg, ahora) || Date.now() < proximoEnvio) return null;
  // La pausa mínima se respeta aunque el agente se haya reiniciado (se mide desde el último envío guardado).
  const ultimo = db().prepare("SELECT MAX(creado) t FROM eventos WHERE tipo = 'prospecto_whatsapp'").get().t;
  if (ultimo && Date.now() - new Date(ultimo).getTime() < e.whatsapp_minutos_min * 60_000) return null;
  if (enviadosWaHoy(ahora) >= limiteWaHoy(ahora).limite) return null;
  enviando = true;
  try {
    // Hasta 3 intentos por vuelta: los teléfonos fijos sin WhatsApp se saltan sin gastar el turno.
    for (let i = 0; i < 3; i++) {
      let p = db()
        .prepare("SELECT * FROM prospectos WHERE estado = 'aprobado' AND IFNULL(telefono,'') != '' AND fuente != 'ejemplo' ORDER BY puntaje DESC, id LIMIT 1")
        .get();
      // Modo automático: si no hay nada aprobado, el agente elige solo al mejor prospecto pendiente.
      const umbral = Number(cfg.automatico.aprobar_solos_desde_puntaje || 0);
      if (!p && umbral > 0) {
        // Va alternando rubros: primero el rubro al que hace más tiempo no se le escribe (o nunca),
        // y dentro de él, el de mejor puntaje. Así no le escribe solo a restaurantes.
        p = db()
          .prepare(
            `SELECT p.* FROM prospectos p
             LEFT JOIN (SELECT rubro, MAX(ultimo_envio) u FROM prospectos WHERE envios > 0 GROUP BY rubro) s ON s.rubro = p.rubro
             WHERE p.estado = 'por_revisar' AND p.puntaje >= ? AND IFNULL(p.telefono,'') != '' AND IFNULL(p.whatsapp_texto,'') != '' AND p.fuente != 'ejemplo'
             ORDER BY IFNULL(s.u, '') ASC, p.puntaje DESC, p.id LIMIT 1`
          )
          .get(umbral);
        if (p) {
          db().prepare("UPDATE prospectos SET estado = 'aprobado', notas = TRIM(COALESCE(notas,'') || char(10) || 'Aprobado automáticamente por puntaje') WHERE id = ?").run(p.id);
          logEvent("prospecto_autoaprobado", null, { prospecto: p.id, puntaje: p.puntaje });
        }
      }
      if (!p) return null;
      const jid = await resolverJid(p.telefono);
      if (!jid) {
        db().prepare("UPDATE prospectos SET estado = 'fallido', error = ?, actualizado = ? WHERE id = ?").run("Ese número no tiene WhatsApp (puede ser teléfono fijo)", now(), p.id);
        await espera(azar(4000, 9000));
        continue;
      }
      db().prepare("UPDATE prospectos SET estado = 'enviado', envios = envios + 1, ultimo_envio = ?, actualizado = ? WHERE id = ?").run(now(), now(), p.id);
      try {
        await enviarTexto(jid, p.whatsapp_texto);
        db().prepare("INSERT INTO wa_contactos (id, jid, actualizado) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET jid = excluded.jid").run(p.telefono, jid, now());
        logEvent("prospecto_whatsapp", null, { prospecto: p.id, telefono: p.telefono });
        console.log(`[whatsapp] prospección enviada a ${p.nombre}`);
      } catch (err) {
        db().prepare("UPDATE prospectos SET estado = 'fallido', envios = envios - 1, error = ? WHERE id = ?").run(err.message, p.id);
      }
      proximoEnvio = Date.now() + azar(e.whatsapp_minutos_min, e.whatsapp_minutos_max) * 60_000;
      return p.id;
    }
    return null;
  } finally {
    enviando = false;
  }
}
