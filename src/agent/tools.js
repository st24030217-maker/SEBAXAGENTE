// Herramientas del agente de ventas. Claude decide cuándo usarlas; este archivo
// define qué hacen y valida TODO del lado del servidor (precios, descuentos, stock,
// horarios). El agente nunca puede saltarse estas reglas, aunque un cliente se lo pida.
import { getDb, getLead, upsertLead, logEvent, setBotActive, now } from "../db.js";
import { availableSlots, bookAppointment, formatLocal, prepararDia } from "../services/calendar.js";
import { gcalConfigurado, crearEventoGoogle } from "../services/gcal.js";
import { createPaymentLink } from "../services/payments.js";
import { notifyOwner } from "../services/notify.js";
import { formatMoney } from "./prompt.js";

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
        tipo: { type: "string", description: "Tipo de cita" },
        notas: { type: "string", description: "Tema de la cita y datos útiles" },
      },
      required: ["fecha", "hora"],
      additionalProperties: false,
    },
  },
  {
    name: "programar_seguimiento",
    description:
      "Programa un mensaje de seguimiento automático a este cliente (por ejemplo, si dijo que lo pensará o que le escribas otro día).",
    input_schema: {
      type: "object",
      properties: {
        en_horas: { type: "number", minimum: 1, maximum: 720, description: "En cuántas horas escribirle." },
        motivo: { type: "string", description: "Qué retomar en el seguimiento." },
      },
      required: ["en_horas", "motivo"],
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
    notifyOwner("pedido", `Pedido #${pedido.id} por ${formatMoney(cot.total, cot.moneda)} (${lead?.nombre || convId}) · pago: ${pago.metodo}`, {
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
    return { fecha: r.fecha, dia: r.dia, horarios_libres: r.slots.map((s) => s.hora), motivo: r.motivo };
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

  programar_seguimiento(input, { convId }) {
    const horas = Math.max(1, Math.min(720, Number(input.en_horas)));
    if (!Number.isFinite(horas)) throw new Error("en_horas debe ser un número");
    const cuando = new Date(Date.now() + horas * 3600_000).toISOString();
    getDb()
      .prepare("INSERT INTO seguimientos (conversacion_id, ejecutar_en, contexto, origen, creado) VALUES (?, ?, ?, 'agente', ?)")
      .run(convId, cuando, str(input.motivo), now());
    return { ok: true, programado_para: cuando };
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
