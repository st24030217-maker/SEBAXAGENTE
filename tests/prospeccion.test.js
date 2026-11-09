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
const { calificar, redactarPlantilla, pieCorreo, esLocal } = await import("../src/prospeccion/redactar.js");
const { guardarProspecto, darDeBaja, getProspecto, dentroDeHorarioEnvio, estadoAutomatico } = await import("../src/prospeccion/servicio.js");

const cfg = loadProspeccion(path.join(ROOT, "config", "prospeccion.yaml"));
before(() => openDb(":memory:"));
const BARBERIAS = cfg.rubros.find((r) => r.nombre === "Barberías");
const LAGUNA = cfg.ciudades.find((c) => c.nombre === "Torreón");
const FUERA = cfg.ciudades.find((c) => !c.local);

const REG = {
  Id: "123", Nombre: "BARBERIA EL GÜERO", Razon_social: "", Clase_actividad: "Salones y clínicas de belleza y peluquerías",
  Estrato: "6 a 10 personas", Tipo_vialidad: "AVENIDA", Calle: "MORELOS", Num_Exterior: "45", Num_Interior: "", Colonia: "CENTRO",
  Telefono: "871 123 4567", Correo_e: "Contacto@Barberia.com", Sitio_internet: "", Latitud: "25.54", Longitud: "-103.41",
};

test("convierte un registro del DENUE y normaliza datos", () => {
  const p = desdeDenue(REG, cfg.ciudades[0], BARBERIAS);
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
  const p = { ...desdeDenue(REG, cfg.ciudades[0], BARBERIAS) };
  const m = redactarPlantilla(p, cfg);
  assert.match(m.correo, /Barberia el Güero/);
  assert.ok(m.correo.includes(cfg.remitente.portafolio));
  assert.doesNotMatch(m.correo, /\$\s?\d/);
  assert.match(redactarPlantilla({ ...p, asunto: "Hola" }, cfg, { seguimiento: true }).asunto, /^Re: /);
  assert.match(pieCorreo(cfg, null), /BAJA/);
});

test("no duplica prospectos y la baja los bloquea", () => {
  const p = desdeDenue(REG, cfg.ciudades[0], BARBERIAS);
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

test("La Laguna es local y suma un punto; las otras ciudades se atienden a distancia", () => {
  const base = { telefono: "8711234567" };
  const aqui = { ...base, ciudad: LAGUNA.nombre };
  const lejos = { ...base, ciudad: FUERA.nombre };
  assert.equal(esLocal(aqui, cfg), true);
  assert.equal(esLocal(lejos, cfg), false);
  assert.equal(calificar(aqui, cfg).puntaje, calificar(lejos, cfg).puntaje + 1);
  const p = desdeDenue({ ...REG, Id: "999", Telefono: "8441234567", Correo_e: "" }, FUERA, BARBERIAS);
  const m = redactarPlantilla(p, cfg);
  assert.match(m.whatsapp, /a distancia/);
  assert.doesNotMatch(m.whatsapp, /La Laguna/);
  assert.match(redactarPlantilla(desdeDenue(REG, LAGUNA, BARBERIAS), cfg).whatsapp, /La Laguna/);
});

test("el piloto busca primero el rubro que más falta, empezando por La Laguna", () => {
  const e = estadoAutomatico(new Date("2026-11-09T17:00:00Z"));
  assert.ok(e._sig, "debe haber una búsqueda pendiente");
  assert.equal(cfg.ciudades[e._sig.ci].local, true);
  assert.notEqual(e._sig.rubro, "Barberías", "Barberías ya tiene un prospecto; otro rubro con 0 va primero");
});
