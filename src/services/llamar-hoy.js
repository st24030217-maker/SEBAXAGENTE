// "A quién llamar hoy": cada mañana, la lista de los clientes más calientes para que Sebastián
// les marque o les escriba él. Una llamada suya cierra más que diez mensajes del bot.
// Solo para el agente principal (la prospección es de sss.solutions).
import { getDb } from "../db.js";
import { localParts } from "./calendar.js";

const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
// El cliente ya dijo que no: no se le vuelve a insistir (ver la regla de no mandar un tercer mensaje).
const DIJO_QUE_NO = /no (me|nos) interesa|ya (tenemos|tengo|contamos|cuento)|no gracias|no,? gracias|no estamos interesad|baja\b|no me escrib/i;
const MAX = 8;

const sinAcentos = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

/**
 * Arma la lista de hoy. Cada elemento: { prioridad, emoji, nombre, motivo, tel }.
 * prioridad: 1 = te está esperando … 5 = se está enfriando.
 */
export function listaLlamarHoy(ahora = new Date(), tz = "America/Monterrey") {
  const d = getDb();
  const dia = DIAS[localParts(ahora, tz).weekday];
  const hace = (dias) => new Date(ahora.getTime() - dias * 86400_000).toISOString();
  const items = new Map(); // convId -> item (se queda la señal más fuerte)

  const convs = d
    .prepare(
      `SELECT c.*, l.nombre AS l_nombre, l.empresa, l.telefono, l.etapa
       FROM conversaciones c LEFT JOIN leads l ON l.conversacion_id = c.id
       WHERE c.canal = 'wa' AND IFNULL(l.etapa, 'nuevo') NOT IN ('ganado', 'perdido')`
    )
    .all();
  const ultimo = d.prepare("SELECT texto, creado FROM mensajes WHERE conversacion_id = ? AND rol = ? ORDER BY id DESC LIMIT 1");
  const ultimosNuestros = d.prepare("SELECT texto, creado FROM mensajes WHERE conversacion_id = ? AND rol IN ('agente','humano') ORDER BY id DESC LIMIT 3");

  const poner = (c, prioridad, emoji, motivo) => {
    const prev = items.get(c.id);
    if (prev && prev.prioridad <= prioridad) return;
    const tel = c.telefono || (/^\d{10}$/.test(c.externo_id) ? c.externo_id : "");
    items.set(c.id, { prioridad, emoji, nombre: c.empresa || c.l_nombre || c.nombre || tel || c.externo_id, motivo, tel });
  };

  for (const c of convs) {
    const delCliente = ultimo.get(c.id, "cliente");
    if (!delCliente) continue; // nunca contestó: eso lo cubre el seguimiento automático
    const textoCliente = delCliente.texto.replace(/^\[Respuesta automática\]\s*/, "");
    if (DIJO_QUE_NO.test(textoCliente) || delCliente.texto.startsWith("[Respuesta automática]")) continue;
    const nuestro = ultimosNuestros.all(c.id);
    const ultimoNuestro = nuestro[0];

    // 1) Te escribió y nadie le contestó (el bot está apagado porque lo atiendes tú).
    if (!c.bot_activo && (!ultimoNuestro || delCliente.creado > ultimoNuestro.creado) && delCliente.creado >= hace(14)) {
      poner(c, 1, "🔥", `Te escribió y nadie le ha contestado: "${textoCliente.slice(0, 70)}"`);
    }
    // 2) Quedamos en escribirle hoy ("te escribo el martes").
    const prometido = nuestro.find((m) => m.creado >= hace(7) && new RegExp(`\\b(el|este|el pr[oó]ximo) ${sinAcentos(dia)}\\b`, "i").test(sinAcentos(m.texto)));
    if (prometido && localParts(new Date(prometido.creado), tz).weekday !== localParts(ahora, tz).weekday) {
      poner(c, 2, "📌", `Quedaste en escribirle hoy ${dia}`);
    }
    // 5) Interesado que se enfría: dijo algo y lleva 3+ días sin que nadie le escriba.
    if (c.etapa === "interesado" && ultimoNuestro && ultimoNuestro.creado <= hace(3) && delCliente.creado >= hace(21)) {
      const dias = Math.round((ahora - new Date(ultimoNuestro.creado)) / 86400_000);
      poner(c, 5, "🧊", `Dijo que le interesa y lleva ${dias} días sin seguimiento`);
    }
  }

  // 3) Cita que ya pasó y sigue sin cerrar.
  for (const ci of d
    .prepare(
      `SELECT ci.*, c.nombre, c.externo_id, c.id AS cid, l.nombre AS l_nombre, l.empresa, l.telefono, l.etapa
       FROM citas ci JOIN conversaciones c ON c.id = ci.conversacion_id LEFT JOIN leads l ON l.conversacion_id = c.id
       WHERE ci.estado = 'confirmada' AND ci.inicio < ? AND ci.inicio >= ? AND IFNULL(l.etapa,'') NOT IN ('ganado','perdido')`
    )
    .all(ahora.toISOString(), hace(14))) {
    poner({ ...ci, id: ci.cid }, 3, "🤝", "Tuvo cita contigo y no se ha cerrado: márcale para cerrar o reagendar");
  }

  // 4) Abrió su muestra 2+ veces en los últimos 3 días.
  for (const v of d
    .prepare(
      `SELECT json_extract(e.datos,'$.prospecto') AS pid, COUNT(*) AS veces FROM eventos e
       WHERE e.tipo = 'boceto_visto' AND e.creado >= ? GROUP BY pid HAVING veces >= 2`
    )
    .all(hace(3))) {
    const p = d.prepare("SELECT * FROM prospectos WHERE id = ? AND estado NOT IN ('no_contactar','descartado','cliente')").get(v.pid);
    if (!p || !p.telefono) continue;
    const c = d.prepare("SELECT c.*, l.nombre AS l_nombre, l.empresa, l.telefono, l.etapa FROM conversaciones c LEFT JOIN leads l ON l.conversacion_id = c.id WHERE c.id = ?").get(`wa:${p.telefono}`);
    if (c && ["ganado", "perdido"].includes(c.etapa)) continue;
    const ult = c && ultimo.get(c.id, "cliente");
    if (ult && DIJO_QUE_NO.test(ult.texto)) continue;
    poner(c || { id: `wa:${p.telefono}`, empresa: p.nombre, telefono: p.telefono, externo_id: p.telefono }, 4, "👀", `Abrió su muestra ${v.veces} veces en los últimos 3 días`);
  }

  return [...items.values()].sort((a, b) => a.prioridad - b.prioridad).slice(0, MAX);
}

/** Texto para WhatsApp, o null si hoy no hay a quién llamar. */
export function textoLlamarHoy(ahora = new Date(), tz = "America/Monterrey", marca = "Agente Sebax") {
  const lista = listaLlamarHoy(ahora, tz);
  if (!lista.length) return null;
  const lineas = lista.map((x, i) => `${i + 1}. ${x.emoji} *${x.nombre}*\n   ${x.motivo}${x.tel ? `\n   Tel. ${x.tel}` : ""}`);
  return `*${marca} · A quién llamar hoy*\n\nEstos son los más calientes. Una llamada tuya cierra más que diez mensajes del bot:\n\n${lineas.join("\n\n")}`;
}
