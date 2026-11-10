// Agenda de citas: calcula horarios libres según el horario del negocio,
// en la zona horaria del negocio, sin librerías externas.
import { getDb } from "../db.js";
import { ocupadoGoogle, refrescarOcupado } from "./gcal.js";

/**
 * Antes de calcular horarios: pregunta a Google Calendar qué tienes ocupado ese día.
 * Si Google falla, se sigue solo con las citas del agente (y se avisa en consola).
 */
export async function prepararDia(fecha, negocio) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha))) return;
  const tz = negocio.negocio.zona_horaria;
  try {
    await refrescarOcupado(fecha, zonedToUtc(fecha, "00:00", tz).toISOString(), zonedToUtc(fecha, "23:59", tz).toISOString());
  } catch (e) {
    console.error("[calendar] no se pudo consultar Google Calendar:", e.message);
  }
}

const DIAS = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];

const normalizar = (t) =>
  String(t || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

/**
 * Tipos de cita del negocio.yaml. Cada uno puede ser un texto ("Llamada") o un objeto
 * { nombre, modalidad: presencial | en_linea, dias: [lunes, ...] }. Sin "dias", vale todos los días.
 */
export function tiposCita(negocio) {
  return (negocio.citas?.tipos || [])
    .map((t) => (typeof t === "string" ? { nombre: t } : { ...t, nombre: String(t?.nombre || "") }))
    .filter((t) => t.nombre)
    .map((t) => ({
      nombre: t.nombre,
      modalidad: t.modalidad ? normalizar(t.modalidad).replace(/\s+/g, "_") : null,
      dias: Array.isArray(t.dias) && t.dias.length ? t.dias.map(normalizar) : null,
    }));
}

/** Tipos de cita que se ofrecen un día de la semana (lunes, martes, ...). */
export function tiposDelDia(negocio, dia) {
  const d = normalizar(dia);
  return tiposCita(negocio).filter((t) => !t.dias || t.dias.includes(d));
}

const PALABRAS = {
  presencial: /presencial|visita|en persona|domicilio|oficina|tu negocio|en su negocio|cara a cara/,
  en_linea: /en linea|online|llamada|video|zoom|meet|remot|virtual|whatsapp|telefon/,
};

/** Reconoce el tipo que pidió el agente aunque no lo escriba igual que en negocio.yaml. */
export function resolverTipo(tipo, tipos) {
  const t = normalizar(tipo);
  if (!t) return null;
  const exacto = tipos.find((x) => normalizar(x.nombre) === t) || tipos.find((x) => normalizar(x.nombre).includes(t) || t.includes(normalizar(x.nombre)));
  if (exacto) return exacto;
  for (const [modalidad, re] of Object.entries(PALABRAS)) {
    if (re.test(t)) {
      const m = tipos.filter((x) => (x.modalidad || (re.test(normalizar(x.nombre)) ? modalidad : null)) === modalidad);
      if (m.length === 1) return m[0];
    }
  }
  return null;
}

/** Partes de fecha/hora de un instante, vistas en la zona horaria tz. */
export function localParts(date, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    h: Number(parts.hour),
    mi: Number(parts.minute),
    weekday: wd,
  };
}

/** Convierte "YYYY-MM-DD" + "HH:MM" (hora local de tz) a Date UTC. */
export function zonedToUtc(fecha, hora, tz) {
  const [y, m, d] = fecha.split("-").map(Number);
  const [h, mi] = hora.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  // Ajuste iterativo del offset (cubre cambios de horario de verano).
  let ts = guess;
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(ts), tz);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi);
    const diff = asUtc - guess;
    if (diff === 0) break;
    ts -= diff;
  }
  return new Date(ts);
}

export function localDateString(date, tz) {
  const p = localParts(date, tz);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

export function formatLocal(dateOrIso, tz, opts = {}) {
  const date = typeof dateOrIso === "string" ? new Date(dateOrIso) : dateOrIso;
  return new Intl.DateTimeFormat("es-MX", {
    timeZone: tz,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: opts.soloFecha ? undefined : "2-digit",
    minute: opts.soloFecha ? undefined : "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function parseRango(rango) {
  if (!rango || typeof rango !== "string" || !rango.includes("-")) return null;
  const [a, b] = rango.split("-").map((s) => s.trim());
  return { desde: a, hasta: b };
}

const toMin = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
const toHHMM = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/**
 * Horarios libres para una fecha local (YYYY-MM-DD).
 * Devuelve { fecha, dia, slots: [{inicio (ISO UTC), hora (HH:MM local)}], motivo? }
 */
export function availableSlots(fecha, negocio, ahora = new Date()) {
  const tz = negocio.negocio.zona_horaria;
  const cfg = negocio.citas || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return { fecha, slots: [], motivo: "Formato de fecha inválido, usa YYYY-MM-DD" };

  const mediodia = zonedToUtc(fecha, "12:00", tz);
  const diaNombre = DIAS[localParts(mediodia, tz).weekday];
  const rango = parseRango(negocio.horario?.[diaNombre]);
  if (!rango) return { fecha, dia: diaNombre, slots: [], motivo: `No atendemos los ${diaNombre}` };

  const duracion = Number(cfg.duracion_minutos || 30);
  const minInicio = ahora.getTime() + Number(cfg.anticipacion_minima_horas ?? 2) * 3600_000;
  const maxInicio = ahora.getTime() + Number(cfg.dias_maximos_adelante ?? 14) * 86400_000;

  const ocupadas = getDb()
    .prepare("SELECT inicio, fin FROM citas WHERE estado = 'confirmada' AND inicio < ? AND fin > ?")
    .all(zonedToUtc(fecha, "23:59", tz).toISOString(), zonedToUtc(fecha, "00:00", tz).toISOString())
    .map((c) => [new Date(c.inicio).getTime(), new Date(c.fin).getTime()])
    // Lo que ya tienes en tu Google Calendar (si está conectado) también cuenta como ocupado.
    .concat(ocupadoGoogle(fecha));

  const slots = [];
  for (let m = toMin(rango.desde); m + duracion <= toMin(rango.hasta); m += duracion) {
    const inicio = zonedToUtc(fecha, toHHMM(m), tz);
    const t0 = inicio.getTime();
    const t1 = t0 + duracion * 60_000;
    if (t0 < minInicio || t0 > maxInicio) continue;
    if (ocupadas.some(([a, b]) => t0 < b && t1 > a)) continue;
    slots.push({ inicio: inicio.toISOString(), hora: toHHMM(m) });
  }
  return {
    fecha,
    dia: diaNombre,
    slots,
    tipos: tiposDelDia(negocio, diaNombre).map((t) => t.nombre),
    ...(slots.length ? {} : { motivo: "No quedan horarios libres ese día (o está fuera del rango permitido)" }),
  };
}

/** Reserva una cita validando que el horario siga libre. */
export function bookAppointment({ convId, fecha, hora, tipo, notas }, negocio, ahora = new Date()) {
  const disp = availableSlots(fecha, negocio, ahora);
  const slot = disp.slots.find((s) => s.hora === hora);
  if (!slot) {
    return {
      ok: false,
      error: `El horario ${fecha} ${hora} no está disponible.`,
      horarios_libres_ese_dia: disp.slots.map((s) => s.hora),
    };
  }
  // Cada tipo de cita solo se agenda en sus días (ej.: presencial lunes, miércoles y viernes).
  const todos = tiposCita(negocio);
  let tipoFinal = tipo || null;
  if (todos.some((t) => t.dias)) {
    const delDia = tiposDelDia(negocio, disp.dia);
    let elegido = resolverTipo(tipo, todos);
    if (!elegido && delDia.length === 1) elegido = delDia[0];
    if (!elegido) {
      return { ok: false, error: `Falta indicar el tipo de cita. Los ${disp.dia} se puede: ${delDia.map((t) => t.nombre).join(" / ")}.`, tipos_ese_dia: delDia.map((t) => t.nombre) };
    }
    if (!delDia.includes(elegido) && !delDia.some((t) => t.nombre === elegido.nombre)) {
      const dias = (elegido.dias || []).join(", ");
      return {
        ok: false,
        error: `"${elegido.nombre}" no se agenda los ${disp.dia}${dias ? `; solo ${dias}` : ""}. Ese día se puede: ${delDia.map((t) => t.nombre).join(" / ") || "nada"}.`,
        tipos_ese_dia: delDia.map((t) => t.nombre),
      };
    }
    tipoFinal = elegido.nombre;
  }
  const duracion = Number(negocio.citas?.duracion_minutos || 30);
  const fin = new Date(new Date(slot.inicio).getTime() + duracion * 60_000).toISOString();
  const r = getDb()
    .prepare("INSERT INTO citas (conversacion_id, inicio, fin, tipo, notas, creado) VALUES (?, ?, ?, ?, ?, ?)")
    .run(convId, slot.inicio, fin, tipoFinal, notas || null, new Date().toISOString());
  return {
    ok: true,
    cita_id: Number(r.lastInsertRowid),
    inicio: slot.inicio,
    fin,
    tipo: tipoFinal,
    descripcion: formatLocal(slot.inicio, negocio.negocio.zona_horaria),
  };
}
