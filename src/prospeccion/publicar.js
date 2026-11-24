// Muestras fijas en GitHub Pages: cada boceto se guarda como página estática en un repo aparte
// (BOCETOS_REPO, clonado en BOCETOS_DIR) y su link (BOCETOS_URL) ya no depende del túnel ni de
// que la laptop esté prendida. Cada pocos minutos se vuelven a generar y, si algo cambió, se suben.
// La visita se sigue avisando: la página le pregunta a tunel.json la dirección actual del agente
// y le hace ping (si la laptop está apagada, la página abre igual, solo no avisa).
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { settings, ROOT } from "../config.js";
import { getDb as db } from "../db.js";
import { renderBoceto, urlBoceto, bocetosFijos, baseBocetos } from "./boceto.js";

const run = promisify(execFile);
const ESTADOS = ["aprobado", "enviado", "respondio", "fallido", "whatsapp"];
// Las que pidieron no ser contactadas o se descartaron nunca se publican, aunque se hayan marcado.
const NUNCA = ["no_contactar", "descartado"];
/** ¿Esta muestra está (o debe estar) en GitHub Pages? (por su estado, o porque la publicaste sin mandarla) */
export const publicada = (p) => !!p?.boceto && (ESTADOS.includes(p.estado) || (!!p.publicado && !NUNCA.includes(p.estado)));

export { bocetosFijos, baseBocetos };

const escribir = (f, txt) => {
  const antes = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
  if (antes === txt) return false;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, txt);
  return true;
};

function pagina(p, ruta) {
  const clave = ruta.split("-").pop();
  const ping = `<script>fetch("../../tunel.json",{cache:"no-store"}).then(r=>r.json()).then(t=>t.url&&fetch(t.url+"/m/${clave}/visto"+location.search,{mode:"no-cors",keepalive:true})).catch(()=>{})</script>`;
  return renderBoceto(p)
    .replace(/src="\/presentacion\.mp4/g, 'src="../../presentacion.mp4')
    .replace("</body>", `${ping}</body>`);
}

/** Genera las páginas y las sube si cambió algo. Devuelve cuántos archivos cambiaron. */
async function publicar() {
  const dir = process.env.BOCETOS_DIR;
  if (!fs.existsSync(path.join(dir, ".git"))) throw new Error(`BOCETOS_DIR no es un repo git: ${dir}`);
  let cambios = 0;
  const filas = db()
    .prepare(
      `SELECT * FROM prospectos WHERE boceto IS NOT NULL AND (estado IN (${ESTADOS.map(() => "?").join(",")})
         OR (IFNULL(publicado, 0) = 1 AND estado NOT IN (${NUNCA.map(() => "?").join(",")})))`
    )
    .all(...ESTADOS, ...NUNCA);
  const vivas = new Set();
  for (const p of filas) {
    const ruta = urlBoceto(p).split("/m/").pop();
    vivas.add(ruta);
    if (escribir(path.join(dir, "m", ruta, "index.html"), pagina(p, ruta))) cambios++;
  }
  // Las que ya no deben estar (no contactar, descartadas, nombre cambiado) se quitan.
  const mdir = path.join(dir, "m");
  for (const d of fs.existsSync(mdir) ? fs.readdirSync(mdir) : []) {
    if (!vivas.has(d)) { fs.rmSync(path.join(mdir, d), { recursive: true, force: true }); cambios++; }
  }
  if (/^https:\/\//.test(settings.publicUrl) && escribir(path.join(dir, "tunel.json"), JSON.stringify({ url: settings.publicUrl }))) cambios++;
  const video = path.join(dir, "presentacion.mp4");
  const origen = path.join(ROOT, "public", "presentacion.mp4");
  if (fs.existsSync(origen) && (!fs.existsSync(video) || fs.statSync(video).size !== fs.statSync(origen).size)) { fs.copyFileSync(origen, video); cambios++; }
  if (escribir(path.join(dir, ".nojekyll"), "")) cambios++;
  if (escribir(path.join(dir, "robots.txt"), "User-agent: *\nDisallow: /\n")) cambios++;
  if (escribir(path.join(dir, "index.html"), '<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>sss.solutions</title><meta http-equiv="refresh" content="0;url=https://portafolio-salinas-serrano-sebastia.vercel.app">')) cambios++;
  if (!cambios) return 0;
  const git = (...a) => run("git", a, { cwd: dir, windowsHide: true, timeout: 180_000 });
  await git("add", "-A");
  const { stdout } = await git("status", "--porcelain");
  if (!stdout.trim()) return 0;
  await git("-c", "user.name=Agente Sebax", "-c", "user.email=agente@sss.solutions", "commit", "-q", "-m", `Muestras: ${filas.length} activas`);
  await git("push", "-q", "origin", "HEAD");
  console.log(`[muestras] subidas a GitHub (${cambios} cambios, ${filas.length} activas)`);
  return cambios;
}

let corriendo = null;
let otraVez = false;
/** Pide publicar; si ya hay una publicación en curso, se repite al terminar. */
export function publicarBocetos() {
  if (!bocetosFijos()) return Promise.resolve(0);
  if (corriendo) { otraVez = true; return corriendo; }
  corriendo = publicar()
    .catch((e) => { console.error("[muestras]", e.message); return 0; })
    .finally(() => { corriendo = null; if (otraVez) { otraVez = false; publicarBocetos(); } });
  return corriendo;
}

export function startMuestrasFijas() {
  if (!bocetosFijos()) return;
  console.log(`   Muestras fijas: ${baseBocetos()}/m/…`);
  setTimeout(publicarBocetos, 20_000);
  setInterval(publicarBocetos, 3 * 60_000);
}

/**
 * Antes de mandar el primer mensaje: si la muestra aún no está en GitHub Pages, la sube y espera
 * a que abra (hasta ~4 min). Devuelve false si no quedó en línea (mejor no mandar un link roto).
 */
export async function asegurarPublicada(p) {
  if (!bocetosFijos() || !p?.boceto) return true;
  const url = `${urlBoceto(p)}/`;
  const abre = () => fetch(url, { method: "HEAD", cache: "no-store" }).then((r) => r.ok).catch(() => false);
  if (await abre()) return true;
  await publicarBocetos();
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 10_000));
    if (await abre()) return true;
  }
  console.error(`[muestras] la muestra de ${p.nombre} no abrió en GitHub Pages: ${url}`);
  return false;
}
