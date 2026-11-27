// Sebi en pixel art: sprite de 48×48 dibujado por código, escalado sin suavizado.
// Exporta poses PNG y animaciones fluidas (30 fps) con ffmpeg.
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const G = 48; // tamaño del sprite en "pixeles"
const PAL = {
  K: [11, 11, 14, 255],    // contorno
  W: [255, 255, 255, 255], // brillo
  L: [226, 230, 236, 255], // cuerpo
  M: [184, 191, 202, 255], // sombra
  N: [120, 128, 142, 255], // sombra fuerte
  D: [16, 17, 22, 255],    // pantalla
  S: [44, 48, 58, 255],    // reflejo pantalla
  B: [47, 124, 246, 255],  // azul
  b: [143, 192, 255, 255], // azul claro
  c: [28, 60, 120, 255],   // cachetes
  V: [37, 211, 102, 255],  // verde
  v: [170, 255, 205, 255], // verde claro
  P: [255, 107, 138, 255], // lengua
  s: [0, 0, 0, 70],        // sombra en el piso
};

function lienzo() {
  return Array.from({ length: G }, () => Array(G).fill(null));
}
const pon = (g, x, y, c) => { if (x >= 0 && y >= 0 && x < G && y < G) g[y][x] = c; };
function rect(g, x0, y0, x1, y1, c) { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) pon(g, x, y, c); }
// Rectángulo redondeado con sombreado: arriba brillo, abajo sombra.
function redondo(g, x0, y0, x1, y1, r, c, { brillo, sombra, sombra2 } = {}) {
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const dx = x < x0 + r ? x0 + r - x : x > x1 - r ? x - (x1 - r) : 0;
      const dy = y < y0 + r ? y0 + r - y : y > y1 - r ? y - (y1 - r) : 0;
      if (dx * dx + dy * dy > r * r + r * 0.6) continue;
      let col = c;
      if (sombra2 && y >= y1 - 1) col = sombra2;
      else if (sombra && (y >= y1 - 3 || x >= x1 - 1)) col = sombra;
      else if (brillo && y <= y0 + 1 && x > x0 + r - 1 && x < x0 + (x1 - x0) * 0.55) col = brillo;
      pon(g, x, y, col);
    }
}
// Línea gruesa (brazos)
function linea(g, xa, ya, xb, yb, grosor, c, sombra) {
  const n = Math.max(Math.abs(xb - xa), Math.abs(yb - ya)) * 2 || 1;
  for (let i = 0; i <= n; i++) {
    const x = xa + ((xb - xa) * i) / n, y = ya + ((yb - ya) * i) / n;
    for (let oy = -grosor; oy <= grosor; oy++)
      for (let ox = -grosor; ox <= grosor; ox++)
        if (ox * ox + oy * oy <= grosor * grosor + 0.5) pon(g, Math.round(x + ox), Math.round(y + oy), oy >= grosor - 0 && sombra ? sombra : c);
  }
}
// Contorno automático alrededor de todo lo dibujado
function contorno(g) {
  const out = g.map((r) => r.slice());
  for (let y = 0; y < G; y++)
    for (let x = 0; x < G; x++) {
      if (g[y][x]) continue;
      const vec = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => g[y + b]?.[x + a] && g[y + b][x + a] !== "s");
      if (vec) out[y][x] = "K";
    }
  return out;
}

function ojos(g, exp, parp, mira = 0) {
  const ex = [18 + mira, 29 + mira], y = 15;
  for (const x of ex) {
    if (parp >= 1) { rect(g, x - 1, y + 2, x + 1, y + 2, "B"); continue; }
    if (exp === "feliz") {
      pon(g, x - 1, y + 2, "B"); pon(g, x, y + 1, "b"); pon(g, x + 1, y + 1, "b"); pon(g, x + 2, y + 2, "B");
      continue;
    }
    if (exp === "wow") {
      rect(g, x, y, x + 1, y + 3, "b"); rect(g, x - 1, y + 1, x + 2, y + 2, "b"); pon(g, x, y + 1, "W");
      continue;
    }
    const alto = parp > 0 ? 2 : 4, y0 = y + (4 - alto) / 2;
    rect(g, x, y0, x + 1, y0 + alto - 1, "B");
    rect(g, x, y0, x + 1, y0, "b");
    if (alto === 4) pon(g, x, y0, "W");
  }
}
function boca(g, tipo) {
  const y = 21;
  switch (tipo) {
    case "a": rect(g, 22, y, 26, y + 2, "W"); rect(g, 23, y + 2, 25, y + 2, "P"); pon(g, 22, y + 2, "D"); pon(g, 26, y + 2, "D"); break;
    case "o": rect(g, 23, y, 25, y + 2, "W"); pon(g, 24, y + 1, "D"); break;
    case "e": rect(g, 21, y + 1, 27, y + 1, "W"); break;
    case "plano": rect(g, 22, y + 1, 26, y + 1, "W"); break;
    default: pon(g, 21, y, "W"); rect(g, 22, y + 1, 26, y + 1, "W"); pon(g, 27, y, "W");
  }
}

// Brazo derecho: ángulo en grados (0 = abajo, 180 = arriba). Izquierdo igual pero en espejo.
function brazo(g, lado, ang) {
  const arriba = ang >= 90;
  const hx = lado < 0 ? (arriba ? 13 : 14) : (arriba ? 34 : 33), hy = arriba ? 32 : 33;
  const r = (ang * Math.PI) / 180, largo = arriba ? 9 : 8;
  const mx = hx + lado * Math.sin(r) * largo, my = hy + Math.cos(r) * largo;
  linea(g, hx, hy, mx, my, 1, "L");
  const cx = Math.round(hx + lado * Math.sin(r) * (largo + 2)), cy = Math.round(hy + Math.cos(r) * (largo + 2));
  redondo(g, cx - 2, cy - 2, cx + 2, cy + 2, 2, "L", { sombra: "M" });
  // puño azul
  const px = Math.round(hx + lado * Math.sin(r) * (largo - 1)), py = Math.round(hy + Math.cos(r) * (largo - 1));
  pon(g, px, py, "B"); pon(g, px + 1, py, "B");
}

export function sprite({ exp = "normal", boca: bc = "sonrisa", brazoD = 20, brazoI = 20, parp = 0, mira = 0, luz = 0 } = {}) {
  const g = lienzo();
  // sombra en el piso
  for (let x = 15; x <= 32; x++) pon(g, x, 46, "s");
  for (let x = 18; x <= 29; x++) pon(g, x, 47, "s");
  // brazos (detrás del cuerpo)
  if (brazoI < 90) brazo(g, -1, brazoI);
  if (brazoD < 90) brazo(g, 1, brazoD);
  // cuerpo
  redondo(g, 15, 31, 32, 44, 4, "L", { brillo: "W", sombra: "M", sombra2: "N" });
  redondo(g, 19, 34, 28, 41, 2, "D");
  // "S" del logo en el pecho
  const S = ["WWW.", "W...", "WWW.", "..W.", "WWW."];
  S.forEach((f, yy) => [...f].forEach((ch, xx) => ch === "W" && pon(g, 22 + xx, 35 + yy, xx === 0 && yy === 0 ? "b" : "W")));
  pon(g, 30, 33, luz ? "v" : "V");
  // cuello
  rect(g, 21, 29, 26, 30, "N");
  // orejas
  redondo(g, 6, 13, 9, 22, 1, "D");
  redondo(g, 38, 13, 41, 22, 1, "D");
  rect(g, 7, 15, 7, 20, luz ? "b" : "B");
  rect(g, 40, 15, 40, 20, luz ? "b" : "B");
  // cabeza
  redondo(g, 9, 7, 38, 28, 7, "L", { brillo: "W", sombra: "M", sombra2: "N" });
  // pantalla
  redondo(g, 12, 10, 35, 25, 5, "D");
  rect(g, 16, 11, 24, 11, "S");
  rect(g, 14, 12, 15, 12, "S");
  // cachetes
  rect(g, 14, 20, 15, 20, "c");
  rect(g, 32, 20, 33, 20, "c");
  ojos(g, exp, parp, mira);
  boca(g, bc);
  if (brazoI >= 90) brazo(g, -1, brazoI);
  if (brazoD >= 90) brazo(g, 1, brazoD);
  // sin antena sobra espacio arriba: se sube todo 3 pixeles para que quede centrado
  for (let k = 0; k < 3; k++) { g.shift(); g.push(Array(G).fill(null)); }
  return contorno(g);
}

// ---- Render a RGBA ----
function rgba(spr, { escala, ancho, alto, ox, oy, fondo }) {
  const buf = Buffer.alloc(ancho * alto * 4);
  if (fondo) for (let i = 0; i < ancho * alto; i++) buf.set(fondo, i * 4);
  for (let y = 0; y < G; y++)
    for (let x = 0; x < G; x++) {
      const c = spr[y][x];
      if (!c) continue;
      const [r, g, b, a] = PAL[c];
      for (let yy = 0; yy < escala; yy++) {
        const py = Math.round(oy + y * escala + yy);
        if (py < 0 || py >= alto) continue;
        for (let xx = 0; xx < escala; xx++) {
          const px = Math.round(ox + x * escala + xx);
          if (px < 0 || px >= ancho) continue;
          const i = (py * ancho + px) * 4;
          const al = a / 255;
          buf[i] = Math.round(r * al + buf[i] * (1 - al));
          buf[i + 1] = Math.round(g * al + buf[i + 1] * (1 - al));
          buf[i + 2] = Math.round(b * al + buf[i + 2] * (1 - al));
          buf[i + 3] = Math.max(buf[i + 3], a);
        }
      }
    }
  return buf;
}
const FONDO = [11, 11, 14, 255];

function ffmpeg(args, input) {
  const r = spawnSync("ffmpeg", ["-loglevel", "error", "-y", ...args], { input, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(r.stderr.toString());
}
function png(spr, file, { fondo = null, tam = 960 } = {}) {
  const escala = Math.floor(tam / G);
  const buf = rgba(spr, { escala, ancho: tam, alto: tam, ox: (tam - G * escala) / 2, oy: (tam - G * escala) / 2, fondo });
  ffmpeg(["-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${tam}x${tam}`, "-i", "-", "-frames:v", "1", file], buf);
}

// ---- Animación: 6 s a 30 fps ----
// Flota suave (subpixel en pantalla), parpadea, mira a los lados, habla y saluda con el brazo fluido.
function cuadro(t) {
  const st = {};
  const habla = t > 0.6 && t < 3.4;
  const seq = ["e", "a", "o", "a", "e", "plano", "a", "o", "e", "a", "sonrisa", "a"];
  st.boca = habla ? seq[Math.floor(t * 10) % seq.length] : "sonrisa";
  st.parp = [1.0, 3.9, 5.4].some((x) => Math.abs(t - x) < 0.05) ? 1 : [1.0, 3.9, 5.4].some((x) => Math.abs(t - x) < 0.1) ? 0.5 : 0;
  st.mira = t > 2.2 && t < 2.9 ? 1 : 0;
  const saluda = t >= 3.4;
  st.exp = saluda ? "feliz" : "normal";
  st.brazoI = 20 + Math.sin(t * 2.4) * 4;
  st.brazoD = saluda ? 135 + Math.sin((t - 3.4) * 9) * 18 : 20 + Math.sin(t * 2.4 + 1) * 4;
  st.luz = Math.floor(t * 2) % 2;
  return st;
}
async function video(file, { ancho, alto, fondo, alfa }) {
  const fps = 30, N = fps * 6, escala = Math.floor(Math.min(ancho, alto) * 0.9 / G);
  const entrada = ["-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${ancho}x${alto}`, "-r", String(fps), "-i", "-"];
  const salida = alfa ? ["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "28"] : ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", "-movflags", "+faststart"];
  const ff = spawn("ffmpeg", ["-loglevel", "error", "-y", ...entrada, ...salida, file], { stdio: ["pipe", "inherit", "inherit"] });
  const fin = new Promise((ok, mal) => ff.on("close", (c) => (c === 0 ? ok() : mal(new Error("ffmpeg " + c)))));
  for (let i = 0; i < N; i++) {
    const t = i / fps;
    const flota = Math.sin((t * 2 * Math.PI) / 2) * escala * 0.9; // flotado suave
    const buf = rgba(sprite(cuadro(t)), { escala, ancho, alto, ox: (ancho - G * escala) / 2, oy: (alto - G * escala) / 2 + flota, fondo });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
  }
  ff.stdin.end();
  await fin;
}

// ---- Exportar todo ----
const out = process.argv[2] || "sebi-pixel";
for (const d of ["poses", "bocas", "perfil", "animacion"]) fs.mkdirSync(path.join(out, d), { recursive: true });
const poses = {
  normal: {},
  feliz: { exp: "feliz" },
  saluda: { exp: "feliz", brazoD: 135 },
  apunta: { brazoD: 115, mira: 1 },
  festeja: { exp: "wow", boca: "a", brazoD: 140, brazoI: 140 },
  piensa: { boca: "plano", mira: -1, brazoD: 115 },
};
for (const [n, p] of Object.entries(poses)) png(sprite(p), path.join(out, "poses", `sebi-${n}.png`));
for (const b of ["sonrisa", "plano", "e", "a", "o"]) png(sprite({ boca: b }), path.join(out, "bocas", `boca-${b}.png`));
png(sprite({ parp: 1 }), path.join(out, "bocas", "parpadeo.png"));
png(sprite({ exp: "feliz", brazoD: 135 }), path.join(out, "perfil", "perfil-tiktok.png"), { fondo: FONDO });
png(sprite({}), path.join(out, "perfil", "sprite-48px.png"), { tam: 48 });
await video(path.join(out, "animacion", "sebi-vertical.mp4"), { ancho: 1080, alto: 1920, fondo: FONDO });
await video(path.join(out, "animacion", "sebi-transparente.webm"), { ancho: 1080, alto: 1080, alfa: true });
console.log("listo", out);
