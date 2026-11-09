// Cambios de estado de pedidos (desde webhooks de pago o desde el panel).
import { getDb, now, upsertLead, logEvent, getConversation } from "../db.js";
import { getNegocio } from "../config.js";
import { notifyOwner } from "./notify.js";
import { sendToChannel } from "../channels/index.js";
import { recordOutgoing } from "../agent/agent.js";
import { formatMoney } from "../agent/prompt.js";

export const ESTADOS_PEDIDO = ["pendiente_pago", "pagado", "enviado", "entregado", "cancelado"];

const MENSAJES = {
  pagado: (p, n) =>
    `¡Recibimos tu pago del pedido #${p.id} por ${formatMoney(p.total, p.moneda)}! 🎉 Muchas gracias por tu compra en ${n.negocio.nombre}. ${
      p.entrega === "retiro" ? "Te avisamos cuando esté listo para retiro." : "Te avisaremos cuando sea despachado."
    }`,
  enviado: (p) => `Tu pedido #${p.id} ya fue despachado 🚚. Cualquier duda, escríbeme por aquí.`,
  entregado: (p) => `Tu pedido #${p.id} figura como entregado ✅. ¡Que lo disfrutes! Si necesitas algo más, aquí estoy.`,
  cancelado: (p) => `Tu pedido #${p.id} fue cancelado. Si fue un error o quieres retomarlo, respóndeme y lo vemos.`,
};

/**
 * Cambia el estado de un pedido, actualiza el CRM, avisa al dueño y al cliente.
 * Idempotente: si el pedido ya está en ese estado, no hace nada.
 */
export async function setOrderStatus(pedidoId, estado, { referencia = null, avisarCliente = true } = {}) {
  if (!ESTADOS_PEDIDO.includes(estado)) throw new Error(`Estado inválido: ${estado}`);
  const d = getDb();
  const p = d.prepare("SELECT * FROM pedidos WHERE id = ?").get(Number(pedidoId));
  if (!p) throw new Error(`Pedido ${pedidoId} no existe`);
  if (p.estado === estado) return p;

  d.prepare("UPDATE pedidos SET estado = ?, pago_ref = COALESCE(?, pago_ref), actualizado = ? WHERE id = ?").run(
    estado,
    referencia,
    now(),
    p.id
  );
  logEvent(`pedido_${estado}`, p.conversacion_id, { pedido: p.id, referencia });
  const negocio = getNegocio();

  if (estado === "pagado") {
    upsertLead(p.conversacion_id, { etapa: "ganado", puntaje: 10 });
    notifyOwner("pago", `💰 Pago recibido: pedido #${p.id} por ${formatMoney(p.total, p.moneda)}`, { pedido: p.id, total: p.total });
  }

  const conv = getConversation(p.conversacion_id);
  if (avisarCliente && conv && MENSAJES[estado]) {
    const texto = MENSAJES[estado](p, negocio);
    try {
      await sendToChannel(conv.canal, conv.externo_id, texto, {
        proactivo: true,
        ultimoMensajeCliente: conv.ultimo_mensaje_cliente,
        humano: true,
      });
      await recordOutgoing(conv.id, texto, "agente", "El sistema de pedidos");
    } catch (e) {
      console.error(`[pedidos] no se pudo avisar al cliente del pedido #${p.id}:`, e.message);
    }
  }
  return d.prepare("SELECT * FROM pedidos WHERE id = ?").get(p.id);
}
