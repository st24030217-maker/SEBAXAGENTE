// Adaptador de Gemini (Google) con la misma "forma" de respuesta que la API de Claude,
// para que el agente funcione igual con cualquiera de los dos.
//  - Entrada: system (texto), messages (formato Claude, con tool_use / tool_result) y tools (formato Claude).
//  - Salida: { model, content: [{type:"text"} | {type:"tool_use"}], stop_reason, usage }.

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export const geminiConfigurado = () => !!process.env.GEMINI_API_KEY;

/** Modelos a probar en orden (si uno está saturado se pasa al siguiente). */
export function modelosGemini() {
  const preferido = process.env.GEMINI_MODELO || "gemini-3.5-flash";
  return [...new Set([preferido, "gemini-3.5-flash", "gemini-flash-lite-latest", "gemini-3.1-flash-lite"])];
}

/** Limpia un JSON Schema de Claude a lo que acepta Gemini. */
function esquema(s) {
  if (Array.isArray(s)) return s.map(esquema);
  if (!s || typeof s !== "object") return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (["additionalProperties", "$schema", "strict", "default", "examples"].includes(k)) continue;
    out[k] = k === "properties" ? Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, esquema(pv)])) : esquema(v);
  }
  return out;
}

export function herramientasGemini(tools = []) {
  if (!tools.length) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => {
        const params = esquema(t.input_schema || {});
        const sinParams = !params.properties || Object.keys(params.properties).length === 0;
        return { name: t.name, description: t.description || "", ...(sinParams ? {} : { parameters: params }) };
      }),
    },
  ];
}

const bloques = (content) => (typeof content === "string" ? [{ type: "text", text: content }] : content || []);

/** Convierte el historial (formato Claude) a "contents" de Gemini. */
export function historialGemini(messages) {
  const nombres = new Map(); // tool_use_id -> nombre de herramienta (Gemini lo necesita en la respuesta)
  const contents = [];
  for (const m of messages) {
    const parts = [];
    for (const b of bloques(m.content)) {
      if (b.type === "text" && b.text) parts.push({ text: b.text });
      else if (b.type === "tool_use") {
        nombres.set(b.id, b.name);
        parts.push({ functionCall: { name: b.name, args: b.input || {}, id: b.id }, ...(b.gemini_sig ? { thoughtSignature: b.gemini_sig } : {}) });
      } else if (b.type === "tool_result") {
        const texto = typeof b.content === "string" ? b.content : bloques(b.content).map((x) => x.text || "").join("\n");
        let respuesta;
        try {
          respuesta = JSON.parse(texto);
          if (typeof respuesta !== "object" || respuesta === null || Array.isArray(respuesta)) respuesta = { resultado: respuesta };
        } catch {
          respuesta = { resultado: texto };
        }
        if (b.is_error) respuesta = { error: texto };
        parts.push({ functionResponse: { name: nombres.get(b.tool_use_id) || "herramienta", id: b.tool_use_id, response: respuesta } });
      }
      // Los bloques de razonamiento de Claude (thinking) no se envían a Gemini.
    }
    if (!parts.length) continue;
    const role = m.role === "assistant" ? "model" : "user";
    // Gemini no acepta dos turnos seguidos del mismo rol: se fusionan.
    const prev = contents[contents.length - 1];
    if (prev && prev.role === role) prev.parts.push(...parts);
    else contents.push({ role, parts });
  }
  if (contents[0]?.role === "model") contents.unshift({ role: "user", parts: [{ text: "[contexto del sistema] Inicio de la conversación." }] });
  return contents;
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Llama a Gemini. Reintenta y cambia de modelo si está saturado (503/429) o tarda demasiado.
 * @returns respuesta con forma de Claude
 */
export async function generarGemini({ system, messages, tools, maxTokens = 4096 }) {
  if (!geminiConfigurado()) throw new Error("Falta GEMINI_API_KEY");
  const body = {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents: historialGemini(messages),
    ...(tools?.length ? { tools: herramientasGemini(tools) } : {}),
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 },
  };
  let ultimoError;
  for (const model of modelosGemini()) {
    for (let intento = 0; intento < 2; intento++) {
      try {
        const res = await fetch(`${BASE}/${model}:generateContent`, {
          method: "POST",
          headers: { "x-goog-api-key": process.env.GEMINI_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(Number(process.env.GEMINI_TIMEOUT_MS || 45_000)),
        });
        const j = await res.json().catch(() => ({}));
        if (res.status === 503 || res.status === 429 || res.status === 500) {
          ultimoError = new Error(`Gemini ${model}: ${j.error?.message || res.status}`);
          await espera(1500 * (intento + 1));
          continue;
        }
        if (!res.ok) {
          ultimoError = new Error(`Gemini ${model}: ${j.error?.message || res.status}`);
          break; // error de este modelo (p. ej. no disponible): probar el siguiente
        }
        return aFormatoClaude(j, model);
      } catch (e) {
        ultimoError = new Error(`Gemini ${model}: ${e.name === "TimeoutError" ? "tardó demasiado" : e.message}`);
      }
    }
  }
  throw ultimoError || new Error("Gemini no respondió");
}

export function aFormatoClaude(j, model) {
  const cand = j.candidates?.[0];
  const content = [];
  let n = 0;
  for (const p of cand?.content?.parts || []) {
    if (p.thought) continue; // razonamiento interno de Gemini
    if (p.functionCall) {
      content.push({
        type: "tool_use",
        id: p.functionCall.id || `gm_${Date.now().toString(36)}_${n++}`,
        name: p.functionCall.name,
        input: p.functionCall.args || {},
        ...(p.thoughtSignature ? { gemini_sig: p.thoughtSignature } : {}),
      });
    } else if (p.text) {
      const prev = content[content.length - 1];
      if (prev?.type === "text") prev.text += p.text;
      else content.push({ type: "text", text: p.text });
    }
  }
  const bloqueado = ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"].includes(cand?.finishReason) || j.promptFeedback?.blockReason;
  return {
    model,
    content,
    stop_reason: bloqueado ? "refusal" : content.some((b) => b.type === "tool_use") ? "tool_use" : cand?.finishReason === "MAX_TOKENS" ? "max_tokens" : "end_turn",
    usage: { input_tokens: j.usageMetadata?.promptTokenCount ?? 0, output_tokens: j.usageMetadata?.candidatesTokenCount ?? 0 },
  };
}
