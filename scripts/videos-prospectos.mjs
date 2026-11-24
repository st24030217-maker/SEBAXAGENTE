// Genera el video personalizado (HyperFrames) de los siguientes prospectos de la fila de WhatsApp.
// Cada video queda en data/videos/<id>.mp4; al mandar el primer mensaje, el agente lo usa en lugar
// del video de presentación genérico. Sin video, todo sigue igual (sale la presentación).
//
// Uso:  node scripts/videos-prospectos.mjs [cuántos=20]
//       node scripts/videos-prospectos.mjs --id=1167   (solo ese prospecto, aunque ya no esté en la fila)
// Requiere: el agente prendido (para capturar el boceto en localhost), ffmpeg y la plantilla videos/prospecto.
// El agente lo lanza solo en la noche (ver src/prospeccion/videos.js).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLANTILLA = path.join(ROOT, "videos", "prospecto");
const SALIDA = path.join(ROOT, "data", "videos");
const LOCK = path.join(SALIDA, ".generando");
const PUERTO = process.env.PORT || 3000;
const SOLO = Number(process.argv.find((a) => a.startsWith("--id="))?.slice(5)) || null;
const CUANTOS = Number(process.argv.find((a) => /^d+$/.test(a)) || 20);
const CLI = "hyperframes@0.9.72"; // misma versión que la plantilla: los videos salen siempre iguales

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), "[videos]", ...a);

function binario(nombre, candidatos) {
  for (const c of candidatos) if (c && fs.existsSync(c)) return c;
  return nombre;
}
const FFMPEG = binario("ffmpeg", [process.env.FFMPEG_PATH, path.join(os.homedir(), ".local", "bin", "ffmpeg.exe")]);
function chrome() {
  const base = path.join(os.homedir(), ".cache", "hyperframes", "chrome", "chrome-headless-shell");
  if (!fs.existsSync(base)) return null;
  for (const v of fs.readdirSync(base).sort().reverse()) {
    const dir = path.join(base, v);
    for (const sub of fs.readdirSync(dir)) {
      const exe = path.join(dir, sub, process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell");
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

// Segunda pantalla del video: la mejor que tenga el boceto de ese giro, con su texto.
const PANTALLA2 = [
  ["tarjeta", "CLIENTE FRECUENTE", "Que regresen", "LEALTAD LEALTAD"],
  ["menu", "MENÚ DIGITAL", "Pedidos a tu WhatsApp", "PEDIDOS PEDIDOS"],
  ["hora", "CITAS EN LÍNEA", "Que agenden solos", "CITAS CITAS CITAS"],
  ["cotiza", "COTIZADOR", "Que coticen solos", "COTIZA COTIZA"],
  ["ia", "ASISTENTE DE IA", "Atiende 24/7", "24/7 24/7 24/7"],
  ["app", "TU APP", "En su celular", "APP APP APP APP"],
];

/** Los mismos que va a tomar enviarSiguienteWa, en el mismo orden, que todavía no tienen video. */
function siguientes(db, n) {
  const umbral = 6;
  const filas = [
    ...db.prepare("SELECT * FROM prospectos WHERE estado = 'aprobado' AND IFNULL(telefono,'') != '' AND fuente != 'ejemplo' AND IFNULL(whatsapp_texto,'') LIKE '%/m/%' ORDER BY puntaje DESC, id LIMIT ?").all(n * 3),
    ...db.prepare("SELECT * FROM prospectos WHERE estado = 'por_revisar' AND puntaje >= ? AND IFNULL(telefono,'') != '' AND fuente != 'ejemplo' AND IFNULL(whatsapp_texto,'') LIKE '%/m/%' ORDER BY puntaje DESC, id LIMIT ?").all(umbral, n * 3),
  ];
  return filas.filter((p) => !fs.existsSync(path.join(SALIDA, `${p.id}.mp4`))).slice(0, n);
}

// Perfil compartido entre capturas: las fotos del boceto se descargan una vez y quedan en caché.
const PERFIL = path.join(os.tmpdir(), "sss-videos-chrome");
function captura(exe, url, archivo) {
  execFileSync(exe, ["--headless", "--disable-gpu", `--user-data-dir=${PERFIL}`, "--hide-scrollbars", "--window-size=414,736", "--force-device-scale-factor=2.6087",
    "--virtual-time-budget=9000", `--screenshot=${archivo}`, url], { stdio: "ignore", timeout: 180_000 });
  if (!fs.existsSync(archivo)) throw new Error("no se pudo capturar el boceto");
}

/** hyperframes.mjs de la versión fijada en la caché de npx, si ya se descargó alguna vez. */
function hfLocal() {
  const cache = path.join(os.homedir(), process.platform === "win32" ? "AppData/Local/npm-cache/_npx" : ".npm/_npx");
  try {
    for (const d of fs.readdirSync(cache)) {
      const pkg = path.join(cache, d, "node_modules", "hyperframes", "package.json");
      if (fs.existsSync(pkg) && JSON.parse(fs.readFileSync(pkg, "utf8")).version === CLI.split("@")[1]) return path.join(path.dirname(pkg), "bin", "hyperframes.mjs");
    }
  } catch {}
  return null;
}

async function generar(p, exe) {
  const slug = p.whatsapp_texto.match(/\/m\/([a-z0-9-]+)/i)?.[1];
  if (!slug) throw new Error("sin link de boceto");
  // ?yo=1: la captura no cuenta como visita del negocio ni te manda aviso
  const url = `http://localhost:${PUERTO}/m/${slug}?yo=1`;
  const html = await (await fetch(url)).text();
  const color = html.match(/--c:\s*(#[0-9a-f]{3,8})/i)?.[1] || "#2f7cf6";

  const rel = path.join("assets", "p", String(p.id));
  const dir = path.join(PLANTILLA, rel);
  fs.mkdirSync(dir, { recursive: true });
  const tmpMp4 = path.join(dir, "video.mp4");
  try {
    const secciones = new Set([...html.matchAll(/id="s-([a-z-]+)"/g)].map((m) => m[1]));
    const [sec2, cap2k, cap2t, ghost2] = PANTALLA2.find(([s]) => secciones.has(s)) || PANTALLA2[PANTALLA2.length - 1];
    // La portada va al final: para entonces sus fotos ya se descargaron una vez.
    captura(exe, `${url}#s-${sec2}`, path.join(dir, "tarjeta.png"));
    captura(exe, `${url}#s-incluye`, path.join(dir, "incluye.png"));
    captura(exe, url, path.join(dir, "portada.png"));
    const vars = {
      nombre: p.nombre,
      zona: [p.colonia, p.ciudad].filter(Boolean).join(", ") || "La Laguna",
      c: color,
      img1: `${rel.replaceAll("\\", "/")}/portada.png`,
      img2: `${rel.replaceAll("\\", "/")}/tarjeta.png`,
      img3: `${rel.replaceAll("\\", "/")}/incluye.png`,
      cap2k, cap2t, ghost2,
    };
    const varsFile = path.join(dir, "vars.json");
    fs.writeFileSync(varsFile, JSON.stringify(vars));
    // Si la versión fijada ya está en la caché de npx, se llama directo: npx consulta internet en cada corrida
    // y con mala señal se queda colgado minutos.
    const local = hfLocal();
    if (local) execFileSync(process.execPath, [local, "render", "--variables-file", path.relative(PLANTILLA, varsFile).replaceAll("\\", "/"), "--output", path.relative(PLANTILLA, tmpMp4).replaceAll("\\", "/"), "--fps", "30"],
      { cwd: PLANTILLA, stdio: "ignore", timeout: 40 * 60_000 });
    else execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", // Rutas relativas a la plantilla: en Windows npx corre en shell y la carpeta tiene espacios.
      ["--yes", CLI, "render", "--variables-file", path.relative(PLANTILLA, varsFile).replaceAll("\\", "/"), "--output", path.relative(PLANTILLA, tmpMp4).replaceAll("\\", "/"), "--fps", "30"],
      { cwd: PLANTILLA, stdio: "ignore", timeout: 15 * 60_000, shell: process.platform === "win32" });
    if (!fs.existsSync(tmpMp4)) throw new Error("HyperFrames no produjo el video");
    // Comprimido para WhatsApp (~2.5 MB): carga rápido aunque el negocio tenga mala señal.
    const final = path.join(SALIDA, `${p.id}.mp4`);
    execFileSync(FFMPEG, ["-loglevel", "error", "-y", "-i", tmpMp4, "-c:v", "libx264", "-preset", "slow", "-crf", "27", "-pix_fmt", "yuv420p",
      "-profile:v", "high", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", `${final}.tmp.mp4`], { stdio: "ignore", timeout: 5 * 60_000 });
    fs.renameSync(`${final}.tmp.mp4`, final);
    return final;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  fs.mkdirSync(SALIDA, { recursive: true });
  // Un solo generador a la vez (la laptop tiene poca RAM).
  if (fs.existsSync(LOCK) && Date.now() - fs.statSync(LOCK).mtimeMs < 6 * 3600_000) return log("ya hay uno generando; salgo");
  fs.writeFileSync(LOCK, String(process.pid));
  try {
    const exe = chrome();
    if (!exe) throw new Error("No encontré el Chrome de HyperFrames (corre: npx hyperframes doctor)");
    try { await fetch(`http://localhost:${PUERTO}/muestras`); } catch { throw new Error("El agente no está prendido en localhost"); }
    const db = new DatabaseSync(process.env.DB_PATH || path.join(ROOT, "data", "agente.db"), { readOnly: true });
    const lista = SOLO ? db.prepare("SELECT * FROM prospectos WHERE id = ?").all(SOLO) : siguientes(db, CUANTOS);
    // Limpieza: videos de negocios que ya no están en la fila (se les escribió por otro lado, se descartaron…).
    const pendiente = db.prepare("SELECT 1 FROM prospectos WHERE id = ? AND estado IN ('aprobado','por_revisar')");
    if (!SOLO) for (const f of fs.readdirSync(SALIDA).filter((f) => /^d+.mp4$/.test(f))) {
      if (!pendiente.get(Number(f.slice(0, -4)))) fs.rmSync(path.join(SALIDA, f), { force: true });
    }
    db.close();
    log(`${lista.length} video(s) por generar`);
    let ok = 0;
    for (const p of lista) {
      const t0 = Date.now();
      try {
        await generar(p, exe);
        ok++;
        log(`#${p.id} ${p.nombre} listo en ${Math.round((Date.now() - t0) / 1000)} s`);
      } catch (e) {
        log(`#${p.id} ${p.nombre} falló: ${e.message}`);
      }
    }
    log(`terminado: ${ok}/${lista.length}`);
  } finally {
    fs.rmSync(LOCK, { force: true });
  }
}

main().catch((e) => { console.error("[videos]", e.message); process.exit(1); });
