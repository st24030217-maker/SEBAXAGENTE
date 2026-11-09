// Avisos al dueño del negocio (Telegram y/o webhook genérico para Slack, Make, Zapier, n8n...).
import { settings } from "../config.js";

const ICONOS = {
  lead_nuevo: "🆕",
  cotizacion: "🧾",
  pedido: "🛒",
  pago: "💰",
  cita: "📅",
  derivacion: "🙋",
  error: "⚠️",
};

const AVISOS_CORREO = ["lead_nuevo", "cita", "derivacion", "error", "pago", "pedido"];
const AVISOS_WA = ["lead_nuevo", "cita", "derivacion", "error", "pago", "pedido", "boceto"];
const ASUNTOS = { lead_nuevo: "Respuesta nueva", cita: "Cita agendada", derivacion: "Te necesita", error: "Algo falló", pago: "Pago", pedido: "Pedido", boceto: "Abrió su muestra" };

// Los errores se avisan una sola vez cada 30 min (si algo falla en bucle, no te llena el WhatsApp).
const ultimosErrores = new Map();
function repetido(tipo, texto) {
  if (tipo !== "error") return false;
  const clave = texto.replace(/\d+/g, "#").slice(0, 120);
  const antes = ultimosErrores.get(clave);
  if (antes && Date.now() - antes < 30 * 60_000) return true;
  ultimosErrores.set(clave, Date.now());
  return false;
}

/** Archivo de calendario (.ics) para que la cita se agregue a Google Calendar / Outlook con un toque. */
function invitacionIcs(d) {
  const f = (iso) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const limpio = (s) => String(s || "").replace(/[\\;,]/g, (c) => "\\" + c).replace(/\n/g, "\\n");
  const quien = [d.lead?.nombre, d.lead?.empresa].filter(Boolean).join(" - ") || "cliente";
  const contenido = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//sss.solutions//Agente Sebax//ES", "METHOD:PUBLISH", "BEGIN:VEVENT",
    `UID:cita-${f(d.inicio)}-${Math.random().toString(36).slice(2)}@agente-sebax`,
    `DTSTAMP:${f(new Date().toISOString())}`, `DTSTART:${f(d.inicio)}`, `DTEND:${f(d.fin)}`,
    `SUMMARY:${limpio(`${d.tipo || "Cita"} - ${quien}`)}`,
    `DESCRIPTION:${limpio([d.lead?.telefono && `Tel: ${d.lead.telefono}`, d.lead?.email && `Correo: ${d.lead.email}`, d.lead?.necesidad, d.notas].filter(Boolean).join("\n"))}`,
    "BEGIN:VALARM", "TRIGGER:-PT30M", "ACTION:DISPLAY", "DESCRIPTION:Cita en 30 minutos", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
  return { filename: "cita.ics", content: contenido, contentType: "text/calendar; charset=utf-8; method=PUBLISH" };
}

/**
 * Envía un aviso. Nunca lanza error: si un canal falla, solo se registra en consola.
 * @param {string} tipo  lead_nuevo | cotizacion | pedido | pago | cita | derivacion | error
 * @param {string} texto Mensaje legible
 * @param {object} datos Datos estructurados (van al webhook)
 */
export async function notifyOwner(tipo, texto, datos = {}) {
  const tareas = [];
  const { telegramChatId, webhookUrl } = settings.owner;

  // Aviso a tu WhatsApp personal desde el chip (si está conectado).
  if (AVISOS_WA.includes(tipo) && !repetido(tipo, texto)) {
    tareas.push(
      import("../channels/wa-web.js").then(({ avisarDueno }) =>
        avisarDueno(`*Agente Sebax · ${ASUNTOS[tipo] || tipo}*\n\n${texto}${tipo === "cita" ? (datos.enCalendario ? "\n\nYa quedó en tu Google Calendar." : datos.gcal ? "\n\nNo se pudo anotar en tu Google Calendar: agrégala a mano." : "\n\nAgrégala a tu calendario y confírmale al cliente un día antes.") : ""}\n\nPanel: ${settings.publicUrl}/admin`)
      ).then((ok) => {
        if (!ok) console.log(`[aviso] ${tipo}: ${texto}`);
      })
    );
  }

  if (telegramChatId && settings.telegram.token) {
    tareas.push(
      fetch(`https://api.telegram.org/bot${settings.telegram.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: telegramChatId,
          text: `${ICONOS[tipo] || "🔔"} ${texto}\n\nPanel: ${settings.publicUrl}/admin`,
          disable_web_page_preview: true,
        }),
      })
    );
  }
  if (webhookUrl) {
    tareas.push(
      fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tipo, texto, datos, fecha: new Date().toISOString() }),
      })
    );
  }
  // Aviso por correo a ti mismo (OWNER_EMAIL o, si no, la cuenta que envía).
  // Las citas llevan un archivo .ics para agregarlas al calendario con un toque.
  if (settings.smtp.user && settings.smtp.pass && AVISOS_CORREO.includes(tipo)) {
    tareas.push(
      import("../prospeccion/servicio.js").then(({ enviarCorreo }) =>
        enviarCorreo({
          para: process.env.OWNER_EMAIL || settings.smtp.user,
          asunto: `[Agente] ${ASUNTOS[tipo] || tipo}: ${texto.split("\n")[0].slice(0, 90)}`,
          texto: `${texto}\n\nPanel: ${settings.publicUrl}/admin`,
          pie: false,
          adjuntos: tipo === "cita" && datos.inicio && datos.fin ? [invitacionIcs(datos)] : undefined,
        })
      )
    );
  }
  if (!tareas.length) {
    console.log(`[aviso] ${tipo}: ${texto}`);
    return;
  }
  const resultados = await Promise.allSettled(tareas);
  for (const r of resultados) {
    if (r.status === "rejected") console.error("[aviso] falló el envío:", r.reason?.message || r.reason);
  }
}
