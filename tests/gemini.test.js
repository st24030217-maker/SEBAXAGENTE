// Tests del adaptador de Gemini (no llama a Google):  npm test
import { test } from "node:test";
import assert from "node:assert/strict";

const { historialGemini, herramientasGemini, aFormatoClaude } = await import("../src/ia/gemini.js");

test("convierte el historial de Claude (con herramientas) al formato de Gemini", () => {
  const h = historialGemini([
    { role: "user", content: [{ type: "text", text: "¿Horarios el jueves?" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "x", signature: "s" }, { type: "tool_use", id: "t1", name: "ver_horarios_disponibles", input: { fecha: "2026-11-12" }, gemini_sig: "SIG" }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: '{"horarios_libres":["10:00"]}' }] },
    { role: "assistant", content: [{ type: "text", text: "Tengo 10:00" }] },
  ]);
  assert.deepEqual(h.map((c) => c.role), ["user", "model", "user", "model"]);
  assert.equal(h[1].parts.length, 1, "el razonamiento de Claude no se envía");
  assert.equal(h[1].parts[0].functionCall.name, "ver_horarios_disponibles");
  assert.equal(h[1].parts[0].thoughtSignature, "SIG");
  assert.deepEqual(h[2].parts[0].functionResponse, { name: "ver_horarios_disponibles", id: "t1", response: { horarios_libres: ["10:00"] } });
});

test("fusiona turnos seguidos del mismo rol y no empieza con el modelo", () => {
  const h = historialGemini([
    { role: "assistant", content: "Hola" },
    { role: "user", content: "a" },
    { role: "user", content: [{ type: "text", text: "b" }] },
  ]);
  assert.equal(h[0].role, "user");
  assert.equal(h.filter((c) => c.role === "user").length, 2);
  assert.equal(h[2].parts.length, 2);
});

test("limpia los esquemas de herramientas para Gemini", () => {
  const [t] = herramientasGemini([
    { name: "a", description: "d", input_schema: { type: "object", properties: { x: { type: "integer", minimum: 1 } }, additionalProperties: false } },
    { name: "b", description: "sin parámetros", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  ]);
  assert.equal(t.functionDeclarations[0].parameters.additionalProperties, undefined);
  assert.equal(t.functionDeclarations[0].parameters.properties.x.minimum, 1);
  assert.equal(t.functionDeclarations[1].parameters, undefined);
});

test("convierte la respuesta de Gemini a la forma de Claude", () => {
  const r = aFormatoClaude(
    {
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: "pienso", thought: true }, { text: "Va" }, { functionCall: { name: "agendar_cita", args: { hora: "10:00" } }, thoughtSignature: "S" }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    },
    "gemini-x"
  );
  assert.equal(r.stop_reason, "tool_use");
  assert.equal(r.content[0].text, "Va");
  assert.equal(r.content[1].name, "agendar_cita");
  assert.equal(r.content[1].gemini_sig, "S");
  assert.ok(r.content[1].id);
  assert.deepEqual(r.usage, { input_tokens: 10, output_tokens: 5 });
  assert.equal(aFormatoClaude({ candidates: [{ finishReason: "SAFETY", content: { parts: [] } }] }, "g").stop_reason, "refusal");
});
