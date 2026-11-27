import fs from "node:fs";
import { mascota } from "./mascota.mjs";
import { createRequire } from "node:module"; const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const out = ".";
for (const d of ["poses","bocas","perfil","animacion/frames"]) fs.mkdirSync(`${out}/${d}`,{recursive:true});
const b = await chromium.launch(); const p = await b.newPage({viewport:{width:1000,height:1000}});
const png = async (svg, file) => { await p.setContent(`<body style="margin:0;background:transparent">${svg}</body>`); await p.screenshot({path:file, omitBackground:true, clip:{x:0,y:0,width:1000,height:1000}}); };
// Poses y expresiones (fondo transparente)
const poses = { normal:{}, saluda:{pose:"saluda",exp:"feliz"}, apunta:{pose:"apunta",exp:"guino",ladeo:-6}, festeja:{pose:"festeja",exp:"wow",boca:"a"}, piensa:{exp:"piensa",boca:"plano",ladeo:5}, feliz:{exp:"feliz"} };
for (const [n,v] of Object.entries(poses)) await png(mascota(v), `${out}/poses/sebi-${n}.png`);
// Bocas para que "hable" (misma pose, solo cambia la boca) + parpadeo
for (const m of ["sonrisa","plano","e","a","o"]) await png(mascota({boca:m}), `${out}/bocas/boca-${m}.png`);
await png(mascota({parpadeo:1}), `${out}/bocas/parpadeo.png`);
// Foto de perfil
await png(mascota({exp:"feliz",pose:"saluda",fondo:"circulo"}), `${out}/perfil/perfil-tiktok.png`);
await png(mascota({fondo:"negro"}), `${out}/perfil/perfil-normal.png`);
// Animación 5 s a 30 fps: flota, parpadea, habla y saluda
const fps=30, N=150, seq="sonrisa e a o a e plano a o e a sonrisa sonrisa".split(" ");
for (let i=0;i<N;i++){
  const t=i/fps; const y=Math.sin(t*2*Math.PI/2)*10;
  const parp = [1.2,3.6].some(x=>Math.abs(t-x)<0.07)?1:[1.2,3.6].some(x=>Math.abs(t-x)<0.12)?0.6:0;
  const habla = t>0.4 && t<3.2; const boca = habla ? seq[Math.floor(t*8)%seq.length] : "sonrisa";
  const saluda = t>=3.2; const exp = saluda ? "feliz" : "normal";
  const svg = mascota({exp, boca, pose:saluda?"saluda":"normal", parpadeo: saluda?0:parp, ladeo: saluda? Math.sin(t*6)*4 : Math.sin(t*1.5)*2})
    .replace('<g filter="url(#suave)">', `<g filter="url(#suave)" transform="translate(0 ${y.toFixed(1)})">`);
  await png(svg, `${out}/animacion/frames/f${String(i).padStart(3,"0")}.png`);
}
await b.close();
