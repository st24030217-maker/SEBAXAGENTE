// Tareas automáticas que corren cada minuto:
//  1. Programa seguimientos automáticos para clientes interesados que dejaron de responder.
//  2. Envía los seguimientos que tocan (generados por el agente, personalizados).
//  3. Envía recordatorios de citas para el día siguiente / próximas horas.
import { getDb, now, logEvent, getConversation } from "../db.js";
import { getNegocio } from "../config.js";
import { generateFollowup, recordOutgoing } from "../agent/agent.js";
import { sendToChannel } from "../channels/index.js";
import { formatLocal, localParts } from "./calendar.js";

const DIAS = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];
let corriendo = false;

export function startScheduler(intervaloMs = 60_000) {
  const tick = async () => {
    if (corriendo) return;
    corriendo = true;
    try {
      await runSchedulerOnce();
    } catch (e) {
      console.error("[automatizaciones]", e);
    } finally {
      corriendo = false;
    }
  };
  setTimeout(tick, 5_000);
  return setInterval(tick, intervaloMs);
}

export async function runSchedulerOnce(ahora = new Date()) {
  const negocio = getNegocio();
  if (negocio.seguimientos?.activo) programarAutomaticos(negocio, ahora);
  // Los mensajes proactivos solo se envían dentro del horario de atención.
  if (dentroDeHorario(negocio, ahora)) {
    await enviarSeguimientos(ahora);
    await enviarRecordatorios(negocio, ahora);
  }
}

export function dentroDeHorario(negocio, ahora = new Date()) {
  const tz = negocio.negocio.zona_horaria;
  const p = localParts(ahora, tz);
  const rango = negocio.horario?.[DIAS[p.weekday]];
  if (!rango || !rango.includes("-")) return false;
  const [a, b] = rango.split("-").map((s) => s.trim().split(":").map(Number));
  const min = p.h * 60 + p.mi;
  return min >= a[0] * 60 + a[1] && min < b[0] * 60 + b[1];
}

function programarAutomaticos(negocio, ahora) {
  const cfg = negocio.seguimientos;
  const horas = Array.isArray(cfg.horas_inactividad) ? cfg.horas_inactividad : [24];
  const etapas = cfg.etapas || ["interesado", "cotizado", "negociacion"];
  const d = getDb();
  const candidatos = d
    .prepare(
      `SELECT c.id, c.ultimo_mensaje_cliente, c.ultimo_mensaje_agente, c.seguimientos_enviados, l.etapa
       FROM conversaciones c JOIN leads l ON l.conversacion_id = c.id
       WHERE c.bot_activo = 1
         AND c.ultimo_mensaje_cliente IS NOT NULL
         AND c.ultimo_mensaje_agente >= c.ultimo_mensaje_cliente
         AND c.seguimientos_enviados < ?
         AND l.etapa IN (${etapas.map(() => "?").join(",")})
         AND NOT EXISTS (SELECT 1 FROM seguimientos s WHERE s.conversacion_id = c.id AND s.estado = 'pendiente')`
    )
    .all(horas.length, ...etapas);

  for (const c of candidatos) {
    const espera = Number(horas[c.seguimientos_enviados]) * 3600_000;
    const desde = new Date(c.ultimo_mensaje_cliente).getTime();
    if (ahora.getTime() - desde < espera) continue;
    d.prepare(
      "INSERT INTO seguimientos (conversacion_id, ejecutar_en, contexto, origen, creado) VALUES (?, ?, ?, 'automatico', ?)"
    ).run(
      c.id,
      ahora.toISOString(),
      `Seguimiento automático #${c.seguimientos_enviados + 1}: el cliente (etapa ${c.etapa}) no responde hace ${horas[c.seguimientos_enviados]} horas`,
      now()
    );
    d.prepare("UPDATE conversaciones SET seguimientos_enviados = seguimientos_enviados + 1 WHERE id = ?").run(c.id);
  }
}

async function enviarSeguimientos(ahora) {
  const d = getDb();
  const pendientes = d
    .prepare("SELECT * FROM seguimientos WHERE estado = 'pendiente' AND ejecutar_en <= ? ORDER BY ejecutar_en LIMIT 20")
    .all(ahora.toISOString());
  for (const s of pendientes) {
    d.prepare("UPDATE seguimientos SET estado = 'enviando' WHERE id = ?").run(s.id);
    try {
      const conv = getConversation(s.conversacion_id);
      const texto = await generateFollowup(s.conversacion_id, s.contexto || "retomar la conversación");
      if (!texto) {
        d.prepare("UPDATE seguimientos SET estado = 'cancelado' WHERE id = ?").run(s.id);
        continue;
      }
      await sendToChannel(conv.canal, conv.externo_id, texto, {
        proactivo: true,
        ultimoMensajeCliente: conv.ultimo_mensaje_cliente,
      });
      d.prepare("UPDATE seguimientos SET estado = 'enviado' WHERE id = ?").run(s.id);
      logEvent("seguimiento_enviado", s.conversacion_id, { id: s.id, origen: s.origen });
    } catch (e) {
      console.error(`[seguimientos] #${s.id}:`, e.message);
      d.prepare("UPDATE seguimientos SET estado = 'fallido' WHERE id = ?").run(s.id);
      logEvent("seguimiento_fallido", s.conversacion_id, { id: s.id, error: e.message });
    }
  }
}

async function enviarRecordatorios(negocio, ahora) {
  const d = getDb();
  const limite = new Date(ahora.getTime() + 24 * 3600_000).toISOString();
  const citas = d
    .prepare(
      "SELECT * FROM citas WHERE estado = 'confirmada' AND recordatorio_enviado = 0 AND inicio > ? AND inicio <= ?"
    )
    .all(ahora.toISOString(), limite);
  for (const c of citas) {
    d.prepare("UPDATE citas SET recordatorio_enviado = 1 WHERE id = ?").run(c.id);
    const conv = getConversation(c.conversacion_id);
    if (!conv) continue;
    const texto = `Hola${conv.nombre ? ` ${conv.nombre.split(" ")[0]}` : ""} 👋 Te recuerdo tu cita con ${negocio.negocio.nombre}: ${formatLocal(c.inicio, negocio.negocio.zona_horaria)}${c.tipo ? ` (${c.tipo})` : ""}. Si necesitas cambiarla, respóndeme por aquí.`;
    try {
      await sendToChannel(conv.canal, conv.externo_id, texto, { proactivo: true, ultimoMensajeCliente: conv.ultimo_mensaje_cliente });
      await recordOutgoing(conv.id, texto, "agente", "El sistema de recordatorios automáticos");
      logEvent("recordatorio_cita", conv.id, { cita: c.id });
    } catch (e) {
      console.error(`[recordatorios] cita #${c.id}:`, e.message);
    }
  }
}
