import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");

const env = process.env;
const bool = (v, def = false) => (v === undefined || v === "" ? def : /^(1|true|yes|si|sí)$/i.test(v));

export const settings = {
  port: Number(env.PORT || 3000),
  publicUrl: (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ""),
  adminToken: env.ADMIN_TOKEN || "",
  dbPath: env.DB_PATH || path.join(ROOT, "data", "agente.db"),
  negocioPath: env.NEGOCIO_PATH || path.join(ROOT, "config", "negocio.yaml"),

  claude: {
    model: env.AGENTE_MODELO || "claude-opus-5-5",
    effort: env.AGENTE_ESFUERZO || "low",
    fallback: bool(env.AGENTE_FALLBACK, true),
    maxToolRounds: Number(env.AGENTE_MAX_ACCIONES || 8),
  },

  whatsapp: {
    token: env.WHATSAPP_TOKEN || "",
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || "",
    verifyToken: env.WHATSAPP_VERIFY_TOKEN || "",
    followupTemplate: env.WHATSAPP_FOLLOWUP_TEMPLATE || "",
    templateLang: env.WHATSAPP_TEMPLATE_LANG || "es",
  },
  meta: {
    pageToken: env.META_PAGE_TOKEN || "",
    verifyToken: env.META_VERIFY_TOKEN || "",
    appSecret: env.META_APP_SECRET || "",
  },
  telegram: {
    token: env.TELEGRAM_BOT_TOKEN || "",
    mode: env.TELEGRAM_MODE || "polling",
    webhookSecret: env.TELEGRAM_WEBHOOK_SECRET || "",
  },
  payments: {
    provider: (env.PAYMENT_PROVIDER || "manual").toLowerCase(),
    mercadopagoToken: env.MERCADOPAGO_ACCESS_TOKEN || "",
    stripeKey: env.STRIPE_SECRET_KEY || "",
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || "",
  },
  owner: {
    telegramChatId: env.OWNER_TELEGRAM_CHAT_ID || "",
    webhookUrl: env.OWNER_WEBHOOK_URL || "",
  },
  prospeccion: {
    configPath: env.PROSPECCION_PATH || path.join(ROOT, "config", "prospeccion.yaml"),
    denueToken: env.DENUE_TOKEN || "",
    pagespeedKey: env.PAGESPEED_API_KEY || "",
    modelo: env.PROSPECCION_MODELO || env.AGENTE_MODELO || "claude-opus-5-5",
    activo: bool(env.PROSPECCION_ACTIVA, true),
  },
  smtp: {
    host: env.SMTP_HOST || "smtp.gmail.com",
    port: Number(env.SMTP_PORT || 465),
    user: env.SMTP_USER || "",
    pass: (env.SMTP_PASS || "").replace(/\s+/g, ""),
    fromName: env.SMTP_FROM_NAME || "",
  },
};

let negocioCache = null;

/** Carga y valida config/negocio.yaml. Se cachea; usa reloadNegocio() para recargar. */
export function getNegocio() {
  if (!negocioCache) negocioCache = loadNegocio(settings.negocioPath);
  return negocioCache;
}

export function reloadNegocio() {
  negocioCache = loadNegocio(settings.negocioPath);
  return negocioCache;
}

export function loadNegocio(file) {
  const data = YAML.parse(fs.readFileSync(file, "utf8"));
  if (!data?.negocio?.nombre) throw new Error(`${file}: falta negocio.nombre`);
  if (!Array.isArray(data.catalogo) || data.catalogo.length === 0) {
    throw new Error(`${file}: el catálogo está vacío`);
  }
  const ids = new Set();
  for (const p of data.catalogo) {
    // precio: null = servicio a la medida (no se cotiza por chat: se agenda una llamada).
    if (!p.id || !p.nombre || (typeof p.precio !== "number" && p.precio !== null)) {
      throw new Error(`${file}: cada producto necesita id, nombre y precio numérico (o null si se cotiza a la medida) (revisa ${JSON.stringify(p)})`);
    }
    if (ids.has(p.id)) throw new Error(`${file}: id de producto repetido: ${p.id}`);
    ids.add(p.id);
  }
  data.negocio.moneda ||= "CLP";
  data.negocio.zona_horaria ||= "America/Santiago";
  data.descuentos ||= { maximo_porcentaje: 0, reglas: "No se ofrecen descuentos." };
  data.seguimientos ||= { activo: false };
  data.citas ||= { activo: false };
  return data;
}
