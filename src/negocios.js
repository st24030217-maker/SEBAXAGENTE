// Registro de negocios cliente: cada negocio que contrata el agente tiene su carpeta en
// data/negocios/<slug>/ con:
//   negocio.json     nombre, clave de su panel, WhatsApp del dueño, activo, pagos
//   negocio.yaml     su catálogo, horario, políticas... (lo que sabe su agente)
//   agente.db        sus conversaciones, leads, pedidos y citas (separados de los tuyos)
//   whatsapp-sesion  la vinculación de SU chip de WhatsApp
// Todo lo que se hace para un negocio corre dentro de conNegocio(n, ...) (ver contexto.js).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { settings, ROOT, validarNegocio } from "./config.js";
import { conNegocio } from "./contexto.js";

export const carpetaNegocios = () =>
  process.env.NEGOCIOS_DIR ||
  path.join(settings.dbPath === ":memory:" ? path.join(ROOT, "data") : path.dirname(settings.dbPath), "negocios");

const PLANTILLA = path.join(ROOT, "config", "plantilla-negocio.yaml");
export const SLUG_OK = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const RESERVADOS = new Set(["admin", "api", "webhooks", "health", "m", "muestras", "pago", "baja", "n", "www", "principal"]);

const cache = new Map(); // slug -> negocio (con su base abierta y su config en memoria)

/** "Tacos El Güero" -> "tacos-el-guero" */
export const slugDe = (texto) =>
  String(texto || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");

const diez = (s) => {
  const d = String(s || "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
};

function construir(slug) {
  const dir = path.join(carpetaNegocios(), slug);
  const metaPath = path.join(dir, "negocio.json");
  if (!fs.existsSync(metaPath)) return null;
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  return {
    slug,
    dir,
    metaPath,
    yamlPath: path.join(dir, "negocio.yaml"),
    dbPath: path.join(dir, "agente.db"),
    sesionDir: path.join(dir, "whatsapp-sesion"),
    meta,
    config: null, // se carga al primer uso (getNegocio)
    db: null, // se abre al primer uso (getDb)
  };
}

/** Un negocio por su slug (o null si no existe). */
export function getNegocioCliente(slug) {
  if (!SLUG_OK.test(String(slug || ""))) return null;
  if (cache.has(slug)) return cache.get(slug);
  const n = construir(slug);
  if (n) cache.set(slug, n);
  return n;
}

/** Todos los negocios registrados (activos e inactivos), por fecha de alta. */
export function listarNegocios() {
  const dir = carpetaNegocios();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && SLUG_OK.test(e.name))
    .map((e) => getNegocioCliente(e.name))
    .filter(Boolean)
    .sort((a, b) => String(a.meta.creado).localeCompare(String(b.meta.creado)));
}

export const negociosActivos = () => listarNegocios().filter((n) => n.meta.activo !== false);

/** Ejecuta fn para cada negocio activo dentro de su contexto. Un negocio con error no frena a los demás. */
export async function paraCadaNegocio(fn, etiqueta = "negocios") {
  for (const n of negociosActivos()) {
    try {
      await conNegocio(n, () => fn(n));
    } catch (e) {
      console.error(`[${etiqueta}] ${n.slug}:`, e.message);
    }
  }
}

const nuevaClave = () => crypto.randomBytes(12).toString("base64url");

/**
 * Da de alta un negocio con la plantilla. Devuelve el negocio (con su clave de panel en meta.token).
 * @param {{nombre: string, slug?: string, dueno?: string, telefono?: string}} datos
 */
export function crearNegocio({ nombre, slug, dueno, telefono } = {}) {
  nombre = String(nombre || "").trim();
  if (nombre.length < 2) throw new Error("Escribe el nombre del negocio.");
  slug = slugDe(slug || nombre);
  if (!SLUG_OK.test(slug)) throw new Error("La dirección del negocio debe tener de 3 a 40 letras, números o guiones.");
  if (RESERVADOS.has(slug)) throw new Error(`"${slug}" está reservado; usa otra dirección.`);
  const dir = path.join(carpetaNegocios(), slug);
  if (fs.existsSync(dir)) throw new Error(`Ya existe un negocio con la dirección "${slug}".`);
  const duenoTel = dueno ? diez(dueno) : null;
  if (dueno && !duenoTel) throw new Error("El WhatsApp del dueño debe tener 10 dígitos.");

  const comillas = (s) => s.replace(/[\r\n]+/g, " ").replace(/\\/g, "").replace(/"/g, "'");
  const yaml = fs
    .readFileSync(PLANTILLA, "utf8")
    .replaceAll("{{NOMBRE}}", comillas(nombre))
    .replaceAll("{{TELEFONO}}", comillas(String(telefono || (duenoTel ? `+52 ${duenoTel}` : ""))));
  validarNegocio(YAML.parse(yaml)); // la plantilla siempre debe ser válida

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "negocio.yaml"), yaml);
  const meta = { nombre, token: nuevaClave(), dueno: duenoTel, activo: true, creado: new Date().toISOString(), pagos: { proveedor: "transferencia" } };
  fs.writeFileSync(path.join(dir, "negocio.json"), JSON.stringify(meta, null, 2));
  cache.delete(slug);
  return getNegocioCliente(slug);
}

/** Cambia datos del negocio (nombre, dueño, activo, pagos). Devuelve el negocio actualizado. */
export function actualizarNegocio(n, cambios = {}) {
  const meta = { ...n.meta };
  if (cambios.nombre !== undefined) {
    const v = String(cambios.nombre).trim();
    if (v.length < 2) throw new Error("El nombre es muy corto.");
    meta.nombre = v;
  }
  if (cambios.dueno !== undefined) {
    const v = cambios.dueno ? diez(cambios.dueno) : null;
    if (cambios.dueno && !v) throw new Error("El WhatsApp del dueño debe tener 10 dígitos.");
    meta.dueno = v;
  }
  if (cambios.activo !== undefined) meta.activo = !!cambios.activo;
  if (cambios.nuevaClave) meta.token = nuevaClave();
  if (cambios.pagos !== undefined) {
    const p = cambios.pagos || {};
    const proveedor = p.proveedor === "mercadopago" ? "mercadopago" : "transferencia";
    const token = String(p.mercadopago_token ?? meta.pagos?.mercadopago_token ?? "").trim();
    if (proveedor === "mercadopago" && !token) throw new Error("Para Mercado Pago falta el Access Token del negocio.");
    meta.pagos = { proveedor, ...(token ? { mercadopago_token: token } : {}) };
  }
  fs.writeFileSync(n.metaPath, JSON.stringify(meta, null, 2));
  n.meta = meta;
  return n;
}

export const leerYaml = (n) => fs.readFileSync(n.yamlPath, "utf8");

/** Guarda la configuración nueva solo si es válida; el agente la usa desde el siguiente mensaje. */
export function guardarYaml(n, texto) {
  let data;
  try {
    data = YAML.parse(String(texto || ""));
  } catch (e) {
    throw new Error(`El texto tiene un error de formato (línea ${e.linePos?.[0]?.line ?? "?"}): ${e.message.split("\n")[0]}`);
  }
  const config = validarNegocio(data, "la configuración");
  const tmp = `${n.yamlPath}.tmp`;
  fs.writeFileSync(tmp, String(texto));
  fs.renameSync(tmp, n.yamlPath);
  n.config = config;
  return config;
}

/** Datos del negocio sin secretos (para listados del panel). */
export const publico = (n) => ({
  slug: n.slug,
  nombre: n.meta.nombre,
  dueno: n.meta.dueno || null,
  activo: n.meta.activo !== false,
  creado: n.meta.creado,
  pagos: n.meta.pagos?.proveedor || "transferencia",
  panel: `${settings.publicUrl}/n/${n.slug}/admin`,
  chat: `${settings.publicUrl}/n/${n.slug}/chat`,
});

/** Para tests: olvida los negocios en memoria (cierra sus bases). */
export function olvidarNegocios() {
  for (const n of cache.values()) {
    try {
      n.db?.close();
    } catch {}
  }
  cache.clear();
}
