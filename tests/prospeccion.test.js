// Tests de prospección (no llaman al INEGI, a Google ni a Claude):  npm test
import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

process.env.DB_PATH = ":memory:";
// Vacías (no borradas): así el .env real no las rellena y las pruebas nunca llaman a una IA.
process.env.ANTHROPIC_API_KEY = "";
process.env.GEMINI_API_KEY = "";

const { openDb } = await import("../src/db.js");
const { ROOT } = await import("../src/config.js");
const { loadProspeccion } = await import("../src/prospeccion/config.js");
const { desdeDenue, normalizarTelefono, normalizarWeb, limpiarEmail } = await import("../src/prospeccion/fuentes.js");
const { calificar, redactarPlantilla, pieCorreo } = await import("../src/prospeccion/redactar.js");
const { guardarProspecto, darDeBaja, getProspecto, dentroDeHorarioEnvio } = await import("../src/prospeccion/servicio.js");

const cfg = loadProspeccion(path.join(ROOT, "config", "prospeccion.yaml"));
before(() => openDb(":memory:"));

const REG = {
  Id: "123", Nombre: "BARBERIA EL GÜERO", Razon_social: "", Clase_actividad: "Salones y clínicas de belleza y peluquerías",
  Estrato: "6 a 10 personas", Tipo_vialidad: "AVENIDA", Calle: "MORELOS", Num_Exterior: "45", Num_Interior: "", Colonia: "CENTRO",
  Telefono: "871 123 4567", Correo_e: "Contacto@Barberia.com", Sitio_internet: "", Latitud: "25.54", Longitud: "-103.41",
};

test("convierte un registro del DENUE y normaliza datos", () => {
  const p = desdeDenue(REG, cfg.ciudades[0], cfg.rubros[2]);
  assert.equal(p.nombre, "Barberia el Güero");
  assert.equal(p.telefono, "8711234567");
  assert.equal(p.email, "contacto@barberia.com");
  assert.equal(p.ciudad, "Torreón");
  assert.equal(p.rubro, "Barberías");
});

test("normaliza teléfonos, webs y descarta correos basura", () => {
  assert.equal(normalizarTelefono("+52 1 871 123 4567"), "8711234567");
  assert.equal(normalizarTelefono("123"), "");
  assert.equal(normalizarWeb("www.ejemplo.mx"), "https://www.ejemplo.mx/");
  assert.equal(normalizarWeb("0"), "");
  assert.equal(limpiarEmail("logo@2x.png"), "");
  assert.equal(limpiarEmail("hola@negocio.mx"), "hola@negocio.mx");
});

test("califica mejor a un negocio sin web y con correo", () => {
  const sinWeb = calificar({ email: "a@b.mx", telefono: "8711234567" });
  const webBuena = calificar({ email: "a@b.mx", telefono: "8711234567", sitio_web: "https://x.mx", web_puntaje: 95 });
  const sinContacto = calificar({});
  assert.ok(sinWeb.puntaje > webBuena.puntaje);
  assert.equal(sinContacto.puntaje, 0);
});

test("la plantilla menciona el negocio, el portafolio y no inventa precios", () => {
  const p = { ...desdeDenue(REG, cfg.ciudades[0], cfg.rubros[2]) };
  const m = redactarPlantilla(p, cfg);
  assert.match(m.correo, /Barberia el Güero/);
  assert.ok(m.correo.includes(cfg.remitente.portafolio));
  assert.doesNotMatch(m.correo, /\$\s?\d/);
  assert.match(redactarPlantilla({ ...p, asunto: "Hola" }, cfg, { seguimiento: true }).asunto, /^Re: /);
  assert.match(pieCorreo(cfg, null), /BAJA/);
});

test("no duplica prospectos y la baja los bloquea", () => {
  const p = desdeDenue(REG, cfg.ciudades[0], cfg.rubros[2]);
  assert.equal(guardarProspecto(p), true);
  assert.equal(guardarProspecto(p), false);
  assert.equal(guardarProspecto({ ...p, externo_id: "otro" }), false, "mismo correo/teléfono = mismo negocio");
  const guardado = getProspecto(1);
  assert.ok(darDeBaja(guardado.baja_token));
  assert.equal(getProspecto(1).estado, "no_contactar");
  assert.equal(darDeBaja("token-falso"), null);
});

test("solo envía en horario hábil de La Laguna", () => {
  assert.equal(dentroDeHorarioEnvio(cfg, new Date("2026-11-09T17:00:00Z")), true); // lunes 11:00
  assert.equal(dentroDeHorarioEnvio(cfg, new Date("2026-11-09T03:00:00Z")), false); // domingo noche
  assert.equal(dentroDeHorarioEnvio(cfg, new Date("2026-11-14T17:00:00Z")), false); // sábado
});
