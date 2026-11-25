// Seguimientos a hora exacta, puntaje de negocios con página sin pedidos, muestras publicadas sin
// enviar y el link fijo en todo lo que sale por WhatsApp:  npm test
import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

process.env.DB_PATH = ":memory:";
process.env.ADMIN_TOKEN = "test";

const { openDb, getOrCreateConversation, getDb } = await import("../src/db.js");
const { loadNegocio, ROOT } = await import("../src/config.js");
const { executeTool } = await import("../src/agent/tools.js");
const { calificar } = await import("../src/prospeccion/redactar.js");
const { recibePedidos } = await import("../src/prospeccion/fuentes.js");
const { publicada } = await import("../src/prospeccion/publicar.js");

const negocio = loadNegocio(path.join(ROOT, "tests", "fixtures", "negocio-ejemplo.yaml"));
let conv;
before(() => {
  openDb(":memory:");
  conv = getOrCreateConversation("wa", "8710000000");
});

test("el seguimiento con fecha y hora sale a esa hora local, no 'en N horas'", async () => {
  const tz = negocio.negocio.zona_horaria;
  const manana = new Date(Date.now() + 2 * 86400_000);
  const fecha = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(manana);
  const r = await executeTool("programar_seguimiento", { fecha, hora: "15:00", motivo: "retomar tras su viaje" }, { convId: conv.id, canal: "wa", conv, negocio });
  assert.equal(r.ok, true);
  assert.match(r.programado_para, /15:00/);
  const fila = getDb().prepare("SELECT ejecutar_en FROM seguimientos WHERE conversacion_id = ? ORDER BY id DESC").get(conv.id);
  const hora = new Intl.DateTimeFormat("es-MX", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(fila.ejecutar_en));
  assert.equal(hora, "15:00");
  await assert.rejects(executeTool("programar_seguimiento", { fecha: "2020-01-01", hora: "10:00", motivo: "x" }, { convId: conv.id, canal: "wa", conv, negocio }), /ya pasó/);
  // Sin fecha sigue funcionando con en_horas
  const r2 = await executeTool("programar_seguimiento", { en_horas: 48, motivo: "x" }, { convId: conv.id, canal: "wa", conv, negocio });
  assert.equal(r2.ok, true);
});

test("detecta si la página ya recibe pedidos o reservas en línea", () => {
  assert.equal(recibePedidos('<a href="https://wa.me/528711234567?text=Hola">Pide</a>'), true);
  assert.equal(recibePedidos('<button class="add-to-cart">Agregar</button>'), true);
  assert.equal(recibePedidos('<a href="https://www.opentable.com/r/x">Reserva</a>'), true);
  assert.equal(recibePedidos("<h1>Bienvenidos</h1><p>Visítanos en Lerdo</p>"), false);
});

test("una página buena SIN pedidos ya no le baja el puntaje: suma", () => {
  const base = { nombre: "Jardín X", sitio_web: "https://jardin-ejemplo.mx", web_puntaje: 90, telefono: "8710000001" };
  const conPedidos = calificar({ ...base, web_detalle: JSON.stringify({ pedidos: true }) });
  const sinPedidos = calificar({ ...base, web_detalle: JSON.stringify({ pedidos: false }) });
  const sinSaber = calificar({ ...base, web_detalle: JSON.stringify({}) });
  assert.ok(sinPedidos.puntaje > conPedidos.puntaje);
  assert.equal(sinSaber.puntaje, conPedidos.puntaje); // sin analizar, como antes
  assert.ok(sinPedidos.razones.some((r) => /no recibe pedidos/.test(r)));
});

test("una muestra publicada sin enviar va en GitHub, salvo si pidió no ser contactado", () => {
  assert.equal(publicada({ boceto: "abcd1234", estado: "por_revisar", publicado: 0 }), false);
  assert.equal(publicada({ boceto: "abcd1234", estado: "por_revisar", publicado: 1 }), true);
  assert.equal(publicada({ boceto: "abcd1234", estado: "no_contactar", publicado: 1 }), false);
  assert.equal(publicada({ boceto: "abcd1234", estado: "enviado", publicado: 0 }), true);
});

test("la herramienta de otro número no se usa fuera de WhatsApp ni con números inválidos", async () => {
  const web = getOrCreateConversation("web", "sesion-x");
  const r = await executeTool("mandar_propuesta_a_otro_numero", { telefono: "8712216252" }, { convId: web.id, canal: "web", conv: web, negocio });
  assert.equal(r.ok, false);
  await assert.rejects(executeTool("mandar_propuesta_a_otro_numero", { telefono: "123" }, { convId: conv.id, canal: "wa", conv, negocio }), /10 dígitos/);
  const mismo = await executeTool("mandar_propuesta_a_otro_numero", { telefono: "871 000 0000" }, { convId: conv.id, canal: "wa", conv, negocio });
  assert.equal(mismo.ok, false);
});

test("gobierno, escuelas públicas y sindicatos no entran como prospectos", async () => {
  const { noEsCliente } = await import("../src/prospeccion/servicio.js");
  assert.equal(noEsCliente({ nombre: "Guarderia Imss", giro: "Guarderías del sector público" }), true);
  assert.equal(noEsCliente({ nombre: "Sindicato Nacional de Trabajadores", giro: "Asociaciones y organizaciones laborales y sindicales" }), true);
  assert.equal(noEsCliente({ nombre: "Primaria España", giro: "Escuelas de educación primaria del sector público" }), true);
  assert.equal(noEsCliente({ nombre: "Guardería Pequeños Pasos", giro: "Guarderías del sector privado" }), false);
  assert.equal(noEsCliente({ nombre: "Tacos Difuntos", giro: "Restaurantes" }), false);
});

test("el boceto: precios con unidad legibles, hotel con habitaciones y fotos en pantallas blancas", async () => {
  const { renderBoceto } = await import("../src/prospeccion/boceto.js");
  const html = renderBoceto({ id: 99001, nombre: "Hotel Prueba", giro: "Hoteles sin otros servicios integrados", rubro: "Hoteles", ciudad: "Lerdo", boceto: "ab12cd34" });
  assert.match(html, /Habitaciones/);
  assert.doesNotMatch(html, /Arma tu pedido/);
  assert.match(html, /\$850<small class="u">\/noche<\/small>/);
  assert.match(html, /class="pant con-foto" style="--foto:url\('https:/);
  // Un hotel recibe reservas, no pedidos; y Visítanos / La propuesta llevan foto de fondo
  assert.match(html, /Reservas directas a tu WhatsApp/);
  assert.match(html, /Enviar reserva por WhatsApp/);
  assert.doesNotMatch(html, /Pedidos por llamada|Enviar pedido/);
  assert.match(html, /class="pant visita con-fondo"/);
  assert.match(html, /class="pant puente con-fondo"/);
});
