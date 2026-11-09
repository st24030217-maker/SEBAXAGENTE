// Canal de correo de ida y vuelta (Gmail u otro con IMAP + SMTP).
// Cada minuto revisa la bandeja de entrada. SOLO atiende correos de:
//   - negocios a los que el agente ya les escribió (tabla prospectos), o
//   - personas con una conversación de correo ya abierta.
// Todo lo demás de tu bandeja se ignora: el agente nunca contesta tus correos personales.
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { settings } from "../config.js";
import { getDb, now, logEvent, getOrCreateConversation, loadHistory, upsertLead, setBotActive } from "../db.js";
import { handleIncoming, recordOutgoing, MENSAJE_ERROR } from "../agent/agent.js";
import { notifyOwner } from "../services/notify.js";
import { enviarCorreo, correoConfigurado } from "../prospeccion/servicio.js";
import { claudeDisponible } from "../prospeccion/redactar.js";

const IMAP_HOST = process.env.IMAP_HOST || "imap.gmail.com";
const IMAP_PORT = Number(process.env.IMAP_PORT || 993);
const DIAS_ATRAS = 7;
const db = () => getDb();

function asegurarTablas() {
  db().exec(`
    CREATE TABLE IF NOT EXISTS correos_procesados (message_id TEXT PRIMARY KEY, creado TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS correo_hilos (
      email TEXT PRIMARY KEY, asunto TEXT, message_id TEXT, referencias TEXT, actualizado TEXT NOT NULL
    );`);
}

const FIRMA = () => `\n\n--\nAsistente de Sebastián Salinas · sss.solutions\nWhatsApp ${process.env.FIRMA_WHATSAPP || "+52 871 916 4677"}`;

/** Quita del correo la parte citada (el mensaje anterior que viene debajo de la respuesta). */
export function limpiarRespuesta(texto) {
  const lineas = String(texto || "").replace(/\r/g, "").split("\n");
  const out = [];
  for (const l of lineas) {
    if (/^\s*>/.test(l)) break;
    if (/^\s*(El|On)\s.+(escribió|wrote):\s*$/i.test(l)) break;
    if (/^\s*-{2,}\s*(Original Message|Mensaje original|Forwarded)/i.test(l)) break;
    if (/^\s*(De|From):\s.+/i.test(l) && out.length) break;
    if (/^\s*Enviado desde mi (iPhone|Android|Samsung)/i.test(l)) break;
    out.push(l);
  }
  return out.join("\n").trim().slice(0, 4000);
}

export const esBaja = (t) => /^\s*(baja|unsubscribe|darme de baja|no me (vuelvan a )?escriban)\b/i.test(String(t || ""));

/** ¿Este remitente es alguien a quien el agente debe atender? */
function quienEs(email) {
  const prospecto = db().prepare("SELECT * FROM prospectos WHERE lower(email) = ? ORDER BY id DESC LIMIT 1").get(email);
  const conv = db().prepare("SELECT * FROM conversaciones WHERE id = ?").get(`email:${email}`);
  return { prospecto, conv };
}

function guardarHilo(email, asunto, messageId, referencias) {
  db()
    .prepare(
      `INSERT INTO correo_hilos (email, asunto, message_id, referencias, actualizado) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET asunto = excluded.asunto, message_id = excluded.message_id, referencias = excluded.referencias, actualizado = excluded.actualizado`
    )
    .run(email, asunto, messageId, referencias, now());
}

const reAsunto = (a) => (/^\s*re:/i.test(a || "") ? a : `Re: ${a || "Seguimiento"}`);

/** Envía un mensaje por correo dentro del hilo existente (para seguimientos y mensajes del panel). */
export async function sendEmail(email, texto) {
  const h = db().prepare("SELECT * FROM correo_hilos WHERE email = ?").get(email);
  await enviarCorreo({
    para: email,
    asunto: reAsunto(h?.asunto),
    texto,
    pie: false,
    firma: FIRMA(),
    inReplyTo: h?.message_id || undefined,
    references: h?.referencias || undefined,
  });
}

/** Procesa un correo entrante ya parseado. Devuelve qué se hizo (útil para tests y registro). */
export async function procesarCorreo({ de, nombre, asunto, texto, messageId, referencias }) {
  const email = String(de || "").toLowerCase().trim();
  if (!email || email === settings.smtp.user.toLowerCase()) return "propio";
  const { prospecto, conv } = quienEs(email);
  if (!prospecto && !conv) return "ignorado";
  if (prospecto?.estado === "no_contactar") return "baja_previa";

  const limpio = limpiarRespuesta(texto);
  guardarHilo(email, asunto, messageId, [referencias, messageId].filter(Boolean).join(" "));

  // Pidió no ser contactado: se respeta sin responder.
  if (esBaja(limpio)) {
    if (prospecto) db().prepare("UPDATE prospectos SET estado = 'no_contactar', actualizado = ? WHERE id = ?").run(now(), prospecto.id);
    if (conv) setBotActive(conv.id, false);
    logEvent("prospecto_baja", conv?.id || null, { email, via: "respuesta" });
    return "baja";
  }

  const nombreNegocio = prospecto?.nombre || nombre || email;
  const c = getOrCreateConversation("email", email, nombre || nombreNegocio);

  // Primera respuesta de un prospecto: el agente recibe el contexto de a quién le escribimos y qué le dijimos.
  if (prospecto && loadHistory(c.id).length === 0) {
    const razones = (() => { try { return JSON.parse(prospecto.razones || "[]").join(", "); } catch { return ""; } })();
    await recordOutgoing(
      c.id,
      `Asunto: ${prospecto.asunto || asunto}\n\n${prospecto.correo || ""}`,
      "agente",
      `[Prospección] Sebastián le escribió primero a este negocio (${prospecto.nombre}, ${prospecto.giro || prospecto.rubro || ""}, ${[prospecto.colonia, prospecto.ciudad].filter(Boolean).join(", ")}). Situación detectada: ${razones}. Este es el correo que se le envió y ahora está respondiendo`
    );
    upsertLead(c.id, {
      empresa: prospecto.nombre,
      email,
      telefono: prospecto.telefono || undefined,
      necesidad: `Prospecto ${prospecto.rubro || ""}: ${razones}`.slice(0, 300),
      etapa: "interesado",
    });
    db().prepare("UPDATE prospectos SET estado = 'respondio', actualizado = ? WHERE id = ?").run(now(), prospecto.id);
    notifyOwner("lead_nuevo", `${prospecto.nombre} respondió tu correo: "${limpio.slice(0, 160)}"`, { prospecto: prospecto.id, email });
  }

  if (!limpio) return "vacio";

  if (!claudeDisponible()) {
    // Sin IA no podemos conversar: se registra para que Sebastián conteste a mano.
    const { addTranscript } = await import("../db.js");
    addTranscript(c.id, "cliente", limpio);
    notifyOwner("derivacion", `${nombreNegocio} te escribió y el agente no puede responder (falta ANTHROPIC_API_KEY). Contéstale desde tu Gmail.`, { email });
    return "sin_ia";
  }

  const { respuesta } = await handleIncoming({ canal: "email", externoId: email, texto: limpio, nombre: nombre || null });
  if (!respuesta) return "pausado"; // Sebastián tomó la conversación desde el panel
  if (respuesta === MENSAJE_ERROR) {
    notifyOwner("error", `El agente no pudo responder a ${nombreNegocio} (${email}). Revisa la conversación y contesta a mano.`, { email });
    return "error_ia";
  }
  await enviarCorreo({
    para: email,
    asunto: reAsunto(asunto),
    texto: respuesta,
    pie: false,
    firma: FIRMA(),
    inReplyTo: messageId || undefined,
    references: [referencias, messageId].filter(Boolean).join(" ") || undefined,
  });
  logEvent("correo_respondido", c.id, { email });
  return "respondido";
}

// ---------- Lectura de la bandeja (IMAP) ----------

let revisando = false;

export async function revisarBandeja() {
  if (revisando || !correoConfigurado()) return 0;
  revisando = true;
  asegurarTablas();
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: settings.smtp.user, pass: settings.smtp.pass },
    logger: false,
  });
  let procesados = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const desde = new Date(Date.now() - DIAS_ATRAS * 86400_000);
      const uids = (await client.search({ since: desde }, { uid: true })) || [];
      if (!uids.length) return 0;
      // 1) Solo sobres (rápido) para decidir qué correos son de prospectos/conversaciones.
      const candidatos = [];
      for await (const m of client.fetch(uids, { envelope: true, uid: true }, { uid: true })) {
        const de = m.envelope?.from?.[0]?.address?.toLowerCase();
        const mid = m.envelope?.messageId;
        if (!de || !mid) continue;
        if (db().prepare("SELECT 1 FROM correos_procesados WHERE message_id = ?").get(mid)) continue;
        const { prospecto, conv } = quienEs(de);
        if (!prospecto && !conv) continue;
        candidatos.push({ uid: m.uid, mid });
      }
      // 2) Descarga y procesa solo esos (los marca procesados antes, para no responder dos veces).
      for (const cand of candidatos) {
        db().prepare("INSERT OR IGNORE INTO correos_procesados (message_id, creado) VALUES (?, ?)").run(cand.mid, now());
        const msg = await client.fetchOne(cand.uid, { source: true }, { uid: true });
        const p = await simpleParser(msg.source);
        const de = p.from?.value?.[0];
        try {
          const r = await procesarCorreo({
            de: de?.address,
            nombre: de?.name || null,
            asunto: p.subject || "",
            texto: p.text || "",
            messageId: p.messageId,
            referencias: Array.isArray(p.references) ? p.references.join(" ") : p.references || "",
          });
          console.log(`[correo] ${de?.address}: ${r}`);
          procesados++;
        } catch (e) {
          console.error(`[correo] error con ${de?.address}:`, e.message);
          notifyOwner("error", `No se pudo procesar el correo de ${de?.address}: ${e.message}`);
        }
      }
    } finally {
      lock.release();
    }
  } catch (e) {
    console.error("[correo] no se pudo revisar la bandeja:", e.message);
  } finally {
    revisando = false;
    await client.logout().catch(() => {});
  }
  return procesados;
}

export function startEmail(intervaloMs = 60_000) {
  if (!correoConfigurado()) {
    console.log("   Correo: sin configurar (falta SMTP_PASS). El agente no lee ni contesta correos todavía.");
    return null;
  }
  asegurarTablas();
  console.log(`   Correo: revisando ${settings.smtp.user} cada minuto (solo respuestas de prospectos)`);
  setTimeout(() => revisarBandeja(), 8_000);
  return setInterval(() => revisarBandeja(), intervaloMs);
}
