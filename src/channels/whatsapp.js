// WhatsApp Business (Meta Cloud API).
// Webhook: GET/POST /webhooks/whatsapp
import { Router } from "express";
import { settings } from "../config.js";
import { handleIncoming } from "../agent/agent.js";
import { verifyMetaSignature, verifyWebhookHandler } from "./metaSignature.js";
import { splitMessage, rateLimited } from "./index.js";

const GRAPH = "https://graph.facebook.com/v21.0";
const VENTANA_24H = 24 * 3600_000;

export function whatsappRouter() {
  const r = Router();
  r.get("/", verifyWebhookHandler(settings.whatsapp.verifyToken));
  r.post("/", (req, res) => {
    if (!verifyMetaSignature(req)) return res.sendStatus(401);
    res.sendStatus(200); // Meta exige respuesta rápida; procesamos después.
    procesar(req.body).catch((e) => console.error("[whatsapp]", e));
  });
  return r;
}

const vistos = new Set(); // Meta puede reenviar el mismo mensaje; evitamos responder dos veces.

async function procesar(body) {
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const contactos = Object.fromEntries((value.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
      for (const msg of value.messages || []) {
        if (vistos.has(msg.id)) continue;
        vistos.add(msg.id);
        if (vistos.size > 5000) vistos.clear();

        const from = msg.from;
        if (rateLimited(`wa:${from}`)) continue;
        marcarLeido(msg.id);

        let texto;
        if (msg.type === "text") texto = msg.text?.body;
        else if (msg.type === "interactive") texto = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title;
        else if (msg.type === "button") texto = msg.button?.text;
        else texto = `(El cliente envió un mensaje de tipo "${msg.type}" que no puedo ver. Pídele amablemente que lo escriba en texto.)`;
        if (!texto) continue;

        const { respuesta } = await handleIncoming({ canal: "whatsapp", externoId: from, texto, nombre: contactos[from] || null });
        if (respuesta) await sendWhatsApp(from, respuesta);
      }
    }
  }
}

function marcarLeido(messageId) {
  if (!settings.whatsapp.token) return;
  fetch(`${GRAPH}/${settings.whatsapp.phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${settings.whatsapp.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: messageId }),
  }).catch(() => {});
}

/**
 * Envía texto por WhatsApp. Fuera de la ventana de 24 h desde el último mensaje del cliente,
 * WhatsApp solo permite plantillas aprobadas: si hay una configurada se usa; si no, se lanza error.
 */
export async function sendWhatsApp(to, texto, { proactivo = false, ultimoMensajeCliente = null } = {}) {
  const { token, phoneNumberId, followupTemplate, templateLang } = settings.whatsapp;
  if (!token || !phoneNumberId) throw new Error("WhatsApp no está configurado (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID)");

  const fueraDeVentana =
    proactivo && (!ultimoMensajeCliente || Date.now() - new Date(ultimoMensajeCliente).getTime() > VENTANA_24H);

  const enviar = (payload) =>
    fetch(`${GRAPH}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, ...payload }),
    }).then(async (res) => {
      if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${(await res.text()).slice(0, 300)}`);
    });

  if (fueraDeVentana) {
    if (!followupTemplate) {
      throw new Error("Fuera de la ventana de 24 h de WhatsApp y no hay WHATSAPP_FOLLOWUP_TEMPLATE configurada");
    }
    // La plantilla debe tener un parámetro {{1}} en el cuerpo: ahí va el texto del seguimiento.
    return enviar({
      type: "template",
      template: {
        name: followupTemplate,
        language: { code: templateLang },
        components: [{ type: "body", parameters: [{ type: "text", text: texto.replace(/\s*\n+\s*/g, " ").slice(0, 1000) }] }],
      },
    });
  }
  for (const parte of splitMessage(texto, 4000)) {
    await enviar({ type: "text", text: { body: parte, preview_url: true } });
  }
}
