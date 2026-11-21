// Arma el video base de un proyecto con clips REALES de Mixkit (licencia libre: https://mixkit.co/license/#videoFree),
// cortados a ritmo de la música y unidos con transiciones de ffmpeg (xfade). Encima, HyperFrames pone el texto.
//
// Uso:  node videos/base-clips.mjs videos/dental/clips.json
// clips.json: { "salida": "assets/base.mp4", "w": 1080, "h": 1920, "cortes": [0, 2.6, …, 16],
//               "xfade": 0.45, "clips": [{ "id": 12141, "desde": 1.5, "x": 0.6, "fx": "zoomin" }, …] }
//   x: dónde centrar el recorte (0 = izquierda, 1 = derecha); fx: transición HACIA el siguiente clip.
// Solo baja los segundos que usa de cada clip (en 4K si existe), así que funciona con internet lento.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const FFMPEG = [path.join(os.homedir(), ".local", "bin", "ffmpeg.exe"), "ffmpeg"].find((p) => p === "ffmpeg" || fs.existsSync(p));
const cfgPath = path.resolve(process.argv[2] || "");
if (!fs.existsSync(cfgPath)) { console.error("Uso: node videos/base-clips.mjs <proyecto>/clips.json"); process.exit(1); }
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const dir = path.dirname(cfgPath);
const tmp = path.join(dir, ".clips");
fs.mkdirSync(tmp, { recursive: true });
const { w, h, cortes: T, clips } = cfg;
const d = cfg.xfade ?? 0.45;
const ff = (args) => execFileSync(FFMPEG, ["-v", "error", "-y", ...args], { stdio: ["ignore", "inherit", "inherit"] });

// Cada transición queda centrada en su corte: el clip i se ve de inicio[i] a fin[i]
const inicio = clips.map((_, i) => (i === 0 ? 0 : T[i] - d / 2));
const fin = clips.map((_, i) => (i === clips.length - 1 ? T[T.length - 1] : T[i + 1] + d / 2));

const partes = clips.map((c, i) => {
  const dur = +(fin[i] - inicio[i]).toFixed(3);
  const out = path.join(tmp, `c${i}-${c.id}-${c.desde}-${c.x}-${dur}.mp4`);
  if (!fs.existsSync(out)) {
    // Recorte al formato de salida centrado en x, escalado, 30 fps y un grado de color de cine (contraste + menos saturación)
    const vf = `crop='min(iw,ih*${w}/${h})':'min(ih,iw*${h}/${w})':'(iw-min(iw,ih*${w}/${h}))*${c.x ?? 0.5}':'(ih-min(ih,iw*${h}/${w}))/2',scale=${w}:${h}:flags=lanczos,fps=30,eq=contrast=1.08:saturation=0.92:brightness=-0.02,setsar=1`;
    let ok = false;
    for (const q of ["2160", "1080", "720"]) {
      try {
        ff(["-ss", String(c.desde ?? 1), "-t", String(dur), "-i", `https://assets.mixkit.co/videos/${c.id}/${c.id}-${q}.mp4`, "-vf", vf, "-an", "-c:v", "libx264", "-crf", "16", "-preset", "veryfast", "-pix_fmt", "yuv420p", out]);
        ok = true;
        break;
      } catch {}
    }
    if (!ok) throw new Error(`No se pudo bajar el clip ${c.id}`);
    console.log(`clip ${i + 1}/${clips.length} · ${c.id} · ${dur}s`);
  }
  return out;
});

// Cadena de xfade: cada offset es el momento (en la salida) donde arranca la transición
const inputs = partes.flatMap((p) => ["-i", p]);
let f = "", prev = "[0:v]";
for (let i = 0; i < partes.length - 1; i++) {
  const lab = i === partes.length - 2 ? "[v]" : `[x${i}]`;
  f += `${prev}[${i + 1}:v]xfade=transition=${clips[i].fx || "fade"}:duration=${d}:offset=${(T[i + 1] - d / 2).toFixed(3)}${lab};`;
  prev = lab;
}
const salida = path.join(dir, cfg.salida || "assets/base.mp4");
fs.mkdirSync(path.dirname(salida), { recursive: true });
ff([...inputs, "-filter_complex", f.slice(0, -1), "-map", "[v]", "-t", String(T[T.length - 1]), "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p", "-movflags", "+faststart", salida]);
console.log(`listo: ${path.relative(process.cwd(), salida)}`);
