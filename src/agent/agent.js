// Motor del agente: recibe un mensaje de cualquier canal, conversa con Claude,
// ejecuta las herramientas que pida y devuelve la respuesta para el cliente.
import Anthropic from "@anthropic-ai/sdk";
import { settings, getNegocio } from "../config.js";
import {
  getOrCreateConversation,
  getConversation,
  loadHistory,
  saveHistory,
  addTranscript,
  logUsage,
  logEvent,
} from "../db.js";
import { buildSystemPrompt, turnContext } from "./prompt.js";
import { TOOL_DEFINITIONS, executeTool } from "./tools.js";
import { notifyOwner } from "../services/notify.js";
import { generarGemini } from "../ia/gemini.js";
import { generarTexto } from "../ia/texto.js";
import { proveedores, esErrorDeCuenta, pausarClaude } from "../ia/proveedor.js";

let client;
const getClient = () => (client ??= new Anthropic());

export const MENSAJE_ERROR = "Disculpa, tuve un problema técnico. Dame un momento y vuelve a escribirme, por favor.";
const MENSAJE_RECHAZO = "Disculpa, en eso no puedo ayudarte. ¿Te ayudo con algún producto o servicio?";
const HISTORY_MAX_MESSAGES = Number(process.env.HISTORY_MAX_MESSAGES || 150);

let systemCache = { negocio: null, texto: "" };
function systemPrompt() {
  const n = getNegocio();
  if (systemCache.negocio !== n) systemCache = { negocio: n, texto: buildSystemPrompt(n) };
  return systemCache.texto;
}

// ---------- Exclusión por conversación (evita respuestas cruzadas si el cliente manda varios mensajes seguidos) ----------
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.then(() => locks.get(key) === tail && locks.delete(key));
  return run;
}

// El cliente no puede hacerse pasar por el sistema.
const sanitize = (texto) => String(texto ?? "").replace(/\[\s*contexto del sistema\s*\]/gi, "[texto del cliente]").slice(0, 4000);

/**
 * Procesa un mensaje entrante del cliente.
 * @returns {Promise<{convId: string, respuesta: string|null}>} respuesta=null si el bot está en pausa (atiende un humano).
 */
export function handleIncoming({ canal, externoId, texto, nombre = null }) {
  const conv0 = getOrCreateConversation(canal, externoId, nombre);
  return withLock(conv0.id, async () => {
    const conv = getConversation(conv0.id);
    const limpio = sanitize(texto);
    addTranscript(conv.id, "cliente", limpio);
    const negocio = getNegocio();
    let history = loadHistory(conv.id);
    const userMsg = {
      role: "user",
      content: [
        { type: "text", text: turnContext({ negocio, canal, nombre: conv.nombre }) },
        { type: "text", text: limpio },
      ],
    };

    if (!conv.bot_activo) {
      history.push(userMsg);
      saveHistory(conv.id, history);
      return { convId: conv.id, respuesta: null };
    }

    history = await compactIfLong(conv.id, history);
    history.push(userMsg);
    const respuesta = await runTurn(conv, history, negocio);
    addTranscript(conv.id, "agente", respuesta);
    return { convId: conv.id, respuesta };
  });
}

/**
 * Genera un mensaje proactivo (seguimiento). Devuelve el texto o null si no corresponde enviarlo.
 */
export function generateFollowup(convId, motivo) {
  return withLock(convId, async () => {
    const conv = getConversation(convId);
    if (!conv || !conv.bot_activo) return null;
    const negocio = getNegocio();
    let history = await compactIfLong(conv.id, loadHistory(conv.id));
    history.push({
      role: "user",
      content: [
        { type: "text", text: turnContext({ negocio, canal: conv.canal, nombre: conv.nombre }) },
        {
          type: "text",
          text: `[contexto del sistema] El cliente no ha respondido. Toca enviarle un seguimiento. Motivo: ${motivo}. Escribe UN mensaje breve, cálido y útil que retome la conversación donde quedó (sin repetir todo, sin presionar) y termine con una pregunta fácil de responder. Si no tiene sentido escribirle (por ejemplo, ya compró, dijo que no le interesa o pidió no ser contactado), responde exactamente: NO_ENVIAR`,
        },
      ],
    });
    const texto = await runTurn(conv, history, negocio);
    if (!texto || texto.includes("NO_ENVIAR")) return null;
    addTranscript(conv.id, "agente", texto);
    return texto;
  });
}

/**
 * Registra un mensaje que se le envió al cliente fuera del agente (un humano desde el panel,
 * un recordatorio de cita, una confirmación de pago), para que el agente tenga el contexto.
 * @param {"humano"|"agente"} rol  cómo aparece en el panel
 * @param {string} origen          descripción para el agente, p. ej. "Un asesor humano del equipo"
 */
export function recordOutgoing(convId, texto, rol, origen) {
  return withLock(convId, async () => {
    const history = loadHistory(convId);
    history.push({
      role: "user",
      content: [{ type: "text", text: `[contexto del sistema] ${origen} le envió este mensaje al cliente: «${texto}»` }],
    });
    saveHistory(convId, history);
    addTranscript(convId, rol, texto);
  });
}

/** Ejecuta un turno completo: llama a Claude, corre herramientas y repite hasta tener respuesta final. */
async function runTurn(conv, history, negocio) {
  const ctx = { convId: conv.id, canal: conv.canal, conv, negocio };
  let finalText = "";
  try {
    for (let ronda = 0; ronda <= settings.claude.maxToolRounds; ronda++) {
      const ultimaRonda = ronda === settings.claude.maxToolRounds;
      const resp = await callClaude(conv.id, history);

      if (resp.stop_reason === "refusal") {
        logEvent("rechazo_ia", conv.id, { categoria: resp.stop_details?.category ?? null });
        history.push({ role: "assistant", content: [{ type: "text", text: MENSAJE_RECHAZO }] });
        finalText = MENSAJE_RECHAZO;
        break;
      }

      // Se agrega el contenido completo (incluye bloques de razonamiento) tal cual: el historial solo crece, nunca se edita.
      history.push({ role: "assistant", content: resp.content });
      const texto = resp.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (texto) finalText = texto;

      if (resp.stop_reason === "pause_turn") continue;

      const toolUses = resp.content.filter((b) => b.type === "tool_use");
      if (!toolUses.length) break;

      const results = await Promise.all(
        toolUses.map(async (tu) => {
          if (ultimaRonda) {
            return { type: "tool_result", tool_use_id: tu.id, content: "No ejecutada: límite de acciones por mensaje.", is_error: true };
          }
          try {
            const out = await executeTool(tu.name, tu.input, ctx);
            return { type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out) };
          } catch (err) {
            return { type: "tool_result", tool_use_id: tu.id, content: `Error: ${err.message}`, is_error: true };
          }
        })
      );
      history.push({ role: "user", content: results });
      saveHistory(conv.id, history);
      if (ultimaRonda) break;
    }
  } catch (err) {
    console.error(`[agente] ${conv.id}:`, err);
    logEvent("error_ia", conv.id, { mensaje: err.message, status: err.status });
    notifyOwner("error", `Error del agente en ${conv.id}: ${err.message}`);
    saveHistory(conv.id, history);
    return MENSAJE_ERROR;
  }
  saveHistory(conv.id, history);
  return finalText || MENSAJE_ERROR;
}

function baseParams(history) {
  return {
    model: settings.claude.model,
    max_tokens: 16000,
    // Instrucciones y herramientas fijas -> se guardan en caché (más barato y rápido).
    system: [{ type: "text", text: systemPrompt(), cache_control: { type: "ephemeral" } }],
    tools: TOOL_DEFINITIONS,
    messages: history,
    output_config: { effort: settings.claude.effort },
    // Caché automática del historial de la conversación.
    cache_control: { type: "ephemeral" },
  };
}

/** Claude rechaza campos que no conoce: se quitan las firmas que deja Gemini en el historial. */
const paraClaude = (history) =>
  history.map((m) =>
    typeof m.content === "string"
      ? m
      : { ...m, content: m.content.map((b) => (b.type === "tool_use" && b.gemini_sig ? (({ gemini_sig, ...resto }) => resto)(b) : b)) }
  );

/** Llama a la IA disponible: Claude primero (si hay saldo); si no, Gemini. */
async function callClaude(convId, history) {
  let ultimo;
  for (const prov of proveedores()) {
    try {
      const resp =
        prov === "claude"
          ? await llamarClaude(paraClaude(history))
          : await generarGemini({ system: systemPrompt(), messages: history, tools: TOOL_DEFINITIONS, maxTokens: 4096 });
      logUsage(convId, resp.model, resp.usage);
      return resp;
    } catch (e) {
      ultimo = e;
      if (prov === "claude" && esErrorDeCuenta(e)) pausarClaude(e);
      console.error(`[ia] ${prov} falló en ${convId}:`, String(e.message).slice(0, 200));
    }
  }
  throw ultimo || new Error("No hay IA configurada (falta ANTHROPIC_API_KEY o GEMINI_API_KEY)");
}

async function llamarClaude(history) {
  const params = baseParams(history);
  const conFallback = settings.claude.fallback && !settings.claude.model.startsWith("claude-haiku");
  const resp = conFallback
    ? await getClient().beta.messages.create({
        ...params,
        // Si Claude rechaza un mensaje por sus filtros de seguridad, el servidor reintenta en el modelo recomendado.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      })
    : await getClient().messages.create(params);
  return resp;
}

/**
 * Si la conversación es muy larga, la resume y empieza un historial nuevo con el resumen.
 * Mantiene los costos bajo control en clientes que conversan durante semanas.
 */
async function compactIfLong(convId, history) {
  if (history.length < HISTORY_MAX_MESSAGES) return history;
  // Solo cortamos en un punto limpio: después de una respuesta final del agente.
  const last = history[history.length - 1];
  if (last.role !== "assistant" || last.content.some?.((b) => b.type === "tool_use")) return history;
  try {
    const transcript = history
      .map((m) => {
        const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
        const txt = blocks
          .map((b) => (b.type === "text" ? b.text : b.type === "tool_use" ? `(acción: ${b.name} ${JSON.stringify(b.input)})` : b.type === "tool_result" ? `(resultado: ${String(b.content).slice(0, 300)})` : ""))
          .filter(Boolean)
          .join(" ");
        return `${m.role === "user" ? "CLIENTE/SISTEMA" : "AGENTE"}: ${txt}`;
      })
      .join("\n");
    const { texto: resumen } = await generarTexto({
      modeloClaude: settings.claude.model,
      maxTokens: 4000,
      usoId: convId,
      prompt: `Resume esta conversación de ventas para que otro agente pueda continuarla. Incluye: datos del cliente, qué necesita, productos conversados, cotizaciones y pedidos (con ids), acuerdos, objeciones y en qué quedó. Máximo 250 palabras.\n\n${transcript}`,
    });
    if (!resumen) return history;
    logEvent("historial_resumido", convId, { mensajes: history.length });
    return [{ role: "user", content: [{ type: "text", text: `[contexto del sistema] Resumen de la conversación anterior con este cliente:\n${resumen}` }] }];
  } catch (err) {
    console.error("[agente] no se pudo resumir el historial:", err.message);
    return history;
  }
}
