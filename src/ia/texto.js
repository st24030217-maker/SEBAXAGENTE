// Generación de texto simple (sin herramientas) con la IA disponible: redactar correos, resumir, etc.
import Anthropic from "@anthropic-ai/sdk";
import { logUsage } from "../db.js";
import { generarGemini } from "./gemini.js";
import { proveedores, esErrorDeCuenta, pausarClaude } from "./proveedor.js";

let client;
const getClient = () => (client ??= new Anthropic());

/**
 * @param {{prompt: string, maxTokens?: number, modeloClaude: string, usoId?: string}} o
 * @returns {Promise<{texto: string, modelo: string}>}
 */
export async function generarTexto({ prompt, maxTokens = 2000, modeloClaude, usoId = null }) {
  let ultimo;
  for (const prov of proveedores()) {
    try {
      const resp =
        prov === "claude"
          ? await getClient().messages.create({
              model: modeloClaude,
              max_tokens: maxTokens,
              output_config: { effort: "low" },
              messages: [{ role: "user", content: prompt }],
            })
          : await generarGemini({ messages: [{ role: "user", content: prompt }], maxTokens });
      logUsage(usoId, resp.model, resp.usage);
      const texto = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      return { texto, modelo: resp.model };
    } catch (e) {
      ultimo = e;
      if (prov === "claude" && esErrorDeCuenta(e)) pausarClaude(e);
      console.error(`[ia] ${prov} no pudo generar texto:`, String(e.message).slice(0, 200));
    }
  }
  throw ultimo || new Error("No hay IA configurada (falta ANTHROPIC_API_KEY o GEMINI_API_KEY)");
}
