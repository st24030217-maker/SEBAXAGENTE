// Genera la mascota de sss.solutions ("Sebi") como SVG, con expresiones, bocas y poses.
import fs from "node:fs";
import path from "node:path";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const logo = "data:image/png;base64," + fs.readFileSync(path.join(DIR, "logo-simbolo.png")).toString("base64");

const AZUL = "#2f7cf6";
const AZUL_CLARO = "#8fc0ff";
const VERDE = "#25d366";

// Ojos sobre la pantalla (centro de la cara: 500, 390)
function ojos(exp, parpadeo = 0) {
  const L = 420, R = 580, Y = 382;
  const h = Math.max(6, 58 * (1 - parpadeo));
  const capsula = (x) => `<rect x="${x - 23}" y="${Y - h / 2}" width="46" height="${h}" rx="${Math.min(23, h / 2)}" fill="url(#ojo)" filter="url(#glow)"/>`;
  const feliz = (x) => `<path d="M${x - 28} ${Y + 10} Q${x} ${Y - 30} ${x + 28} ${Y + 10}" stroke="url(#ojo)" stroke-width="16" stroke-linecap="round" fill="none" filter="url(#glow)"/>`;
  const estrella = (x) => {
    const p = [];
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 14 : 34, a = -Math.PI / 2 + (i * Math.PI) / 5;
      p.push(`${(x + r * Math.cos(a)).toFixed(1)},${(Y + r * Math.sin(a)).toFixed(1)}`);
    }
    return `<polygon points="${p.join(" ")}" fill="url(#ojo)" stroke="url(#ojo)" stroke-width="6" stroke-linejoin="round" filter="url(#glow)"/>`;
  };
  switch (exp) {
    case "feliz": return feliz(L) + feliz(R);
    case "guino": return capsula(L) + feliz(R);
    case "wow": return estrella(L) + estrella(R);
    case "piensa": return capsula(L).replace(`y="${Y - h / 2}"`, `y="${Y - h / 2 - 10}"`) + capsula(R).replace(`y="${Y - h / 2}"`, `y="${Y - h / 2 - 10}"`);
    default: return capsula(L) + capsula(R);
  }
}

// Bocas: cerrada (sonrisa), a (abierta), o (redonda), e (ancha)
function boca(tipo) {
  const Y = 452;
  switch (tipo) {
    case "a": return `<path d="M468 ${Y - 6} Q500 ${Y - 10} 532 ${Y - 6} Q528 ${Y + 34} 500 ${Y + 36} Q472 ${Y + 34} 468 ${Y - 6} Z" fill="#fff"/><path d="M482 ${Y + 20} Q500 ${Y + 12} 518 ${Y + 20} Q510 ${Y + 32} 500 ${Y + 32} Q490 ${Y + 32} 482 ${Y + 20}Z" fill="#ff6b8a" opacity=".9"/>`;
    case "o": return `<ellipse cx="500" cy="${Y + 10}" rx="17" ry="21" fill="#fff"/>`;
    case "e": return `<rect x="462" y="${Y - 2}" width="76" height="20" rx="10" fill="#fff"/>`;
    case "plano": return `<rect x="476" y="${Y + 2}" width="48" height="9" rx="4.5" fill="#fff"/>`;
    default: return `<path d="M470 ${Y} Q500 ${Y + 26} 530 ${Y}" stroke="#fff" stroke-width="10" stroke-linecap="round" fill="none"/>`;
  }
}

// Brazos según la pose. Hombros en (372, 690) y (628, 690).
function brazos(pose) {
  const brazo = (x, y, ang, largo = 150) =>
    `<g transform="translate(${x} ${y}) rotate(${ang})">
       <rect x="-27" y="0" width="54" height="${largo}" rx="27" fill="url(#cuerpo)" stroke="#d9dde3" stroke-width="2"/>
       <rect x="-29" y="${largo - 30}" width="58" height="14" rx="7" fill="${AZUL}"/>
       <circle cx="0" cy="${largo + 10}" r="36" fill="url(#cuerpo)" stroke="#d9dde3" stroke-width="2"/>
       <circle cx="-11" cy="${largo}" r="10" fill="#ffffff"/>
     </g>`;
  switch (pose) {
    case "saluda": return brazo(372, 690, 22) + brazo(636, 676, -128, 165);
    case "apunta": return brazo(372, 690, 22) + brazo(636, 676, -112, 175);
    case "festeja": return brazo(364, 676, 128, 165) + brazo(636, 676, -128, 165);
    default: return brazo(372, 690, 22) + brazo(628, 690, -22);
  }
}

export function mascota({ exp = "normal", boca: b = "sonrisa", pose = "normal", parpadeo = 0, fondo = null, ladeo = 0 } = {}) {
  const fondoSvg = fondo === "circulo"
    ? `<rect width="1000" height="1000" fill="#0b0b0c"/><circle cx="500" cy="560" r="420" fill="url(#halo)"/>`
    : fondo === "negro" ? `<rect width="1000" height="1000" fill="#0b0b0c"/><circle cx="500" cy="520" r="460" fill="url(#halo)"/>`
    : fondo === "blanco" ? `<rect width="1000" height="1000" fill="#f4f5f7"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" width="1000" height="1000">
  <defs>
    <linearGradient id="casco" x1="0" y1="0" x2="0.25" y2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset=".55" stop-color="#eef0f3"/><stop offset="1" stop-color="#c9ced6"/>
    </linearGradient>
    <linearGradient id="cuerpo" x1="0" y1="0" x2="0.3" y2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#cfd4db"/>
    </linearGradient>
    <linearGradient id="pantalla" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1c1e22"/><stop offset="1" stop-color="#050506"/>
    </linearGradient>
    <linearGradient id="ojo" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${AZUL_CLARO}"/><stop offset="1" stop-color="${AZUL}"/>
    </linearGradient>
    <radialGradient id="halo" cx=".5" cy=".5" r=".5">
      <stop offset="0" stop-color="${AZUL}" stop-opacity=".45"/><stop offset=".6" stop-color="${AZUL}" stop-opacity=".12"/><stop offset="1" stop-color="${AZUL}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="sombra" cx=".5" cy=".5" r=".5">
      <stop offset="0" stop-color="#000" stop-opacity=".35"/><stop offset="1" stop-color="#000" stop-opacity="0"/>
    </radialGradient>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="7" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="suave" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#000" flood-opacity=".28"/>
    </filter>
  </defs>
  ${fondoSvg}
  <ellipse cx="500" cy="960" rx="210" ry="26" fill="url(#sombra)"/>
  <g filter="url(#suave)">
    ${brazos(pose)}
    <!-- cuerpo -->
    <path d="M360 660 Q360 620 400 616 L600 616 Q640 620 640 660 L652 880 Q652 935 600 938 L400 938 Q348 935 348 880 Z" fill="url(#cuerpo)" stroke="#d9dde3" stroke-width="2"/>
    <rect x="420" y="690" width="160" height="160" rx="40" fill="#0f1012"/>
    <image href="${logo}" x="440" y="710" width="120" height="120" preserveAspectRatio="xMidYMid meet"/>
    <circle cx="610" cy="660" r="8" fill="${VERDE}" filter="url(#glow)"/>
    <!-- cuello -->
    <rect x="455" y="585" width="90" height="45" rx="18" fill="#2a2c31"/>
    <g transform="rotate(${ladeo} 500 400)">
      <!-- antena -->
      <rect x="492" y="120" width="16" height="80" rx="8" fill="#2a2c31"/>
      <circle cx="500" cy="112" r="24" fill="${VERDE}" filter="url(#glow)"/>
      <circle cx="492" cy="104" r="7" fill="#fff" opacity=".7"/>
      <!-- orejas -->
      <rect x="196" y="320" width="70" height="150" rx="35" fill="#16171a"/>
      <rect x="734" y="320" width="70" height="150" rx="35" fill="#16171a"/>
      <rect x="214" y="360" width="20" height="70" rx="10" fill="${AZUL}" filter="url(#glow)"/>
      <rect x="766" y="360" width="20" height="70" rx="10" fill="${AZUL}" filter="url(#glow)"/>
      <!-- cabeza -->
      <rect x="236" y="190" width="528" height="410" rx="170" fill="url(#casco)" stroke="#d9dde3" stroke-width="2"/>
      <path d="M300 250 Q360 205 470 205" stroke="#fff" stroke-width="22" stroke-linecap="round" fill="none" opacity=".9"/>
      <!-- pantalla -->
      <rect x="290" y="262" width="420" height="282" rx="120" fill="url(#pantalla)"/>
      <path d="M340 300 Q420 272 520 278" stroke="#ffffff" stroke-width="12" stroke-linecap="round" fill="none" opacity=".12"/>
      ${ojos(exp, parpadeo)}
      ${boca(b)}
      <!-- cachetes -->
      <ellipse cx="360" cy="460" rx="26" ry="14" fill="${AZUL}" opacity=".35"/>
      <ellipse cx="640" cy="460" rx="26" ry="14" fill="${AZUL}" opacity=".35"/>
    </g>
  </g>
</svg>`;
}
