import crypto from "node:crypto";
import { settings } from "../config.js";

/** Valida la cabecera X-Hub-Signature-256 que Meta envía en los webhooks (WhatsApp, Messenger, Instagram). */
export function verifyMetaSignature(req) {
  const secret = settings.meta.appSecret;
  if (!secret) return true; // sin secreto configurado no se valida (solo recomendable en pruebas)
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
