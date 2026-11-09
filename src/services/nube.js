// Respaldo automático en Supabase Storage (gratis) para hosts sin disco, como el plan gratis de Render.
//  - Al arrancar: si no hay datos locales, descarga la base y la sesión de WhatsApp del respaldo.
//  - Cada pocos minutos (y al apagarse): sube una copia nueva.
// Se activa solo si existen SUPABASE_URL y SUPABASE_SERVICE_KEY.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { settings } from "../config.js";

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
function empacarSesion() {
  if (!fs.existsSync(SESION())) return null;
  const archivos = {};
  for (const f of fs.readdirSync(SESION())) {
    const p = path.join(SESION(), f);
    if (fs.statSync(p).isFile()) archivos[f] = fs.readFileSync(p).toString("base64");
  }
  return Object.keys(archivos).length ? JSON.stringify(archivos) : null;
}

function desempacarSesion(json) {
  const archivos = JSON.parse(json);
  fs.mkdirSync(SESION(), { recursive: true });
  for (const [f, b64] of Object.entries(archivos)) {
    if (f.includes("/") || f.includes("\\") || f.includes("..")) continue;
    fs.writeFileSync(path.join(SESION(), f), Buffer.from(b64, "base64"));
  }
  return Object.keys(archivos).length;
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
    const db = await descargar("agente.db");
    if (db) {
      fs.writeFileSync(settings.dbPath, db);
      console.log(`[nube] base restaurada desde Supabase (${Math.round(db.length / 1024)} KB)`);
    } else console.log("[nube] no hay respaldo previo en Supabase: se empieza desde cero");
    const ses = await descargar("whatsapp-sesion.json");
    if (ses) console.log(`[nube] sesión de WhatsApp restaurada (${desempacarSesion(ses.toString("utf8"))} archivos)`);
    puedeRespaldar = true;
  } catch (e) {
    console.error("[nube] NO se pudo restaurar el respaldo; los respaldos quedan pausados para no borrar el bueno:", e.message);
  }
}

/** Sube una copia de la base y de la sesión de WhatsApp. */
export async function respaldarEnNube(getDb) {
  if (!nubeConfigurada() || !puedeRespaldar) return null;
  const tmp = path.join(os.tmpdir(), `respaldo-${Date.now()}.db`);
  try {
    getDb().exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const db = fs.readFileSync(tmp);
    await subir("agente.db", db);
    // Copia del día aparte, por si algo sale mal (se guarda una por día de la semana).
    const dia = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"][new Date().getDay()];
    await subir(`diarios/agente-${dia}.db`, db);
    const ses = empacarSesion();
    if (ses) await subir("whatsapp-sesion.json", ses, "application/json");
    ultimoRespaldo = new Date().toISOString();
    return ultimoRespaldo;
  } finally {
    fs.rm(tmp, { force: true }, () => {});
  }
}

export const estadoNube = () => ({ activa: nubeConfigurada(), puedeRespaldar, ultimoRespaldo });

/** Respaldos periódicos + uno final al apagarse (Render avisa con SIGTERM antes de detener). */
export function startNube(getDb, cadaMin = Number(process.env.RESPALDO_CADA_MIN || 5)) {
  if (!nubeConfigurada()) return;
  console.log(`   Respaldo en la nube: Supabase cada ${cadaMin} min`);
  const correr = () => respaldarEnNube(getDb).catch((e) => console.error("[nube] respaldo falló:", e.message));
  setTimeout(correr, 60_000);
  setInterval(correr, cadaMin * 60_000);
  let apagando = false;
  const alApagar = async () => {
    if (apagando) return;
    apagando = true;
    console.log("[nube] apagándose: guardando respaldo final…");
    await Promise.race([correr(), new Promise((r) => setTimeout(r, 20_000))]);
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
