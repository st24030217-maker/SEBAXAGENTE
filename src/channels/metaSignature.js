import crypto from "node:crypto";
import { settings } from "../config.js";

/**
 * Valida la cabecera X-Hub-Signature-256 que Meta envía en los webhooks (WhatsApp, Messenger, Instagram).
 * Sin META_APP_SECRET se RECHAZA todo: si no, cualquiera que conozca la dirección del agente podría mandarle
 * mensajes falsos (y gastar IA). Solo para pruebas locales: META_SIN_FIRMA=1 desactiva la validación.
 */
export function verifyMetaSignature(req) {
  const secret = settings.meta.appSecret;
  if (!secret) return /^(1|true|si|sí)$/i.test(process.env.META_SIN_FIRMA || "");
  const header = req.get("x-hub-signature-256") || "";
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(req.rawBody || "").digest("hex");
  return header.length === expected.length && crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

/** Responde la verificación inicial del webhook (GET con hub.challenge). */
export function verifyWebhookHandler(verifyToken) {
  return (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    if (mode === "subscribe" && verifyToken && token === verifyToken) return res.status(200).send(req.query["hub.challenge"]);
    return res.sendStatus(403);
  };
}
