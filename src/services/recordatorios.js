// Recordatorios para TI por WhatsApp (en lugar de un calendario):
//  - Tu agenda del día, cada mañana a las 8:00, solo si ese día tienes citas.
//  - Un aviso una hora antes de cada cita, con el teléfono del cliente para marcarle directo.
//  - "A quién llamar hoy" (solo el agente principal), de lunes a sábado a las 9:00: los clientes más calientes.
import { getDb, getLead, logEvent } from "../db.js";
import { getNegocio } from "../config.js";
import { localParts, localDateString, zonedToUtc } from "./calendar.js";
import { negocioActual } from "../contexto.js";
import { paraCadaNegocio } from "../negocios.js";
import { textoLlamarHoy } from "./llamar-hoy.js";

const HORA_AGENDA = Number(process.env.AGENDA_HORA || 8);
const HORA_LLAMAR = Number(process.env.LLAMAR_HOY_HORA || 9);

const hora = (iso, tz) => new Intl.DateTimeFormat("es-MX", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
const diaLargo = (fecha, tz) =>
  new Intl.DateTimeFormat("es-MX", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(zonedToUtc(fecha, "12:00", tz));

/** Quién es y cómo contactarlo, en una línea. */
function quien(c) {
  const l = getLead(c.conversacion_id) || {};
  const nombre = [l.nombre, l.empresa].filter(Boolean).join(" · ") || "Cliente";
  const tel = l.telefono || (/^wa:\d{10}$/.test(c.conversacion_id) ? c.conversacion_id.slice(3) : "");
  return { nombre, tel, necesidad: l.necesidad };
}

const yaEnviado = (tipo, clave) =>
  !!getDb().prepare("SELECT 1 FROM eventos WHERE tipo = ? AND json_extract(datos, '$.clave') = ? LIMIT 1").get(tipo, clave);

/**
 * Revisa si toca mandar algo. `enviar(texto)` manda al WhatsApp del dueño y regresa true si salió.
 * Devuelve los textos enviados (para pruebas).
 */
export async function revisarRecordatorios(ahora = new Date(), enviar) {
  const tz = getNegocio().negocio.zona_horaria;
  const marca = negocioActual() ? negocioActual().meta.nombre : "Agente Sebax";
  const d = getDb();
  const enviados = [];

  // 1) Agenda del día (una vez al día, a partir de las 8:00; si el agente arranca más tarde, sale al arrancar).
  const hoy = localDateString(ahora, tz);
  if (localParts(ahora, tz).h >= HORA_AGENDA && !yaEnviado("agenda_dueno", hoy)) {
    const fin = zonedToUtc(hoy, "23:59", tz).toISOString();
    const citas = d.prepare("SELECT * FROM citas WHERE estado = 'confirmada' AND inicio > ? AND inicio <= ? ORDER BY inicio").all(ahora.toISOString(), fin);
    if (citas.length) {
      const lineas = citas.map((c) => {
        const q = quien(c);
        return `${hora(c.inicio, tz)} · ${q.nombre}${c.tipo ? ` · ${c.tipo}` : ""}${q.tel ? `\n      tel. ${q.tel}` : ""}`;
      });
      const texto = `*${marca} · Tu agenda de hoy*\n\n${diaLargo(hoy, tz).replace(/^./, (x) => x.toUpperCase())}: ${citas.length === 1 ? "tienes 1 cita" : `tienes ${citas.length} citas`}.\n\n${lineas.join("\n")}`;
      if (await enviar(texto)) enviados.push(texto);
      else return enviados; // chip desconectado: se reintenta en el siguiente minuto
    }
    logEvent("agenda_dueno", null, { clave: hoy, citas: citas.length });
  }

  // 1b) A quién llamar hoy (lunes a sábado; una vez al día).
  const lp = localParts(ahora, tz);
  if (!negocioActual() && lp.weekday !== 0 && lp.h >= HORA_LLAMAR && !yaEnviado("llamar_hoy", hoy)) {
    const texto = textoLlamarHoy(ahora, tz, marca);
    if (texto) {
      if (await enviar(texto)) enviados.push(texto);
      else return enviados; // chip desconectado: se reintenta en el siguiente minuto
    }
    logEvent("llamar_hoy", null, { clave: hoy, hay: !!texto });
  }

  // 2) Una hora antes de cada cita (entre 70 y 0 minutos antes; no si se agendó hace menos de 20 min).
  const hasta = new Date(ahora.getTime() + 70 * 60_000).toISOString();
  const recien = new Date(ahora.getTime() - 20 * 60_000).toISOString();
  const proximas = d
    .prepare("SELECT * FROM citas WHERE estado = 'confirmada' AND inicio > ? AND inicio <= ? AND creado <= ? ORDER BY inicio")
    .all(ahora.toISOString(), hasta, recien);
  for (const c of proximas) {
    const clave = `cita-${c.id}`;
    if (yaEnviado("recordatorio_dueno", clave)) continue;
    const q = quien(c);
    const min = Math.max(1, Math.round((new Date(c.inicio) - ahora) / 60_000));
    const texto = `*${marca} · Cita en ${min >= 55 ? "1 hora" : `${min} minutos`}*\n\n${hora(c.inicio, tz)} · ${q.nombre}${c.tipo ? `\n${c.tipo}` : ""}${q.tel ? `\nTel. ${q.tel}` : ""}${q.necesidad ? `\nBusca: ${q.necesidad}` : ""}${c.notas ? `\nNotas: ${c.notas}` : ""}`;
    if (!(await enviar(texto))) break;
    logEvent("recordatorio_dueno", c.conversacion_id, { clave });
    enviados.push(texto);
  }
  return enviados;
}

/** Revisa cada minuto. */
export function startRecordatorios(enviar, cadaMs = 60_000) {
  let corriendo = false;
  const tick = async () => {
    if (corriendo) return;
    corriendo = true;
    try {
      try {
        await revisarRecordatorios(new Date(), enviar);
      } catch (e) {
        console.error("[recordatorios]", e.message);
      }
      // Cada negocio cliente recibe su agenda y sus avisos en el WhatsApp de su dueño, desde su chip.
      const { avisarDuenoNegocio } = await import("../channels/wa-negocio.js");
      await paraCadaNegocio((n) => (n.meta.dueno ? revisarRecordatorios(new Date(), (t) => avisarDuenoNegocio(n, t)) : null), "recordatorios");
    } finally {
      corriendo = false;
    }
  };
  setTimeout(tick, 20_000);
  return setInterval(tick, cadaMs);
}
