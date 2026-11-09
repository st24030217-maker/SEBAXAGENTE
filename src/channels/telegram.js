// Telegram Bot API. Modo "polling" (sin URL pública, ideal para probar) o "webhook" (producción).
import { Router } from "express";
import { settings } from "../config.js";
import { handleIncoming } from "../agent/agent.js";
import { splitMessage, rateLimited } from "./index.js";

const api = (method) => `https://api.telegram.org/bot${settings.telegram.token}/${method}`;

async function call(method, body) {
  const res = await fetch(api(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
  return data.result;
}

export async function sendTelegram(chatId, texto) {
  if (!settings.telegram.token) throw new Error("Telegram no está configurado (TELEGRAM_BOT_TOKEN)");
  for (const parte of splitMessage(texto, 4000)) {
    await call("sendMessage", { chat_id: chatId, text: parte, disable_web_page_preview: false });
  }
}

async function procesarUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg || msg.chat?.type !== "private") return;
  const chatId = msg.chat.id;
  // El dueño recibe avisos en su chat; no lo tratamos como cliente.
  if (String(chatId) === String(settings.owner.telegramChatId)) return;
  if (rateLimited(`tg:${chatId}`)) return;

  let texto = msg.text;
  if (texto === "/start") texto = "Hola";
  if (!texto) texto = "(El cliente envió un archivo o audio que no puedo ver. Pídele amablemente que lo escriba en texto.)";
  const nombre = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || null;

  call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
  const { respuesta } = await handleIncoming({ canal: "telegram", externoId: chatId, texto, nombre });
  if (respuesta) await sendTelegram(chatId, respuesta);
}

export function telegramRouter() {
  const r = Router();
  r.post("/:secret", (req, res) => {
    if (!settings.telegram.webhookSecret || req.params.secret !== settings.telegram.webhookSecret) return res.sendStatus(403);
    res.sendStatus(200);
    procesarUpdate(req.body).catch((e) => console.error("[telegram]", e));
  });
  return r;
}

/** Arranca Telegram según el modo configurado. */
export async function startTelegram() {
  if (!settings.telegram.token) return;
  if (settings.telegram.mode === "webhook") {
    const url = `${settings.publicUrl}/webhooks/telegram/${settings.telegram.webhookSecret}`;
    await call("setWebhook", { url, allowed_updates: ["message", "edited_message"] });
    console.log("[telegram] webhook registrado");
    return;
  }
  await call("deleteWebhook", {});
  console.log("[telegram] escuchando mensajes (polling)");
  let offset = 0;
  (async function loop() {
    for (;;) {
      try {
        const updates = await call("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "edited_message"] });
        for (const u of updates) {
          offset = u.update_id + 1;
          procesarUpdate(u).catch((e) => console.error("[telegram]", e));
        }
      } catch (e) {
        console.error("[telegram] polling:", e.message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  })();
}
