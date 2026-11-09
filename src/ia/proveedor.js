// Elige qué IA usar en cada llamada: Claude (si hay clave y saldo) o Gemini (plan gratis de Google).
//   IA_PROVEEDOR=auto   (por defecto) Claude primero; si no hay saldo o falla, Gemini.
//   IA_PROVEEDOR=claude solo Claude
//   IA_PROVEEDOR=gemini solo Gemini
import { geminiConfigurado } from "./gemini.js";

export const claudeConfigurado = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

let claudePausadoHasta = 0;
let motivoPausa = "";

/** Errores de Claude que significan "no hay saldo / clave inválida": no tiene caso reintentar pronto. */
export function esErrorDeCuenta(e) {
  const msg = String(e?.message || "");
  return e?.status === 401 || e?.status === 403 || /credit balance|billing|insufficient|invalid x-api-key|authentication/i.test(msg);
}

export function pausarClaude(e, minutos = 60) {
  claudePausadoHasta = Date.now() + minutos * 60_000;
  motivoPausa = /credit|billing/i.test(String(e?.message)) ? "sin saldo" : "clave rechazada";
  console.warn(`[ia] Claude no disponible (${motivoPausa}); se usa Gemini durante ${minutos} min`);
}

/** Orden de proveedores a intentar en este momento. */
export function proveedores() {
  const modo = (process.env.IA_PROVEEDOR || "auto").toLowerCase();
  const claude = claudeConfigurado() && (modo === "claude" || Date.now() >= claudePausadoHasta);
  const gemini = geminiConfigurado();
  if (modo === "claude") return claudeConfigurado() ? ["claude"] : [];
  if (modo === "gemini") return gemini ? ["gemini"] : [];
  return [...(claude ? ["claude"] : []), ...(gemini ? ["gemini"] : [])];
}

export const iaDisponible = () => claudeConfigurado() || geminiConfigurado();

/** Para el panel: qué IA está trabajando ahora. */
export function estadoIA() {
  const orden = proveedores();
  return {
    activa: orden[0] || null,
    claude: claudeConfigurado() ? (Date.now() < claudePausadoHasta ? motivoPausa : "lista") : "sin clave",
    gemini: geminiConfigurado() ? "lista" : "sin clave",
  };
}

/** Al arrancar: prueba Claude con una llamada mínima para saber si tiene saldo (y mostrarlo bien en el panel). */
export async function verificarClaude(modelo) {
  if (!claudeConfigurado()) return;
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    await new Anthropic().messages.create({ model: modelo, max_tokens: 1, messages: [{ role: "user", content: "ok" }] });
  } catch (e) {
    if (esErrorDeCuenta(e)) pausarClaude(e);
  }
}
