// Links de pago: Mercado Pago (Checkout Pro), Stripe (Checkout) o manual (transferencia).
import crypto from "node:crypto";
import { settings } from "../config.js";

const ZERO_DECIMAL = new Set(["CLP", "JPY", "KRW", "PYG", "VND", "XOF", "XAF", "UGX", "RWF", "ISK"]);

/**
 * Crea el link de pago de un pedido.
 * @returns {Promise<{metodo: string, link: string|null, instrucciones: string|null, referencia: string|null}>}
 */
export async function createPaymentLink(pedido, items, negocio) {
  const provider = settings.payments.provider;
  const moneda = negocio.negocio.moneda;
  const ref = `pedido-${pedido.id}`;

  if (provider === "mercadopago" && settings.payments.mercadopagoToken) {
    const body = {
      items: items.map((it) => ({
        id: it.id,
        title: it.nombre,
        quantity: it.cantidad,
        unit_price: it.precio_final_unitario,
        currency_id: moneda,
      })),
      external_reference: ref,
      notification_url: `${settings.publicUrl}/webhooks/mercadopago`,
      back_urls: {
        success: `${settings.publicUrl}/pago/ok?pedido=${pedido.id}`,
        failure: `${settings.publicUrl}/pago/error?pedido=${pedido.id}`,
        pending: `${settings.publicUrl}/pago/pendiente?pedido=${pedido.id}`,
      },
      statement_descriptor: negocio.negocio.nombre.slice(0, 22),
    };
    const res = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: { Authorization: `Bearer ${settings.payments.mercadopagoToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Mercado Pago: ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
    return { metodo: "mercadopago", link: data.init_point, instrucciones: null, referencia: data.id };
  }

  if (provider === "stripe" && settings.payments.stripeKey) {
    const factor = ZERO_DECIMAL.has(moneda.toUpperCase()) ? 1 : 100;
    const form = new URLSearchParams();
    form.set("mode", "payment");
    form.set("success_url", `${settings.publicUrl}/pago/ok?pedido=${pedido.id}`);
    form.set("cancel_url", `${settings.publicUrl}/pago/error?pedido=${pedido.id}`);
    form.set("client_reference_id", ref);
    form.set("metadata[pedido_id]", String(pedido.id));
    items.forEach((it, i) => {
      form.set(`line_items[${i}][quantity]`, String(it.cantidad));
      form.set(`line_items[${i}][price_data][currency]`, moneda.toLowerCase());
      form.set(`line_items[${i}][price_data][unit_amount]`, String(Math.round(it.precio_final_unitario * factor)));
      form.set(`line_items[${i}][price_data][product_data][name]`, it.nombre);
    });
    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${settings.payments.stripeKey}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Stripe: ${res.status} ${data?.error?.message || ""}`);
    return { metodo: "stripe", link: data.url, instrucciones: null, referencia: data.id };
  }

  return {
    metodo: "transferencia",
    link: null,
    instrucciones: negocio.pagos?.instrucciones_transferencia || "Coordina el pago con el equipo de ventas.",
    referencia: null,
  };
}

/** Consulta un pago de Mercado Pago. Devuelve {aprobado, pedidoId, referencia}. */
export async function fetchMercadoPagoPayment(paymentId) {
  const res = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `Bearer ${settings.payments.mercadopagoToken}` },
  });
  if (!res.ok) throw new Error(`Mercado Pago pago ${paymentId}: ${res.status}`);
  const p = await res.json();
  const m = /^pedido-(\d+)$/.exec(p.external_reference || "");
  return { aprobado: p.status === "approved", pedidoId: m ? Number(m[1]) : null, referencia: String(p.id) };
}

/** Verifica la firma "Stripe-Signature" (t=...,v1=...) de un webhook. */
export function verifyStripeSignature(rawBody, header, secret, toleranceSec = 300) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(
    header.split(",").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i), kv.slice(i + 1)];
    })
  );
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const signatures = header
    .split(",")
    .filter((kv) => kv.startsWith("v1="))
    .map((kv) => kv.slice(3));
  return signatures.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}
