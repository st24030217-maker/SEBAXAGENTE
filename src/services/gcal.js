// Google Calendar con una "cuenta de servicio" (gratis, sin librerías):
//  - Lee tus horas ocupadas para que el agente nunca ofrezca un horario en el que ya tienes algo.
//  - Anota cada cita que agenda el agente directo en tu calendario.
// Se activa con GOOGLE_CALENDAR_ID (tu correo de Google) y GOOGLE_SERVICE_ACCOUNT (el JSON de la clave,
// tal cual o en base64). Tu calendario debe estar compartido con el correo de la cuenta de servicio
// con permiso "Hacer cambios en los eventos".
import crypto from "node:crypto";

const calendarId = () => process.env.GOOGLE_CALENDAR_ID || "";

function credenciales() {
  const crudo = (process.env.GOOGLE_SERVICE_ACCOUNT || "").trim();
  if (!crudo) return null;
  try {
    const json = crudo.startsWith("{") ? crudo : Buffer.from(crudo, "base64").toString("utf8");
    const c = JSON.parse(json);
    return c.client_email && c.private_key ? c : null;
  } catch {
    return null;
  }
}

export const gcalConfigurado = () => !!(calendarId() && credenciales());

let token = null;
let tokenVence = 0;

async function accessToken() {
  if (token && Date.now() < tokenVence - 60_000) return token;
  const c = credenciales();
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const ahora = Math.floor(Date.now() / 1000);
  const sinFirma = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: c.client_email,
    scope: "https://www.googleapis.com/auth/calendar",
    aud: "https://oauth2.googleapis.com/token",
    iat: ahora,
    exp: ahora + 3600,
  })}`;
  const firma = crypto.sign("RSA-SHA256", Buffer.from(sinFirma), c.private_key).toString("base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${sinFirma}.${firma}` }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Google no dio acceso: ${j.error_description || j.error || r.status}`);
  token = j.access_token;
  tokenVence = Date.now() + Number(j.expires_in || 3600) * 1000;
  return token;
}

async function api(ruta, cuerpo) {
  const r = await fetch(`https://www.googleapis.com/calendar/v3${ruta}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(15_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google Calendar ${r.status}: ${j.error?.message || "error"}`);
  return j;
}

// ---------- Horas ocupadas (con caché, para que la agenda se calcule sin esperar) ----------
const ocupadoCache = new Map(); // "YYYY-MM-DD" -> { hasta: ms, intervalos: [[ini, fin], ...] }

/** Intervalos ocupados ya consultados para esa fecha (síncrono; vacío si no se ha consultado). */
export function ocupadoGoogle(fecha) {
  return ocupadoCache.get(fecha)?.intervalos || [];
}

/** Consulta a Google las horas ocupadas entre desde y hasta y las guarda para la fecha. */
export async function refrescarOcupado(fecha, desdeIso, hastaIso) {
  if (!gcalConfigurado()) return [];
  const c = ocupadoCache.get(fecha);
  if (c && Date.now() < c.hasta) return c.intervalos;
  const j = await api("/freeBusy", { timeMin: desdeIso, timeMax: hastaIso, items: [{ id: calendarId() }] });
  const cal = j.calendars?.[calendarId()];
  if (cal?.errors?.length) throw new Error(`No puedo ver tu calendario (${cal.errors[0].reason}). ¿Lo compartiste con la cuenta de servicio?`);
  const intervalos = (cal?.busy || []).map((b) => [new Date(b.start).getTime(), new Date(b.end).getTime()]);
  ocupadoCache.set(fecha, { hasta: Date.now() + 2 * 60_000, intervalos });
  return intervalos;
}

/** Crea el evento de la cita en tu calendario. Devuelve el link al evento. */
export async function crearEventoGoogle({ inicio, fin, titulo, descripcion, zona }) {
  if (!gcalConfigurado()) return null;
  const ev = await api(`/calendars/${encodeURIComponent(calendarId())}/events`, {
    summary: titulo,
    description: descripcion,
    start: { dateTime: inicio, timeZone: zona },
    end: { dateTime: fin, timeZone: zona },
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 60 }, { method: "popup", minutes: 1440 }] },
  });
  // Esa fecha cambió: la próxima consulta vuelve a preguntar a Google.
  ocupadoCache.clear();
  return ev.htmlLink || ev.id;
}

/** Comprueba que todo esté bien conectado (para el panel). */
export async function probarGcal() {
  if (!gcalConfigurado()) return { ok: false, motivo: "Falta GOOGLE_CALENDAR_ID o GOOGLE_SERVICE_ACCOUNT" };
  const ahora = new Date();
  const en7 = new Date(ahora.getTime() + 7 * 86400_000);
  ocupadoCache.delete("__prueba__");
  const ocupados = await refrescarOcupado("__prueba__", ahora.toISOString(), en7.toISOString());
  return { ok: true, calendario: calendarId(), cuenta: credenciales().client_email, ocupadosProximos7Dias: ocupados.length };
}
