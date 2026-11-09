// Despachador de salida: envía un texto al cliente por el canal correcto.
import { sendWhatsApp } from "./whatsapp.js";
import { sendMeta } from "./meta.js";
import { sendTelegram } from "./telegram.js";
import { pushWeb } from "./web.js";
import { sendEmail } from "./email.js";
import { sendWaWeb } from "./wa-web.js";

/** Divide un texto largo en partes que respeten el límite del canal, cortando en saltos de línea o espacios. */
export function splitMessage(texto, max = 4000) {
  const partes = [];
  let resto = texto.trim();
  while (resto.length > max) {
    let corte = resto.lastIndexOf("\n", max);
    if (corte < max * 0.5) corte = resto.lastIndexOf(" ", max);
    if (corte <= 0) corte = max;
    partes.push(resto.slice(0, corte).trim());
    resto = resto.slice(corte).trim();
  }
  if (resto) partes.push(resto);
  return partes;
}

/**
 * Envía un mensaje proactivo (seguimiento, mensaje del humano, confirmación de pago).
 * @param {{proactivo?: boolean, ultimoMensajeCliente?: string}} opts
 */
export async function sendToChannel(canal, externoId, texto, opts = {}) {
  switch (canal) {
    case "whatsapp":
      return sendWhatsApp(externoId, texto, opts);
    case "messenger":
    case "instagram":
      return sendMeta(externoId, texto, opts);
    case "telegram":
      return sendTelegram(externoId, texto);
    case "web":
      return pushWeb(externoId, texto);
    case "email":
      return sendEmail(externoId, texto);
    case "wa":
      return sendWaWeb(externoId, texto);
    default:
      throw new Error(`Canal desconocido: ${canal}`);
  }
}

// Límite simple anti-spam por remitente: N mensajes por minuto.
const ventanas = new Map();
export function rateLimited(key, max = Number(process.env.RATE_LIMIT_PER_MIN || 20)) {
  const ahora = Date.now();
  const lista = (ventanas.get(key) || []).filter((t) => ahora - t < 60_000);
  lista.push(ahora);
  ventanas.set(key, lista);
  if (ventanas.size > 10_000) ventanas.clear();
  return lista.length > max;
}
