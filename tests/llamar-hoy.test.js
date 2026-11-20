// "A quién llamar hoy": quién sale en la lista y quién no.
import { test, before } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.ANTHROPIC_API_KEY = "";
process.env.GEMINI_API_KEY = "";
const { openDb, getDb, getOrCreateConversation, addTranscript, setBotActive, upsertLead } = await import("../src/db.js");
const { listaLlamarHoy, textoLlamarHoy } = await import("../src/services/llamar-hoy.js");

const ahora = new Date("2026-11-24T16:00:00Z"); // martes 10:00 en La Laguna
const hace = (dias) => new Date(ahora.getTime() - dias * 86400_000).toISOString();
const msg = (conv, rol, texto, creado) => getDb().prepare("INSERT INTO mensajes (conversacion_id, rol, texto, creado) VALUES (?, ?, ?, ?)").run(conv, rol, texto, creado);

before(() => {
  openDb(":memory:");
  // Te escribió y nadie le contestó (bot apagado)
  const a = getOrCreateConversation("wa", "8710000001", "Tacos Gil");
  upsertLead(a.id, { empresa: "Tacos Gil", telefono: "8710000001", etapa: "interesado" });
  setBotActive(a.id, false);
  msg(a.id, "humano", "¿Les paso a mostrar los ejemplos?", hace(2));
  msg(a.id, "cliente", "Sí, ¿a qué hora puede?", hace(1));
  // Quedamos en escribirle el martes
  const b = getOrCreateConversation("wa", "8710000002", "Cocina de Vale");
  upsertLead(b.id, { empresa: "Cocina de Vale", etapa: "interesado" });
  msg(b.id, "cliente", "Lo comparto a Gerencia", hace(4));
  msg(b.id, "agente", "Perfecto, te escribo el martes para ver qué les pareció.", hace(4));
  // Dijo que no: nunca sale
  const c = getOrCreateConversation("wa", "8710000003", "Car Wash");
  upsertLead(c.id, { empresa: "Car Wash", etapa: "interesado" });
  setBotActive(c.id, false);
  msg(c.id, "humano", "Una última idea…", hace(2));
  msg(c.id, "cliente", "Gracias, ya tenemos quien maneje nuestra publicidad", hace(1));
  // Solo respuesta automática: no sale
  const e = getOrCreateConversation("wa", "8710000004", "Lonchería");
  upsertLead(e.id, { empresa: "Lonchería", etapa: "interesado" });
  msg(e.id, "agente", "Hola, ¿pudieron ver el menú?", hace(5));
  msg(e.id, "cliente", "[Respuesta automática] Gracias por comunicarte, nuestro horario es de 1 a 12", hace(5));
});

test("ordena por urgencia y deja fuera a quien dijo que no o solo mandó respuesta automática", () => {
  const lista = listaLlamarHoy(ahora);
  assert.deepEqual(lista.map((x) => x.nombre), ["Tacos Gil", "Cocina de Vale"]);
  assert.match(lista[0].motivo, /nadie le ha contestado/);
  assert.match(lista[1].motivo, /escribirle hoy martes/);
  assert.match(textoLlamarHoy(ahora), /A quién llamar hoy/);
});
