// Videos personalizados por prospecto (HyperFrames). Se generan en la noche con
// scripts/videos-prospectos.mjs, en un proceso aparte para no frenar al agente,
// y el primer mensaje de WhatsApp los usa en lugar del video de presentación genérico.
// VIDEOS_PERSONALIZADOS=false los apaga (todo sigue con el video de presentación).
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ROOT } from "../config.js";
import { getProspeccion } from "./config.js";
import { localParts } from "../services/calendar.js";

const CARPETA = path.join(ROOT, "data", "videos");
const SCRIPT = path.join(ROOT, "scripts", "videos-prospectos.mjs");
const activos = () => !/^(0|false|no)$/i.test(process.env.VIDEOS_PERSONALIZADOS || "true");

/** Ruta del video de ese prospecto, si ya está listo (menos de 16 MB, el límite de WhatsApp). */
export function videoDeProspecto(id) {
  if (!activos()) return null;
  const ruta = path.join(CARPETA, `${id}.mp4`);
  try {
    const st = fs.statSync(ruta);
    return st.isFile() && st.size > 0 && st.size < 16 * 1024 * 1024 ? ruta : null;
  } catch {
    return null;
  }
}

/** Ya se mandó: se borra para no llenar el disco. */
export function borrarVideoDeProspecto(id) {
  fs.rmSync(path.join(CARPETA, `${id}.mp4`), { force: true });
}

let hijo = null;
/** De 8 pm a 7 am (hora de La Laguna), si no hay uno corriendo, lanza el generador. */
function revisar(ahora = new Date()) {
  if (!activos() || hijo || !fs.existsSync(SCRIPT)) return;
  const hour = localParts(ahora, getProspeccion().envio.zona_horaria).h;
  if (hour >= 7 && hour < 20) return;
  const cuantos = Number(process.env.VIDEOS_POR_NOCHE || 20);
  fs.mkdirSync(path.join(ROOT, "logs"), { recursive: true });
  const log = fs.openSync(path.join(ROOT, "logs", "videos.log"), "a");
  hijo = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", SCRIPT, String(cuantos)], {
    cwd: ROOT,
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
  hijo.on("exit", () => {
    hijo = null;
    fs.closeSync(log);
  });
  hijo.on("error", (e) => console.error("[videos] no se pudo lanzar el generador:", e.message));
}

export function startVideosNocturnos(intervaloMs = 20 * 60_000) {
  if (!activos()) return null;
  setTimeout(() => revisar(), 60_000);
  return setInterval(() => revisar(), intervaloMs);
}

export function detenerVideos() {
  try {
    hijo?.kill();
  } catch {}
}
