// Pista original para el video de sss.solutions (16 s). Genera assets/musica.wav.
// Tempo elegido para que cada compás (4 tiempos) dure 1.66 s = un servicio del video.
// Uso: node musica.mjs
import fs from "node:fs";

const SR = 44100, DUR = 16, N = SR * DUR;
const BEAT = 1.66 / 4;           // ~144.6 BPM
const DROP = 2.6;                // entra el ritmo cuando aparece el celular
const L = new Float32Array(N), R = new Float32Array(N);

// Semilla fija: el ruido siempre suena igual
let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
const hz = (m) => 440 * 2 ** ((m - 69) / 12);
const add = (i, v, pan = 0) => { if (i >= 0 && i < N) { L[i] += v * (1 - pan); R[i] += v * (1 + pan); } };

function kick(t, g = 1) {
  const s0 = Math.round(t * SR);
  let ph = 0;
  for (let k = 0; k < SR * 0.35; k++) {
    const x = k / SR, f = 50 + 120 * Math.exp(-x * 30);
    ph += (2 * Math.PI * f) / SR;
    add(s0 + k, Math.sin(ph) * Math.exp(-x * 9) * 0.9 * g);
  }
}
function clap(t, g = 1) {
  const s0 = Math.round(t * SR);
  let lp = 0;
  for (let k = 0; k < SR * 0.22; k++) {
    const x = k / SR, n = rnd();
    lp += 0.45 * (n - lp);
    const env = (x < 0.03 ? (Math.floor(x / 0.01) % 2 ? 0.6 : 1) : 1) * Math.exp(-x * 18);
    add(s0 + k, (n - lp) * env * 0.5 * g, (k % 2 ? 0.15 : -0.15));
  }
}
function hat(t, g = 1, open = false) {
  const s0 = Math.round(t * SR);
  let prev = 0;
  for (let k = 0; k < SR * (open ? 0.18 : 0.05); k++) {
    const x = k / SR, n = rnd(), hp = n - prev; prev = n;
    add(s0 + k, hp * Math.exp(-x * (open ? 22 : 70)) * 0.22 * g, 0.3);
  }
}
// Saw suavizado con filtro pasa-bajos de un polo
function synth(t, dur, midi, g, cutoff, pan = 0, detune = 0.004) {
  const s0 = Math.round(t * SR), len = Math.round(dur * SR), f = hz(midi);
  let p1 = 0, p2 = 0, lp = 0;
  const a = 1 - Math.exp((-2 * Math.PI * cutoff) / SR);
  for (let k = 0; k < len + SR * 0.08; k++) {
    p1 = (p1 + (f * (1 + detune)) / SR) % 1; p2 = (p2 + (f * (1 - detune)) / SR) % 1;
    const raw = (2 * p1 - 1 + 2 * p2 - 1) * 0.5;
    lp += a * (raw - lp);
    const x = k / SR, rel = k > len ? Math.exp(-(k - len) / SR * 40) : 1;
    add(s0 + k, lp * Math.min(1, x * 200) * rel * g, pan);
  }
}
function bass(t, dur, midi, g = 1) {
  const s0 = Math.round(t * SR), len = Math.round(dur * SR), f = hz(midi);
  let ph = 0;
  for (let k = 0; k < len; k++) {
    ph += (2 * Math.PI * f) / SR;
    const x = k / SR, env = Math.min(1, x * 300) * Math.exp(-x * 4) * (k > len - 200 ? (len - k) / 200 : 1);
    add(s0 + k, (Math.sin(ph) + 0.3 * Math.sin(2 * ph)) * env * 0.42 * g);
  }
}
function riser(t0, t1) {
  let lp = 0;
  for (let i = Math.round(t0 * SR); i < Math.round(t1 * SR); i++) {
    const p = (i / SR - t0) / (t1 - t0), n = rnd();
    lp += (0.02 + p * 0.5) * (n - lp);
    add(i, lp * p * p * 0.35, Math.sin(i / 4000) * 0.4);
  }
}
function impact(t) {
  kick(t, 1.3);
  let lp = 0;
  for (let k = 0; k < SR * 1.2; k++) { const n = rnd(); lp += 0.08 * (n - lp); add(Math.round(t * SR) + k, lp * Math.exp(-k / SR * 3) * 0.5); }
}

// La menor: Am – F – C – G, un acorde por compás
const PROG = [[57, 60, 64, 45], [53, 57, 60, 41], [60, 64, 67, 48], [55, 59, 62, 43]];

// Intro (0 – 2.6 s): acordes filtrados que se van abriendo + subida
for (let b = 0; b < 2; b++) {
  const t = b * 1.66 - 0.72, ch = PROG[(b + 2) % 4];
  if (t + 1.66 < 0) continue;
  ch.slice(0, 3).forEach((m, j) => synth(Math.max(0, t), 1.6, m, 0.07, 500 + b * 700, (j - 1) * 0.4));
}
for (let k = 0; k < 6; k++) hat(0.2 + k * BEAT, 0.5);
riser(1.2, DROP);

// Cuerpo (2.6 – 13.6 s): ritmo completo
impact(DROP);
for (let t = DROP, bar = 0; t < 13.6 - 0.01; t += 1.66, bar++) {
  const ch = PROG[bar % 4];
  for (let b = 0; b < 4; b++) {
    const tb = t + b * BEAT;
    if (tb >= 13.6) break;
    if (!(bar === 0 && b === 0)) kick(tb);
    if (b % 2 === 1) clap(tb);
    hat(tb + BEAT / 2, 1, b === 3);
    hat(tb + BEAT / 4, 0.4);
    // Bajo en corcheas
    bass(tb, BEAT / 2 - 0.01, ch[3]);
    bass(tb + BEAT / 2, BEAT / 2 - 0.01, ch[3] + (b === 3 ? 12 : 0), 0.8);
    // Acordes cortados (stabs) en contratiempo
    ch.slice(0, 3).forEach((m, j) => synth(tb + BEAT / 2, BEAT * 0.35, m + 12, 0.055, 3200, (j - 1) * 0.5));
  }
  // Melodía: arpegio en semicorcheas al final de cada compás
  [0, 1, 2, 1].forEach((j, k) => synth(t + 3 * BEAT + (k * BEAT) / 4, BEAT / 4, ch[j] + 24, 0.045, 5000, 0.2));
}
// Corte de energía antes de La Laguna y del cierre
riser(10.4, 11.1);
riser(12.9, 13.6);
impact(11.1);

// Cierre (13.6 – 16 s): golpe final y acorde que se sostiene
impact(13.6);
for (let b = 0; b < 4; b++) { kick(13.6 + b * BEAT * 1, b ? 0.8 : 0); if (b % 2) clap(13.6 + b * BEAT, 0.8); hat(13.6 + b * BEAT + BEAT / 2, 0.8); }
[57, 60, 64, 69].forEach((m, j) => synth(13.6 + 4 * BEAT, 0.9, m, 0.06, 2400, (j - 1.5) * 0.4));
bass(13.6 + 4 * BEAT, 0.9, 45);

// Mezcla: fade-in corto, fade-out al final, compresión suave y normalizado
let peak = 0;
for (let i = 0; i < N; i++) {
  const t = i / SR, fade = Math.min(1, t / 0.15) * Math.min(1, (DUR - t) / 0.6);
  L[i] = Math.tanh(L[i] * 1.4) * fade; R[i] = Math.tanh(R[i] * 1.4) * fade;
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const gain = 0.89 / peak;
const buf = Buffer.alloc(44 + N * 4);
buf.write("RIFF", 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write("WAVEfmt ", 8);
buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) { buf.writeInt16LE(Math.round(L[i] * gain * 32767), 44 + i * 4); buf.writeInt16LE(Math.round(R[i] * gain * 32767), 46 + i * 4); }
fs.mkdirSync("assets", { recursive: true });
fs.writeFileSync("assets/musica.wav", buf);
console.log("assets/musica.wav listo");
