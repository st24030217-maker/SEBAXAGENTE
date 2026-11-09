// Tests de la lógica de negocio (no llaman a la API de Claude):  npm test
import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

process.env.DB_PATH = ":memory:";
process.env.ADMIN_TOKEN = "test";

const { openDb, getOrCreateConversation, getLead } = await import("../src/db.js");
const { loadNegocio, ROOT } = await import("../src/config.js");
const { computeQuote, executeTool } = await import("../src/agent/tools.js");
const { availableSlots, bookAppointment, zonedToUtc } = await import("../src/services/calendar.js");
const { verifyStripeSignature } = await import("../src/services/payments.js");
const { splitMessage } = await import("../src/channels/index.js");
const { buildSystemPrompt } = await import("../src/agent/prompt.js");
const { dentroDeHorario } = await import("../src/services/scheduler.js");
const crypto = await import("node:crypto");

const negocio = loadNegocio(path.join(ROOT, "tests", "fixtures", "negocio-ejemplo.yaml"));
let conv;

before(() => {
  openDb(":memory:");
  conv = getOrCreateConversation("web", "test-session-1");
});

const ctx = () => ({ convId: conv.id, canal: "web", conv, negocio });

test("la cotización usa precios del catálogo y aplica envío gratis sobre el umbral", () => {
  const q = computeQuote({ items: [{ producto_id: "NB-001", cantidad: 1 }], entrega: "despacho_santiago" }, negocio);
  assert.equal(q.subtotal, 899990);
  assert.equal(q.envio, 0);
  assert.equal(q.total, 899990);
});

test("cobra envío bajo el umbral y aplica descuento", () => {
  const q = computeQuote({ items: [{ producto_id: "AC-001", cantidad: 2 }], entrega: "despacho_regiones", descuento_porcentaje: 5 }, negocio);
  assert.equal(q.subtotal, 79980);
  assert.equal(q.descuento_monto, 79980 - Math.round(39990 * 0.95) * 2);
  assert.equal(q.envio, 8990);
  assert.equal(q.total, Math.round(39990 * 0.95) * 2 + 8990);
});

test("rechaza descuentos sobre el máximo, productos inexistentes y stock insuficiente", () => {
  assert.throws(() => computeQuote({ items: [{ producto_id: "NB-001", cantidad: 1 }], entrega: "retiro", descuento_porcentaje: 50 }, negocio), /máximo/);
  assert.throws(() => computeQuote({ items: [{ producto_id: "NO-EXISTE", cantidad: 1 }], entrega: "retiro" }, negocio), /no existe/);
  assert.throws(() => computeQuote({ items: [{ producto_id: "MN-001", cantidad: 99 }], entrega: "retiro" }, negocio), /Solo hay/);
});

test("guardar_cliente y actualizar_etapa alimentan el CRM", async () => {
  await executeTool("guardar_cliente", { nombre: "Ana Pérez", email: "ana@ejemplo.com", necesidad: "notebook para diseño" }, ctx());
  await executeTool("actualizar_etapa", { etapa: "interesado", puntaje: 7 }, ctx());
  const lead = getLead(conv.id);
  assert.equal(lead.nombre, "Ana Pérez");
  assert.equal(lead.etapa, "interesado");
  assert.equal(lead.puntaje, 7);
  await assert.rejects(executeTool("guardar_cliente", { email: "no-es-email" }, ctx()), /Email inválido/);
});

test("cotización -> pedido con transferencia (modo manual)", async () => {
  const cot = await executeTool("crear_cotizacion", { items: [{ producto_id: "NB-002", cantidad: 1 }], entrega: "retiro" }, ctx());
  assert.ok(cot.cotizacion_id);
  assert.equal(getLead(conv.id).etapa, "cotizado");
  const ped = await executeTool("crear_pedido", { cotizacion_id: cot.cotizacion_id }, ctx());
  assert.equal(ped.metodo_pago, "transferencia");
  assert.ok(ped.instrucciones_pago.includes("Banco"));
  // No duplica pedidos para la misma cotización
  const otra = await executeTool("crear_pedido", { cotizacion_id: cot.cotizacion_id }, ctx());
  assert.equal(otra.pedido_id, ped.pedido_id);
});

test("pedido con despacho exige dirección", async () => {
  const cot = await executeTool("crear_cotizacion", { items: [{ producto_id: "AC-002", cantidad: 1 }], entrega: "despacho_santiago" }, ctx());
  await assert.rejects(executeTool("crear_pedido", { cotizacion_id: cot.cotizacion_id }, ctx()), /dirección/);
});

test("no se puede usar la cotización de otra conversación", async () => {
  const otra = getOrCreateConversation("web", "test-session-2");
  const cot = await executeTool("crear_cotizacion", { items: [{ producto_id: "SV-001", cantidad: 1 }], entrega: "sin_envio" }, { ...ctx(), convId: otra.id, conv: otra });
  await assert.rejects(executeTool("crear_pedido", { cotizacion_id: cot.cotizacion_id }, ctx()), /No existe/);
});

test("agenda: respeta horario, día cerrado y evita doble reserva", () => {
  const tz = negocio.negocio.zona_horaria;
  // Lunes 2030-01-07
  const ahora = zonedToUtc("2030-01-06", "10:00", tz);
  const lunes = availableSlots("2030-01-07", negocio, ahora);
  assert.equal(lunes.dia, "lunes");
  assert.equal(lunes.slots[0].hora, "09:00");
  assert.equal(lunes.slots.at(-1).hora, "17:30");
  const domingo = availableSlots("2030-01-13", negocio, ahora);
  assert.equal(domingo.slots.length, 0);
  const r1 = bookAppointment({ convId: conv.id, fecha: "2030-01-07", hora: "10:00" }, negocio, ahora);
  assert.equal(r1.ok, true);
  const r2 = bookAppointment({ convId: conv.id, fecha: "2030-01-07", hora: "10:00" }, negocio, ahora);
  assert.equal(r2.ok, false);
  assert.ok(!availableSlots("2030-01-07", negocio, ahora).slots.some((s) => s.hora === "10:00"));
});

test("horario de atención para mensajes automáticos", () => {
  const tz = negocio.negocio.zona_horaria;
  assert.equal(dentroDeHorario(negocio, zonedToUtc("2030-01-07", "11:00", tz)), true);
  assert.equal(dentroDeHorario(negocio, zonedToUtc("2030-01-07", "20:00", tz)), false);
  assert.equal(dentroDeHorario(negocio, zonedToUtc("2030-01-13", "11:00", tz)), false);
});

test("firma de Stripe", () => {
  const secret = "whsec_test";
  const body = '{"id":"evt_1"}';
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  assert.equal(verifyStripeSignature(body, `t=${t},v1=${sig}`, secret), true);
  assert.equal(verifyStripeSignature(body, `t=${t},v1=${"0".repeat(64)}`, secret), false);
});

test("divide mensajes largos sin perder texto", () => {
  const texto = Array.from({ length: 300 }, (_, i) => `línea ${i}`).join("\n");
  const partes = splitMessage(texto, 500);
  assert.ok(partes.every((p) => p.length <= 500));
  assert.equal(partes.join("\n"), texto);
});

test("el system prompt es estable (sirve la caché) e incluye el catálogo", () => {
  const a = buildSystemPrompt(negocio);
  assert.equal(a, buildSystemPrompt(negocio));
  assert.ok(a.includes("NB-001"));
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(a));
});
