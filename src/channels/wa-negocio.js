// WhatsApp de cada negocio cliente: su propio chip vinculado (como WhatsApp Web), su sesión en
// data/negocios/<slug>/whatsapp-sesion y su agente. Aquí NO hay prospección: solo se atiende a los
// clientes que le escriben al negocio y se le avisa al dueño (citas, pedidos, clientes nuevos).
// Todo corre dentro de conNegocio(n, ...) para que use la base y la configuración de ese negocio.
import fs from "node:fs";
import path from "node:path";
import QRCode from "qrcode";
import pino from "pino";
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } from "baileys";
import { conNegocio } from "../contexto.js";
import { getDb, now, logEvent, getOrCreateConversation, loadHistory, addTranscript } from "../db.js";
import { handleIncoming, MENSAJE_ERROR } from "../agent/agent.js";
import { notifyOwner } from "../services/notify.js";
import { iaDisponible } from "../ia/proveedor.js";
import { diezDigitos, contactoDe, textoDe, waActivo } from "./wa-web.js";

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const VENTANA_VINCULAR = 5 * 60_000; // sin sesión, el QR se ofrece 5 min después de abrir el panel

const instancias = new Map(); // slug -> estado de su conexión

function inst(n) {
  let i = instancias.get(n.slug);
  if (!i) {
    i = { sock: null, estado: "apagado", qr: null, numero: null, reintentos: 0, apagando: false, pedidoEn: 0, pendientes: new Map(), jidDueno: null };
    instancias.set(n.slug, i);
  }
  return i;
}

const tieneSesion = (n) => fs.existsSync(path.join(n.sesionDir, "creds.json"));
const conectado = (i) => i.estado === "conectado" && !!i.sock;

/** Al arrancar: reconecta los negocios que ya tienen su chip vinculado. */
export async function iniciarWaNegocios(negocios) {
  if (!waActivo()) return;
  for (const n of negocios) {
    if (n.meta.activo === false || !tieneSesion(n)) continue;
    conectar(n).catch((e) => console.error(`[wa ${n.slug}]`, e.message));
    await espera(1500); // escalonado: no abrir todas las conexiones en el mismo segundo
  }
}

async function conectar(n) {
  const i = inst(n);
  if (i.sock || i.apagando || n.meta.activo === false) return;
  i.estado = "conectando";
  fs.mkdirSync(n.sesionDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(n.sesionDir);
  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {}
  const sock = makeWASocket({
    auth: state,
    ...(version ? { version } : {}),
    logger: pino({ level: "silent" }),
    browser: Browsers.macOS(`Agente ${n.meta.nombre}`.slice(0, 40)),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  i.sock = sock;
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", (u) =>
    conNegocio(n, async () => {
      if (u.qr) {
        i.estado = "esperando_qr";
        i.qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 320 });
      }
      if (u.connection === "open") {
        i.estado = "conectado";
        i.qr = null;
        i.reintentos = 0;
        i.numero = diezDigitos(sock.user?.id?.split(":")[0]);
        console.log(`[wa ${n.slug}] conectado como ${i.numero}`);
        logEvent("whatsapp_conectado", null, { numero: i.numero });
      }
      if (u.connection === "close") {
        const codigo = u.lastDisconnect?.error?.output?.statusCode;
        if (i.sock === sock) i.sock = null;
        if (i.apagando || n.meta.activo === false) {
          i.estado = "apagado";
          return;
        }
        if (codigo === DisconnectReason.loggedOut) {
          // Lo desvincularon desde el celular: se borra la sesión; el dueño vuelve a escanear desde su panel.
          i.estado = "apagado";
          i.numero = null;
          i.jidDueno = null;
          fs.rmSync(n.sesionDir, { recursive: true, force: true });
          logEvent("whatsapp_desvinculado", null, {});
          return;
        }
        // Sin sesión y nadie mirando el QR: se deja de intentar (se reanuda al abrir el panel).
        if (!tieneSesion(n) && Date.now() - i.pedidoEn > VENTANA_VINCULAR) {
          i.estado = "apagado";
          i.qr = null;
          return;
        }
        i.estado = "conectando";
        i.reintentos++;
        setTimeout(() => conectar(n).catch((e) => console.error(`[wa ${n.slug}] reconexión:`, e.message)), Math.min(60_000, 3000 * i.reintentos));
      }
    })
  );
  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) conNegocio(n, () => recibir(n, m)).catch((e) => console.error(`[wa ${n.slug}] mensaje:`, e.message));
  });
}

/** Estado para el panel. Abrir la sección de WhatsApp enciende la conexión para poder mostrar el QR. */
export function estadoWaNegocio(n, { arrancar = false } = {}) {
  const i = inst(n);
  if (arrancar && waActivo() && n.meta.activo !== false) {
    i.pedidoEn = Date.now();
    if (!i.sock && !i.apagando) conectar(n).catch((e) => console.error(`[wa ${n.slug}]`, e.message));
  }
  return { activo: waActivo(), estado: i.estado, qr: i.qr, numero: i.numero, dueno: n.meta.dueno || null };
}

/** Vinculación con código de 8 caracteres (si el panel está abierto en el mismo celular del chip). */
export async function codigoWaNegocio(n, tel10) {
  const i = inst(n);
  const tel = diezDigitos(tel10);
  if (!/^\d{10}$/.test(tel)) throw new Error("Escribe el número del chip a 10 dígitos.");
  if (conectado(i)) throw new Error("El chip ya está vinculado.");
  estadoWaNegocio(n, { arrancar: true });
  for (let k = 0; k < 10 && !i.sock; k++) await espera(500);
  if (!i.sock) throw new Error("Todavía se está preparando la conexión; intenta en unos segundos.");
  const codigo = await i.sock.requestPairingCode(`52${tel}`);
  return { codigo: String(codigo).replace(/^(.{4})(.{4})$/, "$1-$2"), numero: tel };
}

export async function desconectarWaNegocio(n) {
  const i = inst(n);
  try {
    await i.sock?.logout();
  } catch {}
  try {
    i.sock?.end?.(new Error("desconectado"));
  } catch {}
  i.sock = null;
  i.qr = null;
  i.estado = "apagado";
  i.numero = null;
  i.jidDueno = null;
  fs.rmSync(n.sesionDir, { recursive: true, force: true });
}

/** Apagado limpio de todos los chips (sin desvincularlos), antes de reiniciar. */
export function detenerWaNegocios() {
  for (const i of instancias.values()) {
    i.apagando = true;
    i.estado = "apagado";
    try {
      i.sock?.end?.(new Error("apagando"));
    } catch {}
    i.sock = null;
  }
}

// ---------- Recibir y conversar ----------

async function recibir(n, m) {
  const jid = m.key?.remoteJid || "";
  if (m.key?.fromMe || !jid || jid.endsWith("@g.us") || jid === "status@broadcast" || jid.endsWith("@newsletter")) return;
  const { id } = contactoDe(m);
  getDb()
    .prepare("INSERT INTO wa_contactos (id, jid, actualizado) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET jid = excluded.jid, actualizado = excluded.actualizado")
    .run(id, jid, now());
  let texto = textoDe(m).trim();
  if (!texto) {
    if (m.message?.audioMessage) texto = "[El cliente mandó un audio que no puedes escuchar. Pídele amablemente que lo escriba.]";
    else if (m.message) texto = "[El cliente mandó una imagen, sticker o archivo sin texto. Pídele que te lo describa por escrito.]";
    else return;
  }
  // Si el cliente manda varios mensajes seguidos, se espera a que termine y se responde una vez.
  const i = inst(n);
  const p = i.pendientes.get(id) || { textos: [], nombre: m.pushName || null, timer: null };
  p.textos.push(texto);
  clearTimeout(p.timer);
  p.timer = setTimeout(() => {
    i.pendientes.delete(id);
    conNegocio(n, () =>
      procesarMensajeNegocio(n, { id, jid, texto: p.textos.join("\n"), nombre: p.nombre }).catch((e) => {
        console.error(`[wa ${n.slug}] ${id}:`, e.message);
        notifyOwner("error", `No se pudo responder el WhatsApp de ${p.nombre || id}: ${e.message}`);
      })
    );
  }, Number(process.env.WA_ESPERA_MS || 7000));
  i.pendientes.set(id, p);
}

/** Lógica de un mensaje entrante de un cliente del negocio (separada de la conexión para probarla). */
export async function procesarMensajeNegocio(n, { id, jid, texto, nombre }, enviar = (j, t) => enviarTexto(n, j, t)) {
  const tel = /^\d{10}$/.test(id) ? id : null;
  // El dueño escribiéndole a su propio chip (por ejemplo, contestando un aviso) no es un cliente.
  if (tel && tel === n.meta.dueno) return "dueno";
  const c = getOrCreateConversation("wa", id, nombre);
  if (loadHistory(c.id).length === 0) {
    notifyOwner("lead_nuevo", `${nombre || "Alguien nuevo"}${tel ? ` (tel. ${tel})` : ""} escribió: "${texto.slice(0, 160)}"\nEl agente ya le está contestando.`, { id });
  }
  if (!iaDisponible()) {
    addTranscript(c.id, "cliente", texto);
    notifyOwner("derivacion", `${nombre || id} te escribió por WhatsApp y el agente no está disponible para responder. Contéstale tú.`, { id });
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

// ---------- Enviar ----------

async function enviarTexto(n, jid, texto) {
  const i = inst(n);
  if (!conectado(i)) throw new Error(`El WhatsApp de ${n.meta.nombre} no está conectado`);
  const sock = i.sock;
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

async function resolverJid(n, tel10) {
  const i = inst(n);
  if (!conectado(i)) return null;
  const [r] = (await i.sock.onWhatsApp(`52${tel10}`)) || [];
  return r?.exists ? r.jid : null;
}

/** Para sendToChannel: seguimientos, recordatorios y mensajes que el dueño escribe desde su panel. */
export async function enviarWaNegocio(n, id, texto) {
  const fila = getDb().prepare("SELECT jid FROM wa_contactos WHERE id = ?").get(String(id));
  const jid = fila?.jid || (/^\d{10}$/.test(String(id)) ? await resolverJid(n, String(id)) : null);
  if (!jid) throw new Error("No se encontró el chat de WhatsApp de este contacto");
  await enviarTexto(n, jid, texto);
}

/** Aviso al WhatsApp personal del dueño desde el chip del negocio. Devuelve false si no se pudo. */
export async function avisarDuenoNegocio(n, texto) {
  const i = inst(n);
  const tel = n.meta.dueno;
  if (!tel || !conectado(i) || tel === i.numero) return false;
  try {
    if (i.jidDuenoTel !== tel) i.jidDueno = null; // cambiaron el número del dueño
    i.jidDueno ||= await resolverJid(n, tel);
    i.jidDuenoTel = tel;
    if (!i.jidDueno) return false;
    await i.sock.sendMessage(i.jidDueno, { text: texto });
    return true;
  } catch (e) {
    console.error(`[wa ${n.slug}] no se pudo avisar al dueño:`, e.message);
    return false;
  }
}

/** Al pausar un negocio: su chip deja de atender (sin desvincularse). Al reactivarlo, vuelve solo. */
export function pausarOReanudarWa(n) {
  const i = inst(n);
  if (n.meta.activo === false) {
    try {
      i.sock?.end?.(new Error("negocio en pausa"));
    } catch {}
    i.sock = null;
    i.estado = "apagado";
  } else if (waActivo() && tieneSesion(n)) {
    conectar(n).catch((e) => console.error(`[wa ${n.slug}]`, e.message));
  }
}
