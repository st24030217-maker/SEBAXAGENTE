// Baja fotos reales (no IA) de Unsplash o Pexels para los videos.
// Requiere en .env una de estas (gratis):
//   UNSPLASH_ACCESS_KEY  → https://unsplash.com/developers (New Application → Access Key)
//   PEXELS_API_KEY       → https://www.pexels.com/api/
//
// Uso:  node scripts/fotos-stock.mjs <carpeta> <portrait|landscape> "<búsqueda 1>" "<búsqueda 2>" ...
//   ej. node scripts/fotos-stock.mjs videos/dental/assets portrait "dentist smiling patient" "modern dental clinic"
// Por cada búsqueda guarda la mejor foto como <carpeta>/px-1.jpg, px-2.jpg… y anota el crédito en creditos-fotos.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
// .env mínimo: solo las claves de fotos
for (const l of (fs.existsSync(path.join(ROOT, ".env")) ? fs.readFileSync(path.join(ROOT, ".env"), "utf8") : "").split(/\r?\n/)) {
  const m = l.match(/^\s*(UNSPLASH_ACCESS_KEY|PEXELS_API_KEY)\s*=\s*(.+?)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const UNSPLASH = process.env.UNSPLASH_ACCESS_KEY, PEXELS = process.env.PEXELS_API_KEY;
const [carpeta, orientacion = "portrait", ...busquedas] = process.argv.slice(2);
if (!UNSPLASH && !PEXELS) { console.error("Falta UNSPLASH_ACCESS_KEY (o PEXELS_API_KEY) en .env"); process.exit(1); }
if (!carpeta || !busquedas.length) { console.error('Uso: node scripts/fotos-stock.mjs <carpeta> <portrait|landscape> "<búsqueda>" ...'); process.exit(1); }
const LADO = orientacion === "portrait" ? "h" : "w";

/** Devuelve hasta 15 candidatas: { id, url (≈2000 px), autor, pagina, aviso? } */
async function buscar(q) {
  if (UNSPLASH) {
    const r = await fetch(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(q)}&orientation=${orientacion === "portrait" ? "portrait" : "landscape"}&per_page=15&content_filter=high`, {
      headers: { Authorization: `Client-ID ${UNSPLASH}`, "Accept-Version": "v1" },
    });
    if (!r.ok) throw new Error(`Unsplash respondió ${r.status}`);
    const { results = [] } = await r.json();
    return results
      .filter((p) => !p.premium && !p.plus) // solo las de licencia libre
      .map((p) => ({ id: p.id, url: `${p.urls.raw}&auto=format&fit=max&q=85&${LADO}=2000`, autor: p.user?.name, pagina: p.links?.html, aviso: p.links?.download_location }));
  }
  const r = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&orientation=${orientacion}&size=large&per_page=15`, { headers: { Authorization: PEXELS } });
  if (!r.ok) throw new Error(`Pexels respondió ${r.status}`);
  const { photos = [] } = await r.json();
  return photos.map((p) => ({ id: p.id, url: `${p.src.original}?auto=compress&cs=tinysrgb&${LADO}=2000`, autor: p.photographer, pagina: p.url }));
}

fs.mkdirSync(carpeta, { recursive: true });
const usadas = new Set();
const creditos = [];
let n = 0;
for (const q of busquedas) {
  try {
    const foto = (await buscar(q)).find((p) => !usadas.has(p.id));
    if (!foto) { console.error(`"${q}": sin resultados`); continue; }
    usadas.add(foto.id);
    const img = Buffer.from(await (await fetch(foto.url)).arrayBuffer());
    // Unsplash pide avisar cada descarga (lineamientos de su API)
    if (foto.aviso) fetch(foto.aviso, { headers: { Authorization: `Client-ID ${UNSPLASH}` } }).catch(() => {});
    const nombre = `px-${++n}.jpg`;
    fs.writeFileSync(path.join(carpeta, nombre), img);
    creditos.push({ archivo: nombre, busqueda: q, autor: foto.autor, url: foto.pagina, fuente: UNSPLASH ? "Unsplash" : "Pexels" });
    console.log(`${nombre}  "${q}"  · ${foto.autor}`);
  } catch (e) {
    console.error(`"${q}": ${e.message}`);
  }
}
fs.writeFileSync(path.join(carpeta, "creditos-fotos.json"), JSON.stringify(creditos, null, 2));
console.log(`${n} foto(s) en ${carpeta}`);
