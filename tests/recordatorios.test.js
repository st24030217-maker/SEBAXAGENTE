// Tests de los recordatorios al dueño por WhatsApp (agenda del día y aviso 1 h antes):  npm test
import { test, before } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.ANTHROPIC_API_KEY = "";
process.env.GEMINI_API_KEY = "";

const { openDb, getDb, getOrCreateConversation, upsertLead } = await import("../src/db.js");
const { revisarRecordatorios } = await import("../src/services/recordatorios.js");

before(() => {
  openDb(":memory:");
  const c = getOrCreateConversation("wa", "8711234567", "Juan");
  upsertLead(c.id, { nombre: "Juan Pérez", empresa: "Tacos Rigo", telefono: "8711234567", necesidad: "menú digital" });
  const ins = getDb().prepare("INSERT INTO citas (conversacion_id, inicio, fin, tipo, creado) VALUES (?, ?, ?, ?, ?)");
  // Lunes 9 de nov de 2026 en Monterrey (UTC-6): una cita a las 8:50 y otra a las 15:00. Agendadas el día anterior.
  ins.run(c.id, "2026-11-09T14:50:00.000Z", "2026-11-09T15:20:00.000Z", "Llamada de diagnóstico", "2026-11-08T18:00:00.000Z");
  ins.run(c.id, "2026-11-09T21:00:00.000Z", "2026-11-09T21:30:00.000Z", "Visita en tu negocio", "2026-11-08T18:00:00.000Z");
});

test("antes de las 8 no manda la agenda; a las 8 manda la agenda y el aviso de la cita cercana, una sola vez", async () => {
  const salen = [];
  const enviar = async (t) => (salen.push(t), true);
  assert.deepEqual(await revisarRecordatorios(new Date("2026-11-09T13:30:00Z"), enviar), []); // 7:30 local

  const r = await revisarRecordatorios(new Date("2026-11-09T14:00:00Z"), enviar); // 8:00 local
  assert.equal(r.length, 2);
  assert.match(r[0], /Tu agenda de hoy/);
  assert.match(r[0], /tienes 2 citas/);
  assert.match(r[0], /08:50 · Juan Pérez · Tacos Rigo/);
  assert.match(r[0], /15:00/);
  assert.match(r[1], /Cita en 50 minutos/);
  assert.match(r[1], /Tel\. 8711234567/);
  assert.match(r[1], /Busca: menú digital/);

  assert.deepEqual(await revisarRecordatorios(new Date("2026-11-09T14:05:00Z"), enviar), [], "no se repite");
  const tarde = await revisarRecordatorios(new Date("2026-11-09T20:00:00Z"), enviar); // 14:00 local: la de las 15:00
  assert.equal(tarde.length, 1);
  assert.match(tarde[0], /Cita en 1 hora/);
});

test("si el chip está desconectado, lo reintenta en la siguiente vuelta", async () => {
  getDb().prepare("INSERT INTO citas (conversacion_id, inicio, fin, creado) VALUES ('wa:8711234567', '2026-11-10T16:00:00.000Z', '2026-11-10T16:30:00.000Z', '2026-11-08T18:00:00.000Z')").run();
  const ahora = new Date("2026-11-10T14:10:00Z"); // martes 8:10 local
  assert.deepEqual(await revisarRecordatorios(ahora, async () => false), []);
  const r = await revisarRecordatorios(ahora, async () => true);
  assert.match(r[0], /Tu agenda de hoy/);
});
