// Respaldo automático en Supabase Storage (gratis) para hosts sin disco, como el plan gratis de Render.
//  - Al arrancar: si no hay datos locales, descarga la base y la sesión de WhatsApp del respaldo.
//  - Cada 30 min (y al apagarse): sube una copia nueva, solo si algo cambió.
// Se activa solo si existen SUPABASE_URL y SUPABASE_SERVICE_KEY.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { settings } from "../config.js";
import { conNegocio } from "../contexto.js";

const URL_BASE = () => String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const CLAVE = () => process.env.SUPABASE_SERVICE_KEY || "";
const BUCKET = () => process.env.SUPABASE_BUCKET || "agente";
export const nubeConfigurada = () => !!(URL_BASE() && CLAVE());

const DATA = () => path.dirname(settings.dbPath);
const SESION = () => path.join(DATA(), "whatsapp-sesion");
const headers = (extra = {}) => ({ apikey: CLAVE(), Authorization: `Bearer ${CLAVE()}`, ...extra });

// Solo se respalda si la restauración salió bien (o no había nada que restaurar):
// así un fallo de red al arrancar nunca sobrescribe el respaldo bueno con una base vacía.
let puedeRespaldar = false;
let ultimoRespaldo = null;

async function descargar(nombre) {
  const r = await fetch(`${URL_BASE()}/storage/v1/object/${BUCKET()}/${nombre}`, { headers: headers(), signal: AbortSignal.timeout(60_000) });
  if (r.status === 404 || r.status === 400) {
    const t = await r.text();
    if (r.status === 404 || /not.?found/i.test(t)) return null;
    throw new Error(`Supabase ${r.status}: ${t.slice(0, 150)}`);
  }
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 150)}`);
  return Buffer.from(await r.arrayBuffer());
}

async function subir(nombre, cuerpo, tipo = "application/octet-stream") {
  const r = await fetch(`${URL_BASE()}/storage/v1/object/${BUCKET()}/${nombre}`, {
    method: "POST",
    headers: headers({ "Content-Type": tipo, "x-upsert": "true" }),
    body: cuerpo,
    signal: AbortSignal.timeout(120_000),
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 150)}`);
}

/** Empaqueta la carpeta de sesión de WhatsApp en un JSON {archivo: base64}. */
function empacarSesion(dir = SESION()) {
  if (!fs.existsSync(dir)) return null;
  const archivos = {};
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isFile()) archivos[f] = fs.readFileSync(p).toString("base64");
  }
  return Object.keys(archivos).length ? JSON.stringify(archivos) : null;
}

function desempacarSesion(json, dir = SESION()) {
  const archivos = JSON.parse(json);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, b64] of Object.entries(archivos)) {
    if (f.includes("/") || f.includes("\\") || f.includes("..")) continue;
    fs.writeFileSync(path.join(dir, f), Buffer.from(b64, "base64"));
  }
  return Object.keys(archivos).length;
}

// ---------- Negocios cliente (cada uno en negocios/<slug>/ dentro del bucket) ----------

const firmas = new Map(); // slug -> huella del último respaldo (solo se sube lo que cambió)
function huellaNegocio(n) {
  const t = (p) => {
    try {
      return fs.statSync(p).mtimeMs;
    } catch {
      return 0;
    }
  };
  let ses = 0;
  try {
    for (const f of fs.readdirSync(n.sesionDir)) ses = Math.max(ses, t(path.join(n.sesionDir, f)));
  } catch {}
  return [t(n.dbPath), t(`${n.dbPath}-wal`), t(n.yamlPath), t(n.metaPath), ses].join("|");
}

async function respaldarNegocios() {
  const { listarNegocios } = await import("../negocios.js");
  const { getDb } = await import("../db.js");
  const lista = listarNegocios();
  await subir("negocios/indice.json", JSON.stringify(lista.map((n) => n.slug)), "application/json");
  for (const n of lista) {
    const h = huellaNegocio(n);
    if (firmas.get(n.slug) === h) continue;
    const tmp = path.join(os.tmpdir(), `respaldo-${n.slug}-${Date.now()}.db`);
    try {
      conNegocio(n, () => getDb().exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`));
      await subir(`negocios/${n.slug}/agente.db`, fs.readFileSync(tmp));
      await subir(`negocios/${n.slug}/negocio.yaml`, fs.readFileSync(n.yamlPath), "text/plain");
      await subir(`negocios/${n.slug}/negocio.json`, fs.readFileSync(n.metaPath), "application/json");
      const ses = empacarSesion(n.sesionDir);
      if (ses) await subir(`negocios/${n.slug}/whatsapp-sesion.json`, ses, "application/json");
      firmas.set(n.slug, h);
    } catch (e) {
      console.error(`[nube] respaldo de ${n.slug} falló:`, e.message);
    } finally {
      fs.rm(tmp, { force: true }, () => {});
    }
  }
}

async function restaurarNegocios() {
  const indice = await descargar("negocios/indice.json");
  if (!indice) return;
  const { carpetaNegocios, SLUG_OK } = await import("../negocios.js");
  const slugs = JSON.parse(indice.toString("utf8")).filter((s) => SLUG_OK.test(s));
  for (const slug of slugs) {
    const dir = path.join(carpetaNegocios(), slug);
    if (fs.existsSync(path.join(dir, "negocio.json"))) continue; // ya está en disco
    const meta = await descargar(`negocios/${slug}/negocio.json`);
    const yaml = await descargar(`negocios/${slug}/negocio.yaml`);
    if (!meta || !yaml) continue;
    fs.mkdirSync(dir, { recursive: true });
    const db = await descargar(`negocios/${slug}/agente.db`);
    if (db) fs.writeFileSync(path.join(dir, "agente.db"), db);
    const ses = await descargar(`negocios/${slug}/whatsapp-sesion.json`);
    if (ses) desempacarSesion(ses.toString("utf8"), path.join(dir, "whatsapp-sesion"));
    fs.writeFileSync(path.join(dir, "negocio.yaml"), yaml);
    fs.writeFileSync(path.join(dir, "negocio.json"), meta); // al final: sin este archivo el negocio no "existe"
  }
  console.log(`[nube] negocios cliente restaurados: ${slugs.length}`);
}

/** Al arrancar (antes de abrir la base): recupera datos y sesión si el disco viene vacío. */
export async function restaurarDesdeNube() {
  if (!nubeConfigurada() || settings.dbPath === ":memory:") return;
  fs.mkdirSync(DATA(), { recursive: true });
  if (fs.existsSync(settings.dbPath)) {
    puedeRespaldar = true; // hay datos locales (disco persistente o PC): se respaldan, no se restauran
    return;
  }
  try {
    const dbGz = await descargar("agente.db.gz");
    const db = dbGz ? zlib.gunzipSync(dbGz) : await descargar("agente.db");
    if (db) {
      fs.writeFileSync(settings.dbPath, db);
      console.log(`[nube] base restaurada desde Supabase (${Math.round(db.length / 1024)} KB)`);
    } else console.log("[nube] no hay respaldo previo en Supabase: se empieza desde cero");
    const sesGz = await descargar("whatsapp-sesion.json.gz");
    const ses = sesGz ? zlib.gunzipSync(sesGz) : await descargar("whatsapp-sesion.json");
    if (ses) console.log(`[nube] sesión de WhatsApp restaurada (${desempacarSesion(ses.toString("utf8"))} archivos)`);
    await restaurarNegocios();
    puedeRespaldar = true;
  } catch (e) {
    console.error("[nube] NO se pudo restaurar el respaldo; los respaldos quedan pausados para no borrar el bueno:", e.message);
  }
}

// Huellas de lo último que se subió: si nada cambió, no se vuelve a subir (ahorra ancho de banda;
// Render cobra la salida a internet y subir la base cada pocos minutos se come los 5 GB gratis).
let huellaDb = null;
let huellaSesion = null;
let diarioSubido = null; // día de la semana cuya copia diaria ya se subió en esta ejecución
const huella = (b) => crypto.createHash("sha256").update(b).digest("hex");

/** Sube una copia de la base y de la sesión de WhatsApp, solo si cambiaron desde la última vez. */
export async function respaldarEnNube(getDb) {
  if (!nubeConfigurada() || !puedeRespaldar) return null;
  const tmp = path.join(os.tmpdir(), `respaldo-${Date.now()}.db`);
  try {
    getDb().exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const db = fs.readFileSync(tmp);
    const h = huella(db);
    if (h !== huellaDb) {
      await subir("agente.db.gz", zlib.gzipSync(db, { level: 9 }), "application/gzip");
      huellaDb = h;
    }
    // Copia del día aparte, por si algo sale mal (una por día de la semana, subida una sola vez al día).
    const dia = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"][new Date().getDay()];
    if (diarioSubido !== dia) {
      await subir(`diarios/agente-${dia}.db.gz`, zlib.gzipSync(db, { level: 9 }), "application/gzip");
      diarioSubido = dia;
    }
    const ses = empacarSesion();
    if (ses) {
      const hs = huella(ses);
      if (hs !== huellaSesion) {
        await subir("whatsapp-sesion.json.gz", zlib.gzipSync(ses, { level: 9 }), "application/gzip");
        huellaSesion = hs;
      }
    }
    await respaldarNegocios();
    ultimoRespaldo = new Date().toISOString();
    return ultimoRespaldo;
  } finally {
    fs.rm(tmp, { force: true }, () => {});
  }
}

export const estadoNube = () => ({ activa: nubeConfigurada(), puedeRespaldar, ultimoRespaldo });

// ---------- Turno: un solo agente activo a la vez ----------
// Al publicar una versión nueva, Render prende la nueva ANTES de apagar la vieja. Sin esto habría
// unos segundos con dos agentes usando el mismo chip (mensajes dobles) y la nueva cargaría un
// respaldo viejo. Con el turno: la nueva espera a que la vieja guarde todo y lo suelte.
const INSTANCIA = `${os.hostname()}-${process.pid}-${Date.now().toString(36)}`;
const VIDA_TURNO = 90_000; // si la otra no renueva en 90 s, se considera muerta
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
let renovador = null;

async function leerTurno() {
  const b = await descargar("turno.json");
  if (!b) return null;
  try {
    return JSON.parse(b.toString("utf8"));
  } catch {
    return null;
  }
}
const escribirTurno = (renovado) => subir("turno.json", JSON.stringify({ id: INSTANCIA, renovado }), "application/json");

/** Espera hasta tener el turno (sin Supabase, regresa de inmediato). */
export async function tomarTurno({ maxEsperaMs = 10 * 60_000 } = {}) {
  if (!nubeConfigurada() || settings.dbPath === ":memory:") return;
  const inicio = Date.now();
  let avisado = false;
  for (;;) {
    let t = null;
    let fallo = false;
    try {
      t = await leerTurno();
    } catch (e) {
      fallo = true;
      console.error("[nube] no se pudo leer el turno:", e.message);
    }
    const vencido = Date.now() - inicio > maxEsperaMs;
    const libre = !fallo && (!t || t.id === INSTANCIA || Date.now() - Number(t.renovado || 0) > VIDA_TURNO);
    if (libre || vencido) {
      try {
        await escribirTurno(Date.now());
        await espera(3000);
        const t2 = await leerTurno();
        if (vencido || !t2 || t2.id === INSTANCIA) break; // si otra lo tomó al mismo tiempo, se vuelve a esperar
      } catch (e) {
        console.error("[nube] no se pudo tomar el turno:", e.message);
        if (vencido) break;
      }
    } else if (!avisado) {
      console.log("[nube] la versión anterior sigue activa: espero a que guarde y se apague (así nunca hay dos usando el chip)");
      avisado = true;
    }
    await espera(5000);
  }
  console.log(`[nube] turno tomado tras ${Math.round((Date.now() - inicio) / 1000)} s`);
  renovador = setInterval(() => escribirTurno(Date.now()).catch((e) => console.error("[nube] renovar turno:", e.message)), 30_000);
}

/** Suelta el turno para que la siguiente versión arranque de inmediato. */
export async function soltarTurno() {
  clearInterval(renovador);
  if (!nubeConfigurada()) return;
  try {
    const t = await leerTurno();
    if (t?.id === INSTANCIA) await escribirTurno(0);
  } catch {}
}

// Lo que hay que detener antes del respaldo final (por ejemplo, WhatsApp).
const alDetenerse = [];
export const antesDeApagar = (fn) => alDetenerse.push(fn);

/** Respaldos periódicos + uno final al apagarse (Render avisa con SIGTERM antes de detener). */
export function startNube(getDb, cadaMin = Number(process.env.RESPALDO_CADA_MIN || 30)) {
  if (!nubeConfigurada()) return;
  console.log(`   Respaldo en la nube: Supabase cada ${cadaMin} min`);
  const correr = () => respaldarEnNube(getDb).catch((e) => console.error("[nube] respaldo falló:", e.message));
  setTimeout(correr, 60_000);
  setInterval(correr, cadaMin * 60_000);
  let apagando = false;
  const alApagar = async () => {
    if (apagando) return;
    apagando = true;
    console.log("[nube] apagándose: dejo de enviar y guardo el respaldo final…");
    for (const fn of alDetenerse) {
      try {
        await fn();
      } catch {}
    }
    await Promise.race([correr(), new Promise((r) => setTimeout(r, 20_000))]);
    await Promise.race([soltarTurno(), new Promise((r) => setTimeout(r, 5_000))]);
    process.exit(0);
  };
  process.on("SIGTERM", alApagar);
  process.on("SIGINT", alApagar);
}

/** Mantiene despierto el plan gratis de Render: se visita a sí mismo por su URL pública. */
export function startDespierto() {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (!url || /^(0|false|no)$/i.test(process.env.MANTENER_DESPIERTO ?? "true")) return;
  console.log("   Modo despierto: auto-visita cada 10 min para que Render no lo duerma");
  setInterval(() => fetch(`${url}/health`, { signal: AbortSignal.timeout(20_000) }).catch(() => {}), 10 * 60_000);
}
