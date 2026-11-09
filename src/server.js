import os from "node:os";
import path from "node:path";
import express from "express";
import { settings, getNegocio, ROOT } from "./config.js";
import { getDb } from "./db.js";
import { webRouter } from "./channels/web.js";
import { whatsappRouter } from "./channels/whatsapp.js";
import { metaRouter } from "./channels/meta.js";
import { telegramRouter, startTelegram } from "./channels/telegram.js";
import { adminRouter } from "./admin/routes.js";
import { startScheduler } from "./services/scheduler.js";
import { setOrderStatus } from "./services/orders.js";
import { fetchMercadoPagoPayment, verifyStripeSignature } from "./services/payments.js";
import { getProspeccion } from "./prospeccion/config.js";
import { startProspeccion, darDeBaja } from "./prospeccion/servicio.js";
import { startEmail } from "./channels/email.js";
import { startWaWeb } from "./channels/wa-web.js";
import { verificarClaude } from "./ia/proveedor.js";

// Valida configuración al arrancar (falla rápido si negocio.yaml tiene errores).
const negocio = getNegocio();
getProspeccion();
getDb();

if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN && !process.env.GEMINI_API_KEY) {
  console.warn("Falta ANTHROPIC_API_KEY o GEMINI_API_KEY en .env: el agente no podrá conversar.");
}

const app = express();
app.set("trust proxy", 1);
// Guardamos el cuerpo crudo: lo necesitan las firmas de Meta y Stripe.
app.use(
  express.json({
    limit: "1mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);
app.use(express.urlencoded({ extended: false }));

// CORS solo para la API del chat web (para poder incrustar el widget en tu sitio).
app.use("/api/chat", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.WIDGET_ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use("/api/chat", webRouter());
app.use("/webhooks/whatsapp", whatsappRouter());
app.use("/webhooks/meta", metaRouter());
app.use("/webhooks/telegram", telegramRouter());
app.use("/admin/api", adminRouter());

// ---------- Webhooks de pago ----------
app.post("/webhooks/mercadopago", async (req, res) => {
  res.sendStatus(200);
  try {
    const tipo = req.body?.type || req.query.type || req.query.topic;
    const id = req.body?.data?.id || req.query["data.id"] || req.query.id;
    if (tipo !== "payment" || !id) return;
    // No confiamos en el cuerpo: consultamos el pago directo a Mercado Pago.
    const pago = await fetchMercadoPagoPayment(id);
    if (pago.aprobado && pago.pedidoId) await setOrderStatus(pago.pedidoId, "pagado", { referencia: pago.referencia });
  } catch (e) {
    console.error("[mercadopago]", e.message);
  }
});

app.post("/webhooks/stripe", async (req, res) => {
  if (!verifyStripeSignature(req.rawBody, req.get("stripe-signature"), settings.payments.stripeWebhookSecret)) {
    return res.sendStatus(400);
  }
  res.sendStatus(200);
  try {
    const ev = req.body;
    if (ev.type === "checkout.session.completed" && ev.data?.object?.payment_status === "paid") {
      const pedidoId = ev.data.object.metadata?.pedido_id;
      if (pedidoId) await setOrderStatus(pedidoId, "pagado", { referencia: ev.data.object.id });
    }
  } catch (e) {
    console.error("[stripe]", e.message);
  }
});

// Páginas a las que vuelve el cliente después de pagar.
const paginaPago = (titulo, texto) => (req, res) =>
  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${titulo}</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f7f9;color:#1d2433}
main{background:#fff;padding:32px;border-radius:16px;max-width:420px;text-align:center;box-shadow:0 4px 24px #0001}</style></head>
<body><main><h1>${titulo}</h1><p>${texto}</p><p>Pedido #${Number(req.query.pedido) || ""} · ${negocio.negocio.nombre}</p><p>Puedes cerrar esta ventana y volver al chat.</p></main></body></html>`);
app.get("/pago/ok", paginaPago("¡Pago recibido! 🎉", "Gracias por tu compra. Te confirmaremos por el chat."));
app.get("/pago/pendiente", paginaPago("Pago en proceso ⏳", "Tu pago está pendiente de confirmación."));
app.get("/pago/error", paginaPago("No se completó el pago", "Puedes intentarlo de nuevo con el mismo link o escribirnos por el chat."));

// Baja de correos de prospección (link al pie de cada correo).
app.get("/baja/:token", (req, res) => {
  const p = darDeBaja(req.params.token);
  const msg = p
    ? "Listo, no volverás a recibir correos nuestros. Disculpa la molestia."
    : "Este enlace no es válido o ya fue usado.";
  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Baja de correos</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f7f9;color:#1d2433}
main{background:#fff;padding:32px;border-radius:16px;max-width:420px;text-align:center;box-shadow:0 4px 24px #0001;margin:16px}</style></head>
<body><main><h1>Baja de correos</h1><p>${msg}</p></main></body></html>`);
});

app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/admin", (_req, res) => res.sendFile(path.join(ROOT, "public", "admin.html")));
app.use(express.static(path.join(ROOT, "public")));

app.listen(settings.port, () => {
  console.log(`\n✅ Agente de ventas de "${negocio.negocio.nombre}" activo`);
  console.log(`   Chat de prueba:  http://localhost:${settings.port}`);
  console.log(`   Panel admin:     http://localhost:${settings.port}/admin`);
  // Direcciones para abrir el panel desde el celular (conectado al mismo WiFi).
  for (const ip of Object.values(os.networkInterfaces()).flat()) {
    if (ip && ip.family === "IPv4" && !ip.internal) console.log(`   En tu celular:   http://${ip.address}:${settings.port}/admin  (mismo WiFi)`);
  }
  console.log(`   IA: ${[process.env.ANTHROPIC_API_KEY && "Claude", process.env.GEMINI_API_KEY && "Gemini"].filter(Boolean).join(" + ") || "ninguna"} · modelo Claude: ${settings.claude.model} · esfuerzo: ${settings.claude.effort} · pagos: ${settings.payments.provider}\n`);
  startTelegram().catch((e) => console.error("[telegram]", e.message));
  startScheduler();
  // Revisa al arrancar y cada hora si Claude tiene saldo; si no, el agente usa Gemini.
  verificarClaude("claude-haiku-5-5");
  setInterval(() => verificarClaude("claude-haiku-5-5"), 59 * 60_000);
  startProspeccion();
  startEmail();
  startWaWeb().catch((e) => console.error("[whatsapp]", e.message));
});
