// Segunda pista original para el video web (20 s), en Re mayor. Genera assets/musica-b.wav.
// Tempo elegido para que cada compás (4 tiempos) dure 1.66 s = un servicio del video.
// Uso: node musica.mjs
import fs from "node:fs";

const SR = 44100, DUR = 20, N = SR * DUR;
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

// Re mayor, más luminoso: D – A – Bm – G, un acorde por compás
const PROG = [[62, 66, 69, 38], [61, 64, 69, 45], [62, 66, 71, 47], [62, 67, 71, 43]];

// Cuerda punteada (Karplus-Strong): suena a marimba/guitarra, nada que ver con los sintes de antes
function pluck(t, midi, g = 1, pan = 0, dec = 0.996) {
  const f = hz(midi), P = Math.max(2, Math.round(SR / f)), buf = new Float32Array(P);
  for (let k = 0; k < P; k++) buf[k] = rnd();
  const s0 = Math.round(t * SR);
  let idx = 0;
  for (let k = 0; k < SR * 0.9; k++) {
    const a = buf[idx], b = buf[(idx + 1) % P];
    buf[idx] = (a + b) * 0.5 * dec;
    add(s0 + k, a * 0.32 * g, pan);
    idx = (idx + 1) % P;
  }
}
// Campana (FM simple) para la melodía
function bell(t, midi, g = 1, pan = 0) {
  const s0 = Math.round(t * SR), f = hz(midi);
  for (let k = 0; k < SR * 1.1; k++) {
    const x = k / SR, m = Math.sin(2 * Math.PI * f * 3.5 * x) * 2.2 * Math.exp(-x * 6);
    add(s0 + k, Math.sin(2 * Math.PI * f * x + m) * Math.exp(-x * 4.5) * 0.11 * g, pan);
  }
}
// Colchón que "respira" con el bombo (bombeo tipo sidechain)
function pad(t, dur, notas, g = 1) {
  const s0 = Math.round(t * SR), len = Math.round(dur * SR);
  const fs_ = notas.map(hz); const ph = notas.map(() => 0);
  for (let k = 0; k < len; k++) {
    const x = k / SR, enBeat = ((t + x) % BEAT) / BEAT, bomb = 0.35 + 0.65 * Math.min(1, enBeat * 2.5);
    let v = 0; fs_.forEach((f, j) => { ph[j] = (ph[j] + f / SR) % 1; v += Math.sin(2 * Math.PI * ph[j]) + 0.3 * Math.sin(4 * Math.PI * ph[j]); });
    const env = Math.min(1, x * 8) * Math.min(1, (len - k) / (SR * 0.1));
    add(s0 + k, v * 0.03 * env * bomb * g, Math.sin(x * 2) * 0.3);
  }
}

// Intro (0 – 2.6 s): punteos que suben + subida de ruido
[62, 66, 69, 74, 69, 66, 69, 74, 78, 74, 78, 81].forEach((m, k) => pluck(0.15 + k * BEAT / 2, m, 0.55 + k * 0.03, (k % 2 ? 0.35 : -0.35)));
pad(0, DROP, [50, 57, 62], 0.7);
riser(1.4, DROP);

// Cuerpo (2.6 – 15.88 s): cuatro al piso, hats abiertos en contratiempo, bajo y punteos
impact(DROP);
const MEL = [74, 76, 78, 81, 78, 76, 74, 73];
for (let t = DROP, bar = 0; t < 15.88 - 0.01; t += 1.66, bar++) {
  const ch = PROG[bar % 4];
  pad(t, 1.66, ch.slice(0, 3).map((m) => m - 12));
  for (let b = 0; b < 4; b++) {
    const tb = t + b * BEAT;
    if (tb >= 15.88) break;
    if (!(bar === 0 && b === 0)) kick(tb, 0.95);
    if (b % 2 === 1) clap(tb, 0.75);
    hat(tb + BEAT / 2, 1, true);
    // Bajo que salta de octava (más bailable)
    bass(tb + BEAT / 2, BEAT / 2 - 0.01, ch[3] + 12, 0.9);
    // Punteos en semicorcheas sobre el acorde
    [0, 2, 1, 2].forEach((j, k) => pluck(tb + (k * BEAT) / 4, ch[j] + 12, 0.42, k % 2 ? 0.3 : -0.3, 0.994));
  }
  // Melodía de campana: dos notas por compás
  bell(t, MEL[(bar * 2) % 8], 1, -0.2);
  bell(t + 2 * BEAT, MEL[(bar * 2 + 1) % 8], 0.85, 0.2);
}
// Golpes donde entra "Hechos en Torreón" y donde aparece el mapa
riser(10.2, 10.9);
impact(10.9);
riser(11.9, 12.56);
impact(12.56);

// Cierre (15.88 – 20 s): golpe y acorde de Re mayor que se queda sonando
impact(15.88);
for (let b = 0; b < 4; b++) { kick(15.88 + b * BEAT, b ? 0.8 : 0); if (b % 2) clap(15.88 + b * BEAT, 0.7); hat(15.88 + b * BEAT + BEAT / 2, 0.8, true); }
[62, 66, 69, 74].forEach((m, j) => pluck(15.88 + 4 * BEAT + j * 0.06, m, 0.8, (j - 1.5) * 0.3, 0.998));
pad(15.88 + 4 * BEAT, 2.4, [50, 57, 62, 66], 1.2);
bell(15.88 + 4 * BEAT, 86, 0.9);
bass(15.88 + 4 * BEAT, 2.4, 38);

// Mezcla: fade-in corto, fade-out al final, compresión suave y normalizado
let peak = 0;
for (let i = 0; i < N; i++) {
  const t = i / SR, fade = Math.min(1, t / 0.15) * Math.min(1, (DUR - t) / 1.2);
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
fs.writeFileSync("assets/musica-b.wav", buf);
console.log("assets/musica-b.wav listo");
