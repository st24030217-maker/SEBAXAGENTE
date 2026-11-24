// Arma el contenido del día para Instagram a partir de data/contenido/<fecha>/plan.json:
//   reel.mp4      15 s vertical: 4 clips REALES de Mixkit (licencia libre: https://mixkit.co/license/#videoFree)
//                 unidos con transiciones (ffmpeg xfade) + textos, logo, cierre y música (HyperFrames, videos/contenido)
//   slide-1..5.png carrusel 1080×1350: fotos sacadas de esos mismos clips + textos (Chrome de HyperFrames)
// Al terminar escribe listo.json; si algo falla, fallo.txt (el agente manda entonces el guion en texto).
//
// Uso:  node scripts/contenido-ig.mjs data/contenido/2026-11-23
// Lo lanza el agente solo (src/services/contenido-ig.js). Requiere ffmpeg e internet.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLANTILLA = path.join(ROOT, "videos", "contenido");
const CLI = "hyperframes@0.9.72"; // misma versión que las otras plantillas
// 8 tomas de 1.5 s (2 por cada texto) con transiciones cortas: cortes rápidos, más dinámico.
const W = 1080, H = 1920, CORTES = [0, 1.5, 3, 4.5, 6, 7.5, 9, 10.6, 12.2], XFADE = 0.25;
const TOMAS_POR_ESCENA = 2;
let VELOCIDAD = 1.25; // las tomas van 25 % más rápido (los estilos tranquilos, 10 %)
const ESTILOS = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(PLANTILLA, "estilos.json"), "utf8"))).filter(([k]) => !k.startsWith("_")));
// Los que se eligen solos (los demás se pueden forzar con CONTENIDO_ESTILO)
const ACTIVOS = Object.keys(ESTILOS).filter((k) => ESTILOS[k].activo !== false);
// Géneros de música de Mixkit (licencia libre: https://mixkit.co/license/#musicFree). Cada día uno distinto.
const GENEROS = ["hip-hop", "electronic", "pop", "funk", "house", "upbeat", "corporate", "trap", "dance", "lofi", "rock", "latin"];
// Si la búsqueda del plan no da clips, se usan estas (negocios y celulares).
const RESPALDO = ["small business", "shop", "restaurant", "smartphone", "cashier", "coffee shop", "barber", "laptop"];

const dir = path.resolve(process.argv[2] || "");
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), "[contenido-ig]", ...a);
if (!fs.existsSync(path.join(dir, "plan.json"))) { console.error("Uso: node scripts/contenido-ig.mjs <carpeta con plan.json>"); process.exit(1); }
const plan = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"));

const binario = (nombre, candidatos) => candidatos.find((c) => c && fs.existsSync(c)) || nombre;
const FFMPEG = binario("ffmpeg", [process.env.FFMPEG_PATH, path.join(os.homedir(), ".local", "bin", "ffmpeg.exe")]);
const ff = (args, timeout = 5 * 60_000) => execFileSync(FFMPEG, ["-v", "error", "-y", ...args], { stdio: ["ignore", "ignore", "inherit"], timeout });

function chrome() {
  const base = path.join(os.homedir(), ".cache", "hyperframes", "chrome", "chrome-headless-shell");
  if (!fs.existsSync(base)) return null;
  for (const v of fs.readdirSync(base).sort().reverse()) {
    for (const sub of fs.readdirSync(path.join(base, v))) {
      const exe = path.join(base, v, sub, process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell");
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

/** hyperframes.mjs de la versión fijada en la caché de npx (npx consulta internet en cada corrida). */
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

/** listo.json de los días anteriores (el más reciente primero). */
function anteriores(dias = 30) {
  const padre = path.dirname(dir);
  const out = [];
  for (const f of fs.readdirSync(padre).filter((f) => f !== path.basename(dir)).sort().reverse().slice(0, dias)) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(padre, f, "listo.json"), "utf8"))); } catch {}
  }
  return out;
}
const clipsUsados = () => new Set(anteriores().flatMap((l) => l.clips || []));
const azar = (lista) => lista[Math.floor(Math.random() * lista.length)];

/** Un estilo que no se haya usado en los últimos días (con 6 estilos, no se repite en 5 días). */
function elegirEstilo() {
  const recientes = new Set(anteriores(ACTIVOS.length - 1).map((l) => l.estilo));
  const libres = ACTIVOS.filter((k) => !recientes.has(k));
  const id = ESTILOS[process.env.CONTENIDO_ESTILO] ? process.env.CONTENIDO_ESTILO : azar(libres.length ? libres : ACTIVOS);
  return { id, ...ESTILOS[id] };
}

const RE_MUSICA = /assets\.mixkit\.co\/music\/(\d+)\/(\d+)\.mp3/g;

/** Una canción de Mixkit que no haya sonado en el último mes, de un género distinto al de ayer. */
async function elegirMusica(trabajo, lista = GENEROS) {
  const prev = anteriores();
  const usadas = new Set(prev.map((l) => l.musica?.id));
  const generos = lista.filter((g) => g !== prev[0]?.musica?.genero).sort(() => Math.random() - 0.5);
  for (const genero of generos) {
    let ids = [];
    try {
      const html = await (await fetch(`https://mixkit.co/free-stock-music/tag/${genero}/`, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20_000) })).text();
      ids = [...new Set([...html.matchAll(RE_MUSICA)].filter((m) => m[1] === m[2]).map((m) => Number(m[1])))].filter((x) => !usadas.has(x));
    } catch {}
    if (ids.length < 3) continue;
    const id = azar(ids);
    const mp3 = path.join(trabajo, "cancion.mp3");
    try {
      const res = await fetch(`https://assets.mixkit.co/music/${id}/${id}.mp3`, { signal: AbortSignal.timeout(90_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(mp3, Buffer.from(await res.arrayBuffer()));
      // Arranca en la parte con energía (no en la intro), 15 s, con entrada y salida suaves y volumen parejo.
      let dur = 60;
      try { execFileSync(FFMPEG, ["-hide_banner", "-i", mp3], { stdio: "pipe" }); } catch (e) {
        const m = String(e.stderr).match(/Duration: (\d+):(\d+):([\d.]+)/);
        if (m) dur = +m[1] * 3600 + +m[2] * 60 + +m[3];
      }
      const desde = dur > 40 ? Math.min(25, dur * 0.25) : 0;
      ff(["-ss", desde.toFixed(2), "-t", "15", "-i", mp3, "-af", "afade=t=in:d=0.25,afade=t=out:st=13.6:d=1.4,loudnorm=I=-14:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "192k", path.join(trabajo, "assets", "musica.m4a")]);
      log(`música: ${genero} · ${id} (desde ${Math.round(desde)} s)`);
      return { id, genero };
    } catch (e) {
      log(`no se pudo usar la canción ${id}: ${e.message}`);
    }
  }
  log("música: la de siempre (no se pudo bajar otra)");
  return { id: null, genero: "base" };
}

const slug = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function buscarMixkit(termino) {
  const s = slug(termino);
  if (!s) return [];
  try {
    const html = await (await fetch(`https://mixkit.co/free-stock-video/${s}/`, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20_000) })).text();
    return [...new Set([...html.matchAll(/assets\.mixkit\.co\/videos\/(\d+)\//g)].map((m) => Number(m[1])))];
  } catch {
    return [];
  }
}

/** Un clip por escena: de la búsqueda del plan, sin repetir los de días anteriores ni los de hoy. */
async function elegirClips() {
  const usados = clipsUsados();
  const hoy = new Set();
  const elegidos = [];
  for (const [n, e] of plan.escenas.flatMap((e) => Array(TOMAS_POR_ESCENA).fill(e)).entries()) {
    const i = Math.floor(n / TOMAS_POR_ESCENA);
    let id = null;
    // Mixkit solo reconoce palabras sueltas ("stressed waiter" regresa videos genéricos): primero el sustantivo (la última palabra).
    const palabras = String(e.busqueda || "").trim().split(/\s+/).filter(Boolean);
    for (const t of [palabras.at(-1), e.busqueda, ...RESPALDO.slice(i), ...RESPALDO]) {
      const ids = (await buscarMixkit(t)).filter((x) => !hoy.has(x));
      const nuevos = ids.filter((x) => !usados.has(x));
      const lista = nuevos.length ? nuevos : ids;
      if (lista.length) { id = lista[Math.floor(Math.random() * Math.min(lista.length, 16))]; break; }
    }
    if (!id) throw new Error(`sin clips para la escena ${i + 1}`);
    hoy.add(id);
    elegidos.push(id);
    log(`toma ${n + 1} (escena ${i + 1}): "${e.busqueda}" → clip ${id}`);
  }
  return elegidos;
}

/** Baja solo los segundos que se usan (1080p, o 720p si no hay) y recorta a vertical. */
function bajarClip(id, dur, out) {
  const vf = `setpts=PTS/${VELOCIDAD},crop='min(iw,ih*${W}/${H})':'min(ih,iw*${H}/${W})':'(iw-min(iw,ih*${W}/${H}))/2':'(ih-min(ih,iw*${H}/${W}))/2',scale=${W}:${H}:flags=lanczos,fps=30,eq=contrast=1.08:saturation=0.95:brightness=-0.02,setsar=1`;
  for (const q of ["1080", "720", "2160"]) {
    try {
      ff(["-ss", "1", "-t", (dur * VELOCIDAD).toFixed(3), "-i", `https://assets.mixkit.co/videos/${id}/${id}-${q}.mp4`, "-vf", vf, "-an", "-c:v", "libx264", "-crf", "17", "-preset", "veryfast", "-pix_fmt", "yuv420p", out]);
      if (fs.existsSync(out)) return;
    } catch {}
  }
  throw new Error(`no se pudo bajar el clip ${id}`);
}

function armarBase(ids, trabajo, FX) {
  const T = CORTES, d = XFADE;
  const partes = ids.map((id, i) => {
    const ini = i === 0 ? 0 : T[i] - d / 2;
    const fin = i === ids.length - 1 ? T[T.length - 1] : T[i + 1] + d / 2;
    const out = path.join(trabajo, `clip${i}.mp4`);
    bajarClip(id, +(fin - ini).toFixed(3), out);
    return out;
  });
  let f = "", prev = "[0:v]";
  for (let i = 0; i < partes.length - 1; i++) {
    const lab = i === partes.length - 2 ? "[v]" : `[x${i}]`;
    f += `${prev}[${i + 1}:v]xfade=transition=${FX[i % FX.length]}:duration=${d}:offset=${(T[i + 1] - d / 2).toFixed(3)}${lab};`;
    prev = lab;
  }
  const base = path.join(trabajo, "assets", "base.mp4");
  ff([...partes.flatMap((p) => ["-i", p]), "-filter_complex", f.slice(0, -1), "-map", "[v]", "-t", String(T[T.length - 1]), "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p", "-movflags", "+faststart", base]);
  return partes;
}

function renderReel(trabajo, salida, estilo) {
  const vars = { estilo: JSON.stringify(estilo), cta: plan.cierre || "¿Lo quieres para tu negocio?" };
  plan.escenas.forEach((e, i) => { vars[`k${i + 1}`] = String(e.etiqueta || "").toUpperCase(); vars[`t${i + 1}`] = e.texto; });
  fs.writeFileSync(path.join(trabajo, "vars.json"), JSON.stringify(vars));
  const crudo = path.join(trabajo, "render.mp4");
  const args = ["render", "--variables-file", "vars.json", "--output", "render.mp4", "--fps", "30"];
  const local = hfLocal();
  if (local) execFileSync(process.execPath, [local, ...args], { cwd: trabajo, stdio: "ignore", timeout: 40 * 60_000 });
  else execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["--yes", CLI, ...args], { cwd: trabajo, stdio: "ignore", timeout: 40 * 60_000, shell: process.platform === "win32" });
  if (!fs.existsSync(crudo)) throw new Error("HyperFrames no produjo el video");
  // Calidad para Instagram, pero que pase por WhatsApp (< 16 MB)
  ff(["-i", crudo, "-c:v", "libx264", "-preset", "slow", "-crf", "21", "-maxrate", "6M", "-bufsize", "12M", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", salida], 10 * 60_000);
}

const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** HTML de una diapositiva del carrusel (1080×1350), con el estilo del día. */
function htmlSlide({ i, total, titulo, texto, foto, assets, E }) {
  const portada = i === 0, cierre = i === total - 1;
  const L = String(titulo).length;
  const tam = Math.round((portada ? (L <= 18 ? 130 : L <= 30 ? 108 : 90) : (L <= 18 ? 96 : L <= 30 ? 82 : 70)) * Math.min(E.escala || 1, 1.4));
  const centro = E.pos === "centro";
  const sombraPortada = { toda: "rgba(7,10,18,.55)", arriba: "linear-gradient(180deg, rgba(7,10,18,.9) 0%, rgba(7,10,18,.35) 60%, rgba(7,10,18,.2) 100%)", ninguna: "rgba(7,10,18,.15)" }[E.sombra]
    || "linear-gradient(180deg, rgba(7,10,18,.35) 0%, rgba(7,10,18,.1) 35%, rgba(7,10,18,.9) 100%)";
  const sombra = portada ? sombraPortada : E.caja ? "rgba(7,10,18,.3)" : "rgba(7,10,18,.66)";
  const posCaja = portada ? (E.pos === "arriba" ? "top: 220px" : centro ? "top: 420px; text-align: center" : "bottom: 170px")
    : cierre ? "top: 330px; text-align: center" : centro ? "top: 400px; text-align: center" : "top: 430px";
  const palabras = String(titulo).trim().split(/\s+/);
  const h1 = palabras.map((p, j) => `<span class="w${j === palabras.length - 1 ? " hl" : ""}">${esc(p)}</span>`).join(" ");
  const pesado = E.calma ? "font-weight: 500;" : E.font === "Outfit" || E.font === "Oswald" ? "font-weight: 700;" : "";
  const brillo = E.brillo && !cierre ? `text-shadow: 0 0 30px ${E.hl}, 0 0 60px ${E.hl};` : "";
  const cajitas = E.caja && !cierre
    ? `h1 .w { display: inline-block; background: #fff; color: #111; padding: 0 16px 6px; margin: 0 4px 10px 0; border-radius: 8px; }
       h1 .w.hl { background: ${E.hl}; color: #fff; }
       p { display: inline; background: #fff; color: #111; padding: 6px 14px; line-height: 1.6; -webkit-box-decoration-break: clone; box-decoration-break: clone; }`
    : "";
  const etiqueta = cierre ? `<img class="logo" src="${assets}/logo.png">` : portada || !/tips/i.test(plan.formato || "") ? "" : `<div class="k">TIP ${i}</div>`;
  const fondo = cierre ? `<div class="cierre"></div>` : `<img class="foto" src="${foto}"><div class="sombra"></div>`;
  const arriba = cierre ? "" : `<div class="marca"><img src="${assets}/logo-simbolo.png">@ssss.olutions</div><div class="num">${String(i + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: "Archivo Black"; src: url("${assets}/fonts/ArchivoBlack-Regular.ttf"); }
@font-face { font-family: "League Gothic"; src: url("${assets}/fonts/LeagueGothic.ttf"); }
@font-face { font-family: "Oswald"; src: url("${assets}/fonts/Oswald.ttf"); font-weight: 200 700; }
@font-face { font-family: "Outfit"; src: url("${assets}/fonts/Outfit.ttf"); font-weight: 100 900; }
@font-face { font-family: "Playfair Display"; src: url("${assets}/fonts/PlayfairDisplay-Italic.ttf"); font-style: italic; font-weight: 400 900; }
@font-face { font-family: "Inter"; src: url("${assets}/fonts/Inter.ttf"); font-weight: 100 900; }
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 1080px; height: 1350px; overflow: hidden; background: #070a12; color: #fff; font-family: "Inter", sans-serif; }
.foto { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.sombra { position: absolute; inset: 0; background: ${sombra}; }
.cierre { position: absolute; inset: 0; background: ${E.fin}; }
.marca { position: absolute; left: 80px; top: 76px; display: flex; align-items: center; gap: 20px; font-weight: 800; font-size: 32px; }
.marca img { width: 74px; }
.num { position: absolute; right: 80px; top: 92px; font-weight: 900; font-size: 30px; letter-spacing: .12em; opacity: .85; }
.caja { position: absolute; left: 80px; right: 80px; ${posCaja}; color: ${cierre ? E.finInk : "#fff"}; }
.k { display: inline-block; background: ${E.chip}; color: ${E.chipInk}; font-weight: 800; font-size: 30px; letter-spacing: .16em; padding: 10px 20px; border-radius: 10px; margin-bottom: 34px; }
h1 { font-family: "${E.font}", sans-serif; font-size: ${tam}px; letter-spacing: ${E.mayus ? "0" : "-0.03em"}; line-height: ${E.caja ? 1.25 : E.mayus ? 0.95 : 1.04};
     ${E.mayus ? "text-transform: uppercase;" : ""} ${E.font === "Playfair Display" ? "font-style: italic;" : ""} ${pesado} }
h1 .hl { color: ${cierre ? "inherit" : E.hl}; ${brillo} }
.texto { margin-top: 36px; }
p { font-size: 46px; font-weight: 600; line-height: 1.28; opacity: .95; }
${cajitas}
.cta { display: inline-block; margin-top: 60px; background: ${E.cta}; color: ${E.ctaInk}; border-radius: 999px; font-size: 50px; font-weight: 900; padding: 30px 56px; }
.logo { width: 420px; display: block; margin: 0 auto 70px; ${E.oscuro ? "filter: brightness(0);" : ""} }
.desliza { position: absolute; right: 80px; bottom: 80px; font-weight: 800; font-size: 34px; background: ${E.chip}; color: ${E.chipInk}; padding: 12px 24px; border-radius: 999px; }
${E.etiqueta === "texto" ? ".k { background: none; color: #fff; padding: 0; opacity: .8; font-weight: 600; letter-spacing: .32em; } .desliza { background: none; color: #fff; padding: 0; font-weight: 500; letter-spacing: .12em; opacity: .85; }" : ""}
${E.calma ? "p { font-weight: 400; } .cta { font-weight: 700; font-size: 44px; } .marca { font-weight: 600; }" : ""}
</style></head><body>
${fondo}
${arriba}
<div class="caja">
${etiqueta}
<h1>${h1}</h1>
${texto ? `<div class="texto"><p>${esc(texto)}</p></div>` : ""}
${cierre ? `<div class="cta">WhatsApp 871 916 4677</div>` : ""}
</div>
${portada ? `<div class="desliza">Desliza →</div>` : ""}
</body></html>`;
}

function renderCarrusel(partes, trabajo, exe, E) {
  const assets = pathToFileURL(path.join(PLANTILLA, "assets")).href;
  const total = plan.carrusel.length;
  const salidas = [];
  for (const [i, s] of plan.carrusel.entries()) {
    // Foto de la toma correspondiente (cuadro a mitad del clip)
    const foto = path.join(trabajo, `foto${i}.jpg`);
    if (i < total - 1) ff(["-ss", "0.8", "-i", partes[(i * TOMAS_POR_ESCENA) % partes.length], "-frames:v", "1", "-q:v", "2", foto]);
    const html = path.join(trabajo, `slide${i}.html`);
    fs.writeFileSync(html, htmlSlide({ i, total, titulo: s.titulo, texto: s.texto, foto: pathToFileURL(foto).href, assets, E }));
    const png = `slide-${i + 1}.png`;
    execFileSync(exe, ["--headless", "--disable-gpu", "--hide-scrollbars", "--allow-file-access-from-files", "--window-size=1080,1350", "--force-device-scale-factor=1",
      "--virtual-time-budget=4000", `--screenshot=${path.join(dir, png)}`, pathToFileURL(html).href], { stdio: "ignore", timeout: 120_000 });
    if (!fs.existsSync(path.join(dir, png))) throw new Error(`no se pudo hacer la imagen ${i + 1}`);
    salidas.push(png);
  }
  return salidas;
}

async function main() {
  const trabajo = path.join(dir, "trabajo");
  fs.rmSync(trabajo, { recursive: true, force: true });
  fs.rmSync(path.join(dir, "fallo.txt"), { force: true });
  try {
    const exe = chrome();
    if (!exe) throw new Error("No encontré el Chrome de HyperFrames (corre: npx hyperframes doctor)");
    // Copia de la plantilla para trabajar sin tocar la original
    fs.cpSync(PLANTILLA, trabajo, { recursive: true, filter: (s) => !/[\\/](renders|\.hyperframes|node_modules)([\\/]|$)/.test(s) });
    const t0 = Date.now();
    const estilo = elegirEstilo();
    log("estilo: " + estilo.id);
    if (estilo.calma) VELOCIDAD = 1.1;
    const ids = await elegirClips();
    const musica = await elegirMusica(trabajo, estilo.generos || GENEROS);
    const partes = armarBase(ids, trabajo, estilo.fx);
    log(`base lista en ${Math.round((Date.now() - t0) / 1000)} s`);
    const slides = renderCarrusel(partes, trabajo, exe, estilo);
    log(`carrusel listo (${slides.length} imágenes)`);
    renderReel(trabajo, path.join(dir, "reel.mp4"), estilo);
    log(`reel listo en ${Math.round((Date.now() - t0) / 1000)} s`);
    fs.writeFileSync(path.join(dir, "listo.json"), JSON.stringify({ reel: "reel.mp4", slides, clips: ids, estilo: estilo.id, musica }, null, 2));
  } catch (e) {
    fs.writeFileSync(path.join(dir, "fallo.txt"), String(e.stack || e.message));
    log("falló:", e.message);
    process.exitCode = 1;
  } finally {
    fs.rmSync(trabajo, { recursive: true, force: true });
  }
}

main();
