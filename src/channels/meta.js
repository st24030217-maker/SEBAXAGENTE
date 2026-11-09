// Facebook Messenger e Instagram DM (Meta Graph API, Messenger Platform).
// Webhook: GET/POST /webhooks/meta
import { Router } from "express";
import { settings } from "../config.js";
import { handleIncoming } from "../agent/agent.js";
import { verifyMetaSignature, verifyWebhookHandler } from "./metaSignature.js";
import { splitMessage, rateLimited } from "./index.js";

const GRAPH = "https://graph.facebook.com/v21.0";
const VENTANA_24H = 24 * 3600_000;

export function metaRouter() {
  const r = Router();
  r.get("/", verifyWebhookHandler(settings.meta.verifyToken));
  r.post("/", (req, res) => {
    if (!verifyMetaSignature(req)) return res.sendStatus(401);
    res.sendStatus(200);
    procesar(req.body).catch((e) => console.error("[meta]", e));
  });
  return r;
}

const vistos = new Set();

async function procesar(body) {
  const canal = body?.object === "instagram" ? "instagram" : "messenger";
  for (const entry of body?.entry || []) {
    for (const ev of entry.messaging || []) {
      const msg = ev.message;
      if (!msg || msg.is_echo) continue; // ignoramos nuestros propios mensajes
      if (msg.mid && vistos.has(msg.mid)) continue;
      if (msg.mid) vistos.add(msg.mid);
      if (vistos.size > 5000) vistos.clear();

      const senderId = ev.sender?.id;
      if (!senderId || rateLimited(`${canal}:${senderId}`)) continue;

      let texto = msg.text || msg.quick_reply?.payload;
      if (!texto && msg.attachments?.length) {
        texto = `(El cliente envió un adjunto de tipo "${msg.attachments[0].type}" que no puedo ver. Pídele amablemente que lo describa en texto.)`;
      }
      if (!texto) continue;

      const { respuesta } = await handleIncoming({ canal, externoId: senderId, texto });
      if (respuesta) await sendMeta(senderId, respuesta);
    }
  }
}

/**
 * Envía un mensaje por Messenger/Instagram. Los mensajes proactivos fuera de 24 h se envían
 * con la etiqueta HUMAN_AGENT solo si son de un humano; los seguimientos automáticos fuera de
 * ventana no están permitidos por Meta y se rechazan aquí.
 */
export async function sendMeta(recipientId, texto, { proactivo = false, ultimoMensajeCliente = null, humano = false } = {}) {
  if (!settings.meta.pageToken) throw new Error("Messenger/Instagram no está configurado (META_PAGE_TOKEN)");
  const fueraDeVentana =
    proactivo && (!ultimoMensajeCliente || Date.now() - new Date(ultimoMensajeCliente).getTime() > VENTANA_24H);
  if (fueraDeVentana && !humano) throw new Error("Meta no permite mensajes automáticos fuera de la ventana de 24 h");

  for (const parte of splitMessage(texto, 1900)) {
    const body = {
      recipient: { id: recipientId },
      message: { text: parte },
      ...(fueraDeVentana ? { messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" } : { messaging_type: "RESPONSE" }),
    };
    const res = await fetch(`${GRAPH}/me/messages?access_token=${encodeURIComponent(settings.meta.pageToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Meta ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}
