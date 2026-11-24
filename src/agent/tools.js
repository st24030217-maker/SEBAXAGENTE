// Herramientas del agente de ventas. Claude decide cuándo usarlas; este archivo
// define qué hacen y valida TODO del lado del servidor (precios, descuentos, stock,
// horarios). El agente nunca puede saltarse estas reglas, aunque un cliente se lo pida.
import { getDb, getLead, upsertLead, logEvent, setBotActive, now, getOrCreateConversation } from "../db.js";
import { availableSlots, bookAppointment, formatLocal, prepararDia, zonedToUtc } from "../services/calendar.js";
import { gcalConfigurado, crearEventoGoogle } from "../services/gcal.js";
import { createPaymentLink } from "../services/payments.js";
import { notifyOwner } from "../services/notify.js";
import { formatMoney } from "./prompt.js";
import { negocioActual } from "../contexto.js";

const ETAPAS = ["nuevo", "interesado", "cotizado", "negociacion", "ganado", "perdido"];
const ENTREGAS = ["despacho_santiago", "despacho_regiones", "retiro", "sin_envio"];

export const TOOL_DEFINITIONS = [
  {
    name: "guardar_cliente",
    description:
      "Guarda o actualiza los datos del cliente (lead) en el CRM. Úsala apenas el cliente comparta su nombre, teléfono, email, empresa, necesidad o presupuesto. Solo envía los campos que conozcas.",
    input_schema: {
      type: "object",
      properties: {
        nombre: { type: "string" },
        telefono: { type: "string" },
        email: { type: "string" },
        empresa: { type: "string" },
        necesidad: { type: "string", description: "Qué busca el cliente y para qué, en una frase." },
        presupuesto: { type: "string" },
        notas: { type: "string", description: "Información útil para el equipo de ventas." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "actualizar_etapa",
    description:
      "Actualiza la etapa del cliente en el embudo de ventas y tu estimación de probabilidad de compra. Úsala cuando la etapa cambie (por ejemplo, muestra interés real, recibe cotización, negocia, o descarta la compra).",
    input_schema: {
      type: "object",
      properties: {
        etapa: { type: "string", enum: ETAPAS },
        puntaje: { type: "integer", minimum: 1, maximum: 10, description: "Probabilidad de compra estimada, 1 a 10." },
        motivo: { type: "string", description: "Por qué cambió la etapa (obligatorio si es 'perdido')." },
      },
      required: ["etapa"],
      additionalProperties: false,
    },
  },
  {
    name: "crear_cotizacion",
    description:
      "Crea una cotización oficial con precios del catálogo, calcula descuento, envío y total. Úsala siempre antes de dar un total final o de crear un pedido. Devuelve el id de la cotización y el detalle para mostrar al cliente.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              producto_id: { type: "string", description: "id del catálogo, por ejemplo NB-001" },
              cantidad: { type: "integer", minimum: 1 },
            },
            required: ["producto_id", "cantidad"],
            additionalProperties: false,
          },
        },
        descuento_porcentaje: { type: "number", minimum: 0, description: "Descuento sobre los productos, respetando el máximo permitido." },
        entrega: { type: "string", enum: ENTREGAS, description: "Forma de entrega para calcular el envío. Usa sin_envio para servicios." },
        notas: { type: "string" },
      },
      required: ["items", "entrega"],
      additionalProperties: false,
    },
  },
  {
    name: "crear_pedido",
    description:
      "Convierte una cotización aceptada en pedido y genera el link de pago (o las instrucciones de transferencia). Úsala solo cuando el cliente confirme que quiere comprar.",
    input_schema: {
      type: "object",
      properties: {
        cotizacion_id: { type: "integer" },
        direccion: { type: "string", description: "Dirección completa de despacho (obligatoria si hay despacho)." },
        datos_facturacion: { type: "string", description: "RUT/ID fiscal, razón social y giro, solo si pide factura." },
      },
      required: ["cotizacion_id"],
      additionalProperties: false,
    },
  },
  {
    name: "consultar_pedidos",
    description: "Lista los pedidos de este cliente con su estado de pago y entrega.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "ver_horarios_disponibles",
    description: "Muestra los horarios libres para agendar una cita en una fecha. Consulta antes de proponer horarios.",
    input_schema: {
      type: "object",
      properties: { fecha: { type: "string", description: "Fecha local en formato YYYY-MM-DD" } },
      required: ["fecha"],
      additionalProperties: false,
    },
  },
  {
    name: "agendar_cita",
    description: "Agenda una cita en un horario libre, después de que el cliente lo confirme.",
    input_schema: {
      type: "object",
      properties: {
        fecha: { type: "string", description: "YYYY-MM-DD" },
        hora: { type: "string", description: "HH:MM, uno de los horarios libres" },
        tipo: { type: "string", description: "Tipo de cita, uno de los que se ofrecen ese día (ver tipos_de_cita_ese_dia)" },
        notas: { type: "string", description: "Tema de la cita y datos útiles" },
      },
      required: ["fecha", "hora"],
      additionalProperties: false,
    },
  },
  {
    name: "programar_seguimiento",
    description:
      "Programa un mensaje de seguimiento automático a este cliente (por ejemplo, si dijo que lo pensará o que le escribas otro día). Si le prometiste un día y hora ('el lunes a las 3'), usa fecha y hora exactas (hora local del negocio) para que salga justo a esa hora; en_horas solo para plazos aproximados ('en un par de días').",
    input_schema: {
      type: "object",
      properties: {
        fecha: { type: "string", description: "YYYY-MM-DD, día local en que se le escribe (junto con hora)." },
        hora: { type: "string", description: "HH:MM en formato 24 h, hora local del negocio (por ejemplo 15:00 para las 3 pm)." },
        en_horas: { type: "number", minimum: 1, maximum: 720, description: "En cuántas horas escribirle (solo si no hay fecha y hora exactas)." },
        motivo: { type: "string", description: "Qué retomar en el seguimiento." },
      },
      required: ["motivo"],
      additionalProperties: false,
    },
  },
  {
    name: "enviar_video_presentacion",
    description:
      "Manda por WhatsApp el video corto de presentación de Sebastián y sss.solutions (quiénes somos). Úsala si el cliente pregunta quiénes son, duda si es real o confiable, o quiere conocer más antes de agendar. Solo una vez por conversación y solo en WhatsApp.",
    input_schema: {
      type: "object",
      properties: {
        mensaje: { type: "string", description: "Texto corto que va abajo del video, por ejemplo: 'Te dejo un video corto para que nos conozcas.'" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "mandar_propuesta_a_otro_numero",
    description:
      "Cuando en este chat te pidan mandar la propuesta, la información o la muestra a OTRO número de WhatsApp (por ejemplo 'este número es de ventas, mándalo al 871...', 'escríbele al encargado a este número'), úsala de inmediato con ese número: abre el chat nuevo y le manda la propuesta con su muestra y el video. No preguntes a nombre de quién: si te dieron el nombre del encargado, ponlo; si no, mándala igual. La persona de ESTE chat no es el encargado: nunca la llames por el nombre del encargado. Solo WhatsApp.",
    input_schema: {
      type: "object",
      properties: {
        telefono: { type: "string", description: "El otro número, tal como lo dieron (10 dígitos de México)." },
        nombre_contacto: { type: "string", description: "Nombre de la persona de ese número, si lo dieron (por ejemplo 'Guillermo Gutiérrez')." },
        cargo: { type: "string", description: "Su puesto, si lo dijeron (dueño, gerente, encargado de marketing...)." },
      },
      required: ["telefono"],
      additionalProperties: false,
    },
  },
  {
    name: "derivar_a_humano",
    description:
      "Pasa la conversación a una persona del equipo y pausa al agente en este chat. Úsala si el cliente lo pide, hay un reclamo, molestia, una negociación especial o algo que no puedes resolver.",
    input_schema: {
      type: "object",
      properties: {
        motivo: { type: "string" },
        urgencia: { type: "string", enum: ["baja", "media", "alta"] },
        resumen: { type: "string", description: "Resumen breve de la conversación para el humano." },
      },
      required: ["motivo", "urgencia", "resumen"],
      additionalProperties: false,
    },
  },
];

const str = (v) => (typeof v === "string" ? v.trim() : v === undefined || v === null ? undefined : String(v));

/**
 * Ejecuta una herramienta. Devuelve un objeto serializable.
 * Lanza Error con un mensaje claro si la entrada es inválida (se le devuelve a Claude como is_error).
 */
export async function executeTool(name, input, ctx) {
  const fn = HANDLERS[name];
  if (!fn) throw new Error(`Herramienta desconocida: ${name}`);
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("La entrada debe ser un objeto JSON");
  return fn(input, ctx);
}

const HANDLERS = {
  guardar_cliente(input, { convId, canal, conv }) {
    const fields = {
      nombre: str(input.nombre),
      telefono: str(input.telefono),
      email: str(input.email),
      empresa: str(input.empresa),
      necesidad: str(input.necesidad),
      presupuesto: str(input.presupuesto),
      notas: str(input.notas),
    };
    if (fields.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)) throw new Error(`Email inválido: ${fields.email}`);
    // En WhatsApp el id externo ya es el teléfono del cliente.
    if (!fields.telefono && canal === "whatsapp" && !getLead(convId)?.telefono) fields.telefono = `+${conv.externo_id}`;
    const esNuevo = !getLead(convId);
    const lead = upsertLead(convId, fields);
    if (esNuevo) {
      notifyOwner("lead_nuevo", `Nuevo lead (${canal}): ${lead.nombre || "sin nombre"} · ${lead.necesidad || ""}`, { lead });
    }
    return { ok: true, lead: pickLead(lead) };
  },

  actualizar_etapa(input, { convId }) {
    if (!ETAPAS.includes(input.etapa)) throw new Error(`Etapa inválida. Usa: ${ETAPAS.join(", ")}`);
    const puntaje = input.puntaje === undefined ? undefined : Math.max(1, Math.min(10, Math.round(Number(input.puntaje))));
    const fields = { etapa: input.etapa, puntaje };
    if (input.etapa === "perdido") fields.motivo_perdida = str(input.motivo) || "sin motivo";
    else if (input.motivo) fields.notas = `[${input.etapa}] ${str(input.motivo)}`;
    const lead = upsertLead(convId, fields);
    logEvent("etapa", convId, { etapa: input.etapa, puntaje });
    if (input.etapa === "perdido") cancelAutoFollowups(convId);
    return { ok: true, lead: pickLead(lead) };
  },

  crear_cotizacion(input, { convId, negocio }) {
    const q = computeQuote(input, negocio);
    const valida = new Date(Date.now() + 7 * 86400_000).toISOString();
    const r = getDb()
      .prepare(
        `INSERT INTO cotizaciones (conversacion_id, items, subtotal, descuento_pct, descuento_monto, envio, total, moneda, notas, valida_hasta, creado)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        convId,
        JSON.stringify({ items: q.items, entrega: q.entrega }),
        q.subtotal,
        q.descuento_pct,
        q.descuento_monto,
        q.envio,
        q.total,
        q.moneda,
        str(input.notas) || null,
        valida,
        now()
      );
    const id = Number(r.lastInsertRowid);
    const lead = getLead(convId);
    if (!lead || ["nuevo", "interesado"].includes(lead.etapa)) upsertLead(convId, { etapa: "cotizado" });
    logEvent("cotizacion", convId, { id, total: q.total });
    notifyOwner("cotizacion", `Cotización #${id} por ${formatMoney(q.total, q.moneda)} (${lead?.nombre || convId})`, { id, ...q });
    const m = (v) => formatMoney(v, q.moneda);
    return {
      ok: true,
      cotizacion_id: id,
      valida_hasta: formatLocal(valida, negocio.negocio.zona_horaria, { soloFecha: true }),
      detalle: q.items.map((it) => `${it.cantidad} x ${it.nombre} (${m(it.precio)} c/u) = ${m(it.precio * it.cantidad)}`),
      subtotal: m(q.subtotal),
      descuento: q.descuento_pct ? `${q.descuento_pct}% (-${m(q.descuento_monto)})` : "sin descuento",
      envio: q.envio ? m(q.envio) : q.entrega === "retiro" ? "retiro en tienda (gratis)" : "gratis",
      total: m(q.total),
      avisos: q.avisos,
    };
  },

  async crear_pedido(input, { convId, negocio }) {
    const d = getDb();
    const cot = d.prepare("SELECT * FROM cotizaciones WHERE id = ? AND conversacion_id = ?").get(Number(input.cotizacion_id), convId);
    if (!cot) throw new Error(`No existe la cotización ${input.cotizacion_id} en esta conversación`);
    if (new Date(cot.valida_hasta) < new Date()) throw new Error("La cotización venció. Crea una nueva con crear_cotizacion.");
    const existente = d.prepare("SELECT * FROM pedidos WHERE cotizacion_id = ? AND estado != 'cancelado'").get(cot.id);
    if (existente) {
      return {
        ok: true,
        aviso: "Ya existía un pedido para esta cotización",
        pedido_id: existente.id,
        estado: existente.estado,
        link_pago: existente.link_pago,
      };
    }
    const { items, entrega } = JSON.parse(cot.items);
    const esDespacho = entrega?.startsWith("despacho");
    const direccion = str(input.direccion);
    if (esDespacho && !direccion) throw new Error("Falta la dirección de despacho. Pídesela al cliente.");

    const t = now();
    const r = d
      .prepare(
        `INSERT INTO pedidos (conversacion_id, cotizacion_id, total, moneda, entrega, direccion, datos_facturacion, creado, actualizado)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(convId, cot.id, cot.total, cot.moneda, entrega, direccion || null, str(input.datos_facturacion) || null, t, t);
    const pedido = { id: Number(r.lastInsertRowid), total: cot.total };

    const lineas = items.map((it) => ({ ...it }));
    if (cot.envio > 0) lineas.push({ id: "ENVIO", nombre: "Despacho", cantidad: 1, precio_final_unitario: cot.envio });

    let pago;
    try {
      pago = await createPaymentLink(pedido, lineas, negocio);
    } catch (err) {
      console.error("[pagos]", err.message);
      notifyOwner("error", `No se pudo generar el link de pago del pedido #${pedido.id}: ${err.message}`);
      pago = {
        metodo: "transferencia",
        link: null,
        instrucciones: negocio.pagos?.instrucciones_transferencia || "El equipo te enviará los datos de pago.",
        referencia: null,
      };
    }
    d.prepare("UPDATE pedidos SET metodo_pago = ?, link_pago = ?, pago_ref = ? WHERE id = ?").run(
      pago.metodo,
      pago.link,
      pago.referencia,
      pedido.id
    );
    upsertLead(convId, { etapa: "negociacion" });
    logEvent("pedido", convId, { id: pedido.id, total: cot.total, metodo: pago.metodo });
    const lead = getLead(convId);
    const esAnticipo = items.some((it) => it.id === "ANTICIPO");
    notifyOwner("pedido", `${esAnticipo ? "¡Dijo que va! " : ""}Pedido #${pedido.id} por ${formatMoney(cot.total, cot.moneda)} (${[lead?.nombre, lead?.empresa].filter(Boolean).join(" · ") || convId}) · pago: ${pago.metodo}${pago.link ? `\nYa le mandé el link de pago: ${pago.link}` : "\nNo hay link de pago configurado: mándale tú los datos para el depósito."}`, {
      pedido_id: pedido.id,
      total: cot.total,
      entrega,
      direccion,
    });
    return {
      ok: true,
      pedido_id: pedido.id,
      total: formatMoney(cot.total, cot.moneda),
      metodo_pago: pago.metodo,
      link_pago: pago.link,
      instrucciones_pago: pago.instrucciones,
      siguiente_paso: pago.link
        ? "Envía el link de pago al cliente. El sistema confirmará el pago automáticamente."
        : "Envía las instrucciones de transferencia y pide el comprobante por este chat.",
    };
  },

  consultar_pedidos(_input, { convId }) {
    const pedidos = getDb()
      .prepare("SELECT id, total, moneda, estado, metodo_pago, link_pago, entrega, creado FROM pedidos WHERE conversacion_id = ? ORDER BY id DESC LIMIT 10")
      .all(convId)
      .map((p) => ({ ...p, total: formatMoney(p.total, p.moneda) }));
    return { pedidos, cantidad: pedidos.length };
  },

  async ver_horarios_disponibles(input, { negocio }) {
    if (!negocio.citas?.activo) throw new Error("Las citas no están habilitadas");
    await prepararDia(str(input.fecha), negocio);
    const r = availableSlots(str(input.fecha), negocio);
    return { fecha: r.fecha, dia: r.dia, horarios_libres: r.slots.map((s) => s.hora), tipos_de_cita_ese_dia: r.tipos, motivo: r.motivo };
  },

  async agendar_cita(input, { convId, negocio }) {
    if (!negocio.citas?.activo) throw new Error("Las citas no están habilitadas");
    // Se revisa tu Google Calendar justo antes, para no encimar la cita con algo que ya tengas.
    await prepararDia(str(input.fecha), negocio);
    const r = bookAppointment(
      { convId, fecha: str(input.fecha), hora: str(input.hora), tipo: str(input.tipo), notas: str(input.notas) },
      negocio
    );
    if (r.ok) {
      input = { ...input, tipo: r.tipo || input.tipo };
      logEvent("cita", convId, r);
      const lead = getLead(convId);
      const quien = [lead?.nombre, lead?.empresa].filter(Boolean).join(" · ") || convId;
      // Se anota en tu Google Calendar. Si falla, la cita sigue agendada y el aviso te lo dice.
      let enCalendario = false;
      if (gcalConfigurado()) {
        try {
          await crearEventoGoogle({
            inicio: r.inicio,
            fin: r.fin,
            zona: negocio.negocio.zona_horaria,
            titulo: `${input.tipo || "Cita"} · ${quien}`,
            descripcion: [lead?.telefono && `Tel. ${lead.telefono}`, lead?.email, lead?.necesidad, input.notas && `Notas: ${input.notas}`, "Agendada por tu agente de ventas."].filter(Boolean).join("\n"),
          });
          enCalendario = true;
        } catch (e) {
          console.error("[calendar] no se pudo anotar en Google Calendar:", e.message);
        }
      }
      notifyOwner(
        "cita",
        `Cita agendada: ${r.descripcion} · ${input.tipo || "reunión"} · ${quien}${lead?.telefono ? ` · tel. ${lead.telefono}` : ""}${lead?.email ? ` · ${lead.email}` : ""}${input.notas ? `
Notas: ${input.notas}` : ""}`,
        { ...r, tipo: input.tipo || "reunión", notas: input.notas || "", lead, enCalendario, gcal: gcalConfigurado() }
      );
    }
    return r;
  },

  programar_seguimiento(input, { convId, negocio }) {
    const tz = negocio.negocio.zona_horaria;
    let cuando;
    if (input.fecha || input.hora) {
      const fecha = str(input.fecha);
      const hora = str(input.hora);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || "") || !/^\d{1,2}:\d{2}$/.test(hora || "")) throw new Error("Usa fecha YYYY-MM-DD y hora HH:MM (24 h), o solo en_horas");
      const t = zonedToUtc(fecha, hora.padStart(5, "0"), tz);
      if (Number.isNaN(t.getTime())) throw new Error("Fecha u hora inválida");
      if (t.getTime() < Date.now() + 10 * 60_000) throw new Error("Esa fecha y hora ya pasó o es en menos de 10 minutos");
      if (t.getTime() > Date.now() + 720 * 3600_000) throw new Error("El seguimiento puede ser a lo mucho en 30 días");
      cuando = t.toISOString();
    } else {
      const horas = Math.max(1, Math.min(720, Number(input.en_horas)));
      if (!Number.isFinite(horas)) throw new Error("Falta en_horas, o fecha y hora");
      cuando = new Date(Date.now() + horas * 3600_000).toISOString();
    }
    getDb()
      .prepare("INSERT INTO seguimientos (conversacion_id, ejecutar_en, contexto, origen, creado) VALUES (?, ?, ?, 'agente', ?)")
      .run(convId, cuando, str(input.motivo), now());
    return { ok: true, programado_para: formatLocal(cuando, tz) };
  },

  async enviar_video_presentacion(input, { convId, canal, conv }) {
    if (negocioActual()) return { ok: false, motivo: "Esta herramienta no está disponible para este negocio." };
    if (canal !== "wa") return { ok: false, motivo: "El video solo se puede mandar por WhatsApp. Comparte el portafolio en su lugar." };
    const wa = await import("../channels/wa-web.js");
    if (!wa.videoPresentacion()) return { ok: false, motivo: "No hay video cargado. Comparte el link del portafolio en su lugar." };
    const tel = conv.externo_id;
    const ya = getDb()
      .prepare(
        `SELECT 1 FROM eventos WHERE (tipo = 'video_enviado' AND conversacion_id = ?)
           OR (tipo = 'prospecto_whatsapp' AND json_extract(datos, '$.telefono') = ? AND json_extract(datos, '$.video') = 1) LIMIT 1`
      )
      .get(convId, tel);
    if (ya) return { ok: false, motivo: "Este cliente ya recibió el video. No lo mandes otra vez; sigue la conversación." };
    await wa.sendWaVideo(tel, str(input.mensaje) || "");
    logEvent("video_enviado", convId, {});
    return { ok: true, mensaje: "Video enviado. No lo repitas; sigue la conversación y busca agendar la llamada." };
  },

  async mandar_propuesta_a_otro_numero(input, { convId, canal, conv }) {
    if (negocioActual()) return { ok: false, motivo: "Esta herramienta no está disponible para este negocio." };
    if (canal !== "wa") return { ok: false, motivo: "Solo funciona en WhatsApp. Dile que Sebastián le escribe a ese número." };
    const wa = await import("../channels/wa-web.js");
    const tel = wa.diezDigitos(input.telefono);
    if (!/^\d{10}$/.test(tel)) throw new Error("El número debe tener 10 dígitos. Pídeselo completo.");
    if (tel === wa.diezDigitos(conv.externo_id)) return { ok: false, motivo: "Es el mismo número de este chat." };
    if (tel === wa.numeroDueno() || tel === wa.numeroChip()) return { ok: false, motivo: "Ese número es de Sebastián; no se le manda la propuesta." };
    const d = getDb();
    const reenvios = d.prepare("SELECT COUNT(*) n FROM eventos WHERE tipo = 'propuesta_otro_numero' AND conversacion_id = ?").get(convId).n;
    if (reenvios >= 2) return { ok: false, motivo: "Ya se mandó la propuesta a otros números desde este chat. Usa derivar_a_humano." };
    const destinoId = `wa:${tel}`;
    const existente = d.prepare("SELECT historial FROM conversaciones WHERE id = ?").get(destinoId);
    if (existente && existente.historial && existente.historial !== "[]") {
      return { ok: true, ya_existia: true, mensaje: "Ya había un chat con ese número, así que no se le volvió a escribir. Agradece y dile que Sebastián da seguimiento por ahí." };
    }
    if (d.prepare("SELECT 1 FROM prospectos WHERE telefono = ? AND estado = 'no_contactar'").get(tel)) {
      return { ok: false, motivo: "Ese número pidió no ser contactado. Usa derivar_a_humano." };
    }

    const nombre = str(input.nombre_contacto);
    const primer = nombre ? nombre.split(/\s+/)[0] : "";
    const p = d.prepare("SELECT * FROM prospectos WHERE telefono = ? ORDER BY id DESC LIMIT 1").get(wa.diezDigitos(conv.externo_id));
    const lead = getLead(convId);
    const negocioNombre = p?.nombre || lead?.empresa || conv.nombre || "su negocio";
    let texto;
    if (p?.whatsapp_texto) {
      // El mismo mensaje que recibió el negocio, presentándose con el encargado y diciendo de dónde salió su número.
      const partes = p.whatsapp_texto.split(/\n\s*\n/);
      const saludo = partes[0].startsWith("Hola")
        ? partes.shift().replace(/^Hola, buen día\./, `Hola, buen día${primer ? `, ${primer}` : ""}.`)
        : `Hola, buen día${primer ? `, ${primer}` : ""}. Soy Sebastián.`;
      texto = [`${saludo} Me pasaron su número del WhatsApp de ${negocioNombre} para enviarle la propuesta.`, ...partes].join("\n\n");
    } else {
      texto = `Hola, buen día${primer ? `, ${primer}` : ""}. Soy Sebastián, de sss.solutions (páginas web, apps y menús digitales con pedidos por WhatsApp). Me pasaron su número del WhatsApp de ${negocioNombre} para enviarle la propuesta.\n\nAquí puede ver algunos de nuestros trabajos: https://www.instagram.com/ssss.olutions\n\n¿Le parece si lo platicamos 10 minutos?`;
    }
    if (p?.boceto) {
      const { asegurarPublicada } = await import("../prospeccion/publicar.js");
      await asegurarPublicada(p);
    }

    const conVideo = !!wa.videoPresentacion();
    try {
      if (conVideo) await wa.sendWaVideo(tel, texto);
      else await wa.sendWaWeb(tel, texto);
    } catch (e) {
      notifyOwner("error", `No pude mandar la propuesta de ${negocioNombre} al ${tel}: ${e.message}. Mándasela tú.`, { tel });
      return { ok: false, motivo: `No se pudo enviar (${e.message}). Dile que Sebastián le escribe personalmente a ese número.` };
    }

    const { recordOutgoing } = await import("./agent.js");
    const c =getOrCreateConversation("wa", tel, nombre ? `${nombre} (${negocioNombre})` : `Encargado de ${negocioNombre}`);
    const quien = [nombre, str(input.cargo)].filter(Boolean).join(", ") || "la persona encargada";
    await recordOutgoing(
      c.id,
      texto,
      "agente",
      `[Prospección] Este chat es con ${quien} de ${negocioNombre}${p ? ` (${p.giro || p.rubro || ""}, ${[p.colonia, p.ciudad].filter(Boolean).join(", ")})` : ""}. En el WhatsApp del negocio (${wa.diezDigitos(conv.externo_id)}) pidieron mandarle la propuesta a este número. Ya recibió${conVideo ? " el video de presentación y" : ""} la muestra: no se los vuelvas a mandar. El asistente`
    );
    upsertLead(c.id, { nombre: nombre || undefined, empresa: negocioNombre, telefono: tel, necesidad: lead?.necesidad || undefined, etapa: "interesado" });
    logEvent("propuesta_otro_numero", convId, { telefono: tel, nombre, prospecto: p?.id || null, video: conVideo });
    notifyOwner(
      "lead_nuevo",
      `${negocioNombre} pidió mandar la propuesta a otro número: ${nombre || "el encargado"}${input.cargo ? ` (${input.cargo})` : ""}, tel. ${tel}. Ya se la mandé${conVideo ? " con el video" : ""}; si contesta, el agente lo atiende.`,
      { convId, telefono: tel }
    );
    // En el número original ya no hay nada que vender: el agente se despide y ahí se queda en pausa.
    setBotActive(convId, false);
    return {
      ok: true,
      enviado_a: tel,
      mensaje: `Propuesta enviada a ${nombre || "ese número"}. Ahora agradece en UNA frase corta y confirma que ya se la mandaste${nombre ? ` a ${nombre}` : ""}. La persona de este chat NO es ${nombre || "el encargado"}: no la llames así. No propongas visitas ni hagas preguntas aquí; este chat queda en pausa.`,
    };
  },

  derivar_a_humano(input, { convId, canal }) {
    setBotActive(convId, false);
    upsertLead(convId, { notas: `[derivado: ${input.urgencia}] ${str(input.motivo)}` });
    logEvent("derivacion", convId, input);
    const lead = getLead(convId);
    notifyOwner(
      "derivacion",
      `Cliente pide atención humana (${input.urgencia}) en ${canal}: ${lead?.nombre || convId}\nMotivo: ${input.motivo}\nResumen: ${input.resumen}`,
      { convId, ...input }
    );
    return {
      ok: true,
      mensaje:
        "Conversación derivada. El agente queda en pausa en este chat hasta que el equipo lo reactive. Despídete avisando que una persona del equipo lo contactará pronto (dentro del horario de atención).",
    };
  },
};

/** Calcula una cotización con precios del catálogo. Exportada para tests. */
export function computeQuote(input, negocio) {
  const moneda = negocio.negocio.moneda;
  const maxDesc = Number(negocio.descuentos?.maximo_porcentaje ?? 0);
  const desc = Number(input.descuento_porcentaje || 0);
  if (!Number.isFinite(desc) || desc < 0) throw new Error("Descuento inválido");
  if (desc > maxDesc) throw new Error(`Descuento de ${desc}% no permitido. El máximo es ${maxDesc}%. Si el cliente necesita más, deriva a un humano.`);
  const entrega = input.entrega || "sin_envio";
  if (!ENTREGAS.includes(entrega)) throw new Error(`Entrega inválida. Usa: ${ENTREGAS.join(", ")}`);
  if (!Array.isArray(input.items) || input.items.length === 0) throw new Error("La cotización necesita al menos un producto");

  const avisos = [];
  const agrupados = new Map();
  for (const it of input.items) {
    const cantidad = Math.floor(Number(it.cantidad));
    if (!Number.isFinite(cantidad) || cantidad < 1 || cantidad > 1000) throw new Error(`Cantidad inválida para ${it.producto_id}`);
    agrupados.set(it.producto_id, (agrupados.get(it.producto_id) || 0) + cantidad);
  }

  const items = [];
  for (const [id, cantidad] of agrupados) {
    const p = negocio.catalogo.find((x) => x.id === id);
    if (!p) throw new Error(`El producto ${id} no existe en el catálogo`);
    if (p.precio === null) throw new Error(`${p.nombre} se cotiza a la medida: no generes cotización. Ofrece agendar la cita de diagnóstico para que el equipo prepare la propuesta.`);
    if (typeof p.stock === "number") {
      if (p.stock <= 0) throw new Error(`${p.nombre} está agotado`);
      if (cantidad > p.stock) throw new Error(`Solo hay ${p.stock} unidades de ${p.nombre}`);
    }
    const unit = redondear(p.precio * (1 - desc / 100), moneda);
    items.push({ id: p.id, nombre: p.nombre, precio: p.precio, cantidad, precio_final_unitario: unit });
  }

  const subtotal = items.reduce((s, it) => s + it.precio * it.cantidad, 0);
  const conDescuento = items.reduce((s, it) => s + it.precio_final_unitario * it.cantidad, 0);
  const descuento_monto = redondear(subtotal - conDescuento, moneda);

  const env = negocio.envio || {};
  let envio = 0;
  if (entrega === "despacho_santiago") envio = Number(env.costo_santiago || 0);
  if (entrega === "despacho_regiones") envio = Number(env.costo_regiones || 0);
  if (envio && env.gratis_desde && conDescuento >= Number(env.gratis_desde)) {
    envio = 0;
    avisos.push("Envío gratis por monto de compra");
  }
  return {
    items,
    entrega,
    subtotal,
    descuento_pct: desc,
    descuento_monto,
    envio,
    total: redondear(conDescuento + envio, moneda),
    moneda,
    avisos,
  };
}

function redondear(v, moneda) {
  return ["CLP", "COP", "PYG", "JPY", "KRW"].includes(moneda) ? Math.round(v) : Math.round(v * 100) / 100;
}

function pickLead(l) {
  return l && { nombre: l.nombre, telefono: l.telefono, email: l.email, empresa: l.empresa, etapa: l.etapa, puntaje: l.puntaje };
}

function cancelAutoFollowups(convId) {
  getDb().prepare("UPDATE seguimientos SET estado = 'cancelado' WHERE conversacion_id = ? AND estado = 'pendiente'").run(convId);
}

export { ETAPAS };
