// Tests de varios negocios en una sola instalación:  npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "agente-negocios-"));
process.env.DB_PATH = ":memory:";
process.env.NEGOCIOS_DIR = TMP;
process.env.ADMIN_TOKEN = "clave-principal-de-prueba";
process.env.ADMIN_SIN_TOKEN_EN_RED_LOCAL = "false";
process.env.ANTHROPIC_API_KEY = "";
process.env.GEMINI_API_KEY = "";
process.env.WHATSAPP_CHIP = "false";

const { openDb, getDb, getOrCreateConversation } = await import("../src/db.js");
const { getNegocio } = await import("../src/config.js");
const { conNegocio, negocioActual } = await import("../src/contexto.js");
const neg = await import("../src/negocios.js");
const { executeTool } = await import("../src/agent/tools.js");
const { pagosActuales } = await import("../src/services/payments.js");
const { procesarMensajeNegocio } = await import("../src/channels/wa-negocio.js");
const { adminRouter } = await import("../src/admin/routes.js");
const express = (await import("express")).default;

let server, base;
before(async () => {
  openDb(":memory:");
  // Mini servidor montado igual que en server.js.
  const app = express();
  app.use(express.json());
  app.use("/admin/api", adminRouter());
  const rutas = express.Router();
  rutas.use("/admin/api", adminRouter({ negocio: true }));
  app.use("/n/:slug", (req, res, next) => {
    const n = neg.getNegocioCliente(req.params.slug);
    if (!n) return res.sendStatus(404);
    conNegocio(n, () => rutas(req, res, next));
  });
  await new Promise((r) => (server = app.listen(0, "127.0.0.1", r)));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  neg.olvidarNegocios();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("alta de negocio: dirección limpia, dueño a 10 dígitos y clave propia", () => {
  const n = neg.crearNegocio({ nombre: "Tacos El Güero", dueno: "+52 871 111 2222" });
  assert.equal(n.slug, "tacos-el-guero");
  assert.equal(n.meta.dueno, "8711112222");
  assert.ok(n.meta.token.length >= 16);
  assert.equal(conNegocio(n, () => getNegocio()).negocio.nombre, "Tacos El Güero");
  assert.throws(() => neg.crearNegocio({ nombre: "Tacos El Güero" }), /Ya existe/);
  assert.throws(() => neg.crearNegocio({ nombre: "Admin" }), /reservado/);
  assert.throws(() => neg.crearNegocio({ nombre: "Otro", dueno: "123" }), /10 dígitos/);
  assert.equal(neg.listarNegocios().length, 1);
});

test("cada negocio tiene su propia base: nada se cruza con la tuya ni entre negocios", () => {
  const a = neg.getNegocioCliente("tacos-el-guero");
  const b = neg.crearNegocio({ nombre: "Barbería Don Pepe" });
  conNegocio(a, () => getOrCreateConversation("web", "sesion-compartida-1", "Cliente de tacos"));
  conNegocio(b, () => getOrCreateConversation("web", "sesion-compartida-1", "Cliente de barbería"));
  const nombre = (n) => (n ? conNegocio(n, () => getDb()) : getDb()).prepare("SELECT nombre FROM conversaciones WHERE id = 'web:sesion-compartida-1'").get()?.nombre;
  assert.equal(nombre(a), "Cliente de tacos");
  assert.equal(nombre(b), "Cliente de barbería");
  assert.equal(nombre(null), undefined, "tu base principal no se toca");
  assert.equal(negocioActual(), null);
  // El contexto sobrevive a esperas (promesas y timers).
  return conNegocio(a, async () => {
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(negocioActual().slug, "tacos-el-guero");
    assert.equal(getNegocio().negocio.nombre, "Tacos El Güero");
  });
});

test("la configuración solo se guarda si es válida", () => {
  const n = neg.getNegocioCliente("tacos-el-guero");
  assert.throws(() => neg.guardarYaml(n, "negocio: [roto"), /formato/);
  assert.throws(() => neg.guardarYaml(n, "negocio:\n  nombre: X\ncatalogo: []\n"), /catálogo está vacío/);
  const nuevo = neg.leerYaml(n).replace('precio: 250', 'precio: 35').replace("Producto o servicio de ejemplo", "Taco de pastor");
  const c = neg.guardarYaml(n, nuevo);
  assert.equal(c.catalogo[0].nombre, "Taco de pastor");
  assert.equal(conNegocio(n, () => getNegocio()).catalogo[0].precio, 35, "el agente usa la versión nueva al instante");
});

test("los negocios cobran con su cuenta (o transferencia), nunca con la tuya, y no mandan tu video", async () => {
  const n = neg.getNegocioCliente("tacos-el-guero");
  assert.equal(conNegocio(n, () => pagosActuales()).provider, "manual");
  assert.throws(() => neg.actualizarNegocio(n, { pagos: { proveedor: "mercadopago" } }), /Access Token/);
  neg.actualizarNegocio(n, { pagos: { proveedor: "mercadopago", mercadopago_token: "APP_USR-del-negocio" } });
  const p = conNegocio(n, () => pagosActuales());
  assert.equal(p.mercadopagoToken, "APP_USR-del-negocio");
  assert.equal(p.sufijo, "negocio=tacos-el-guero");
  const r = await conNegocio(n, () => {
    const conv = getOrCreateConversation("wa", "8712223333");
    return executeTool("enviar_video_presentacion", {}, { convId: conv.id, canal: "wa", conv });
  });
  assert.equal(r.ok, false);
});

test("WhatsApp del negocio: el dueño no es tratado como cliente; sin IA se le avisa", async () => {
  const n = neg.getNegocioCliente("tacos-el-guero");
  const enviados = [];
  const enviar = async (jid, t) => enviados.push(t);
  assert.equal(await conNegocio(n, () => procesarMensajeNegocio(n, { id: "8711112222", jid: "x", texto: "hola" }, enviar)), "dueno");
  assert.equal(await conNegocio(n, () => procesarMensajeNegocio(n, { id: "8719998888", jid: "y", texto: "¿tienen tacos?", nombre: "Ana" }, enviar)), "sin_ia");
  const guardado = conNegocio(n, () => getDb().prepare("SELECT texto FROM mensajes WHERE conversacion_id = 'wa:8719998888'").get());
  assert.equal(guardado.texto, "¿tienen tacos?");
  assert.equal(enviados.length, 0);
});

test("panel: cada negocio entra con SU clave; tú entras a todos; su clave no abre el tuyo", async () => {
  const n = neg.getNegocioCliente("tacos-el-guero");
  const otro = neg.getNegocioCliente("barberia-don-pepe");
  const get = (p, clave) => fetch(base + p, { headers: clave ? { "x-admin-token": clave } : {} });
  assert.equal((await get("/n/tacos-el-guero/admin/api/config")).status, 401);
  const r = await get("/n/tacos-el-guero/admin/api/config", n.meta.token);
  assert.equal(r.status, 200);
  const c = await r.json();
  assert.equal(c.esNegocio, true);
  assert.equal(c.negocio, "Tacos El Güero");
  assert.equal((await get("/n/tacos-el-guero/admin/api/config", otro.meta.token)).status, 401, "la clave de otro negocio no sirve");
  assert.equal((await get("/n/tacos-el-guero/admin/api/config", process.env.ADMIN_TOKEN)).status, 200);
  assert.equal((await get("/admin/api/negocios", n.meta.token)).status, 401, "un negocio no ve tu panel");
  // Las conversaciones del panel del negocio son solo las suyas.
  const convs = await (await get("/n/barberia-don-pepe/admin/api/conversaciones", otro.meta.token)).json();
  assert.deepEqual(convs.map((x) => x.nombre), ["Cliente de barbería"]);
  // Tu panel lista a los negocios con sus números.
  const lista = await (await get("/admin/api/negocios", process.env.ADMIN_TOKEN)).json();
  assert.deepEqual(lista.map((x) => x.slug).sort(), ["barberia-don-pepe", "tacos-el-guero"]);
  assert.ok(!JSON.stringify(lista).includes(n.meta.token), "la lista no expone las claves");
  assert.ok(!JSON.stringify(lista).includes("APP_USR"), "ni los tokens de pago");
});

test("pausar un negocio lo saca de las tareas automáticas", async () => {
  const n = neg.getNegocioCliente("barberia-don-pepe");
  neg.actualizarNegocio(n, { activo: false });
  const vistos = [];
  await neg.paraCadaNegocio((x) => vistos.push(x.slug));
  assert.deepEqual(vistos, ["tacos-el-guero"]);
  neg.actualizarNegocio(n, { activo: true });
});
