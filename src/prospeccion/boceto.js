// Bocetos: una página de muestra hecha "para" cada negocio (con su nombre, colonia y teléfono),
// que se manda en el primer mensaje: "les preparé una muestra de cómo se vería lo suyo".
// Se sirve en /m/<nombre>-<clave>. Cuando el negocio la abre, te llega un aviso.
import crypto from "node:crypto";
import { settings } from "../config.js";
import { getDb, now, logEvent } from "../db.js";
import { getProspeccion } from "./config.js";
import { perfilDe, perfilesGaleria } from "./perfiles.js";

const db = () => getDb();

// El contenido de cada tipo de negocio vive en perfiles.js.

// ---------- Claves y direcciones ----------

const slug = (s) =>
  String(s || "negocio")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "negocio";

/** Clave del boceto de un prospecto (se crea la primera vez). */
export function claveBoceto(p) {
  if (p.boceto) return p.boceto;
  const clave = crypto.randomBytes(4).toString("hex");
  db().prepare("UPDATE prospectos SET boceto = ? WHERE id = ? AND boceto IS NULL").run(clave, p.id);
  return db().prepare("SELECT boceto FROM prospectos WHERE id = ?").get(p.id)?.boceto || clave;
}

/** ¿El agente tiene una dirección pública (https) donde los negocios puedan abrir su boceto? */
export const bocetosDisponibles = () => /^https:\/\//.test(settings.publicUrl);

export function urlBoceto(p) {
  if (!p?.id) return null;
  return `${settings.publicUrl}/m/${slug(p.nombre)}-${claveBoceto(p)}`;
}

export function buscarPorClave(ruta) {
  const clave = String(ruta || "").split("-").pop();
  if (!/^[0-9a-f]{8}$/.test(clave)) return null;
  return db().prepare("SELECT * FROM prospectos WHERE boceto = ?").get(clave) || null;
}

const BOTS = /bot|crawler|spider|preview|facebookexternalhit|whatsapp|telegram|slack|discord|curl|wget|python|node-fetch|headless/i;

/**
 * Registra que alguien abrió el boceto. Devuelve true si es la PRIMERA vez que el negocio lo abre
 * (para avisarte). No cuenta bots, vistas previas de enlaces ni tus propias vistas desde el panel.
 */
export function registrarVisita(p, { userAgent = "", tuyo = false } = {}) {
  if (tuyo || !userAgent || BOTS.test(userAgent)) return false;
  const antes = db()
    .prepare("SELECT COUNT(*) n FROM eventos WHERE tipo = 'boceto_visto' AND json_extract(datos, '$.prospecto') = ?")
    .get(p.id).n;
  logEvent("boceto_visto", null, { prospecto: p.id });
  if (antes === 0) {
    db()
      .prepare("UPDATE prospectos SET notas = TRIM(COALESCE(notas,'') || char(10) || ?), actualizado = ? WHERE id = ?")
      .run(`Abrió su boceto el ${new Date().toISOString().slice(0, 10)}`, now(), p.id);
  }
  return antes === 0;
}

// ---------- Página ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const dinero = (n) => (typeof n === "number" ? (n === 0 ? "Sin costo" : `$${n.toLocaleString("es-MX")}`) : esc(n));
const iniciales = (n) =>
  String(n || "?")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .split(/\s+/)
    .filter((w) => w && !/^(el|la|los|las|de|del|y|e|en|para|con|sa|cv|s|a)$/i.test(w))
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase() || "N";

const ICO = {
  wa: '<path d="M3 21l1.65-3.8a9 9 0 1 1 3.4 2.9L3 21"/><path d="M9 10a.5.5 0 0 0 1 0V9a.5.5 0 0 0-1 0v1a5 5 0 0 0 5 5h1a.5.5 0 0 0 0-1h-1a.5.5 0 0 0 0 1"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
  cal: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  bag: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18M16 10a4 4 0 0 1-8 0"/>',
  bot: '<rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4M8 16h.01M16 16h.01"/>',
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  star: '<path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
};
const ico = (n, s = 18) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICO[n]}</svg>`;

function tarjetaSellos(p, d) {
  const s = d.sellos;
  const circ = Array.from({ length: s.total }, (_, i) => `<i class="${i < s.llevas ? "on" : ""}">${i < s.llevas ? ico("check", 14) : ""}</i>`).join("");
  return `<section class="sec"><h2>Tarjeta de cliente frecuente</h2>
  <div class="wallet"><div class="w-top"><b>${esc(p.nombre)}</b><span>Cliente frecuente</span></div>
    <div class="sellos">${circ}</div>
    <div class="w-pie"><span>Llevas ${s.llevas} de ${s.total} ${esc(d.palabraSello || "visitas")}</span><b>Te faltan ${s.total - s.llevas} para ${esc(s.premio)}</b></div></div>
  <div class="botones2"><button class="b2" data-demo="wallet">Agregar a Apple Wallet</button><button class="b2" data-demo="wallet">Agregar a Google Wallet</button></div>
  <p class="mini">Tus clientes la guardan en su celular, no se pierde, y tú ves quiénes son tus clientes frecuentes para mandarles promociones.</p></section>`;
}

function menu(d) {
  const tabs = Object.keys(d.cats);
  return `<section class="sec"><h2>Menú</h2><div class="tabs">${tabs.map((t, i) => `<button class="tab ${i ? "" : "on"}" data-tab="${i}">${esc(t)}</button>`).join("")}</div>
  ${tabs
    .map(
      (t, i) => `<div class="lista" data-lista="${i}" ${i ? "hidden" : ""}>${d.cats[t]
        .map(([n, desc, pr]) => `<div class="item"><div class="foto">${esc(iniciales(n))}</div><div class="info"><b>${esc(n)}</b><small>${esc(desc)}</small><span class="precio">${dinero(pr)}</span></div><button class="mas" data-add="${esc(n)}" data-precio="${pr}" aria-label="Agregar">+</button></div>`)
        .join("")}</div>`
    )
    .join("")}</section>`;
}

function seccionPrincipal(p, d) {
  switch (d.tipo) {
    case "menu":
      return menu(d) + (d.sellos ? tarjetaSellos(p, d) : "");
    case "cafe":
      return tarjetaSellos(p, d) + menu(d);
    case "catalogo":
      return `<section class="sec"><h2>Catálogo</h2><div class="grid">${d.items
        .map(([n, desc, pr], i) => `<div class="prod"><div class="pfoto" style="--h:${(i * 47) % 360}">${esc(iniciales(n))}</div><b>${esc(n)}</b><small>${esc(desc)}</small><div class="row"><span class="precio">${dinero(pr)}</span><button class="mas" data-add="${esc(n)}" data-precio="${pr}" aria-label="Agregar">+</button></div></div>`)
        .join("")}</div></section>` + (d.sellos ? tarjetaSellos(p, d) : "");
    case "citas": {
      const hoy = new Date();
      const dias = [];
      for (let i = 1; dias.length < 6; i++) {
        const f = new Date(hoy.getTime() + i * 86400_000);
        if (f.getDay() === 0) continue;
        dias.push(f);
      }
      const nom = (f) => f.toLocaleDateString("es-MX", { weekday: "short", timeZone: "America/Monterrey" }).replace(".", "");
      const num = (f) => f.toLocaleDateString("es-MX", { day: "numeric", timeZone: "America/Monterrey" });
      return `<section class="sec"><h2>Agenda tu cita</h2><p class="mini" style="margin-top:-6px">1. Elige el servicio</p>
      <div class="servs">${d.servicios.map(([n, min, pr], i) => `<button class="serv ${i ? "" : "on"}" data-serv="${esc(n)}"><b>${esc(n)}</b><small>${ico("clock", 13)} ${min} min · ${dinero(pr)}</small></button>`).join("")}</div>
      <p class="mini">2. Elige el día</p><div class="dias">${dias.map((f, i) => `<button class="dia ${i ? "" : "on"}" data-dia="${esc(nom(f))} ${esc(num(f))}"><small>${esc(nom(f))}</small><b>${esc(num(f))}</b></button>`).join("")}</div>
      <p class="mini">3. Elige la hora</p><div class="horas">${["10:00", "11:00", "12:30", "16:00", "17:00", "18:30"].map((h, i) => `<button class="hora ${i === 1 ? "on" : ""} ${i === 2 ? "ocupada" : ""}" data-hora="${h}" ${i === 2 ? "disabled" : ""}>${h}</button>`).join("")}</div>
      <button class="cta" data-demo="cita">${ico("cal")} Confirmar cita</button></section>` + (d.sellos ? tarjetaSellos(p, d) : "");
    }
    case "fidelidad":
      return tarjetaSellos(p, d) + `<section class="sec"><h2>${d.palabraSello === "lavados" ? "Servicios" : "Planes"}</h2><div class="planes">${d.planes
        .map(([n, desc, pr], i) => `<div class="plan ${i === 1 ? "dest" : ""}"><b>${esc(n)}</b><small>${esc(desc)}</small><span class="precio">${dinero(pr)}</span></div>`)
        .join("")}</div></section>`;
    case "inmobiliaria":
      return `<section class="sec"><h2>Propiedades</h2><div class="tabs"><button class="tab on">Todas</button><button class="tab">Venta</button><button class="tab">Renta</button></div><div class="grid">${d.items
        .map(([n, desc, pr], i) => `<div class="prod"><div class="pfoto casa" style="--h:${150 + i * 25}">${ico("home", 34)}</div><b>${esc(n)}</b><small>${esc(desc)}${p.colonia ? ` · ${esc(p.colonia)}` : ""}</small><span class="precio">${esc(pr)}</span></div>`)
        .join("")}</div></section>`;
    case "servicios":
      return `<section class="sec"><h2>Servicios</h2><div class="planes">${d.items.map(([n, desc]) => `<div class="plan"><b>${esc(n)}</b><small>${esc(desc)}</small></div>`).join("")}</div></section>
      <section class="sec"><h2>Lo que dicen nuestros clientes</h2><div class="resenas">${[
        ["Muy buena atención y cumplieron con lo que prometieron.", "Laura G."],
        ["Me respondieron rápido por WhatsApp y el precio fue justo.", "Carlos M."],
        ["Los recomiendo, muy profesionales.", "Ana R."],
      ]
        .map(([t, a]) => `<div class="resena"><div class="estrellas">${ico("star", 14).repeat(5)}</div><p>${esc(t)}</p><small>${esc(a)} · reseña de ejemplo</small></div>`)
        .join("")}</div></section>
      <section class="sec"><h2>Cotiza sin compromiso</h2><div class="form" style="margin-top:0"><input placeholder="Tu nombre"><input placeholder="WhatsApp" inputmode="tel"><input placeholder="¿Qué necesitas?"><button class="cta" data-demo="cotizacion">Pedir cotización</button></div></section>`;
    case "escuela":
      return `<section class="sec"><h2>Inscripciones abiertas</h2><div class="planes">${d.items.map(([n, desc]) => `<div class="plan"><b>${esc(n)}</b><small>${esc(desc)}</small></div>`).join("")}</div>
      <div class="form"><input placeholder="Nombre del alumno"><input placeholder="WhatsApp" inputmode="tel"><button class="cta" data-demo="inscripcion">Quiero informes</button></div></section>`;
    default:
      return "";
  }
}

function chatIA(p, d) {
  const conv = {
    inmobiliaria: [
      "Hola, ¿sigue disponible la casa de 3 recámaras?",
      "¡Hola! Sí, sigue disponible: cuesta $2,450,000 y tiene cochera doble. ¿Te gustaría verla? Tengo mañana a las 11:00 o a las 5:00.",
      "Mañana a las 5",
      "Listo, quedó agendada la visita. Te mando la ubicación y un recordatorio una hora antes.",
    ],
    servicios: [
      "Hola, ¿cuánto cuesta y cuándo me pueden atender?",
      `¡Hola! En ${p.nombre} depende de lo que necesites. Cuéntame un poco y te agendo una llamada; tengo mañana a las 10:00 o a las 4:00.`,
      "Mañana a las 10 está bien",
      "Listo, quedó agendado. Te mando un recordatorio una hora antes.",
    ],
    menu: [
      "Hola, ¿tienen servicio a domicilio?",
      `¡Hola! Sí, en ${p.nombre} llevamos a domicilio. Te tomo el pedido aquí mismo, ¿qué se te antoja?`,
      "Dos órdenes de enchiladas suizas",
      "Listo, son $298. Llega en unos 35 minutos. ¿Pagas en efectivo o transferencia?",
    ],
  }[d.tipo] || [
    "Hola, ¿tienen lugar mañana en la tarde?",
    `¡Hola! Sí, en ${p.nombre} tenemos lugar mañana a las 4:00 y a las 5:30. ¿Cuál te acomoda?`,
    "A las 5:30 porfa",
    "Listo, quedó agendado. Te mando un recordatorio una hora antes.",
  ];
  return `<section class="sec"><h2>Asistente de IA en tu WhatsApp</h2><div class="chat">
  ${conv.map((t, i) => `<div class="burbuja ${i % 2 ? "yo" : "ellos"}">${i % 2 ? ico("bot", 14) + " " : ""}${esc(t)}</div>`).join("\n  ")}</div>
  <p class="mini">Contesta a tus clientes a cualquier hora, agenda y toma pedidos solo, y te avisa de todo.</p></section>`;
}

/** HTML completo del boceto de un prospecto. */
export function renderBoceto(p) {
  const cfg = getProspeccion();
  const d = p.perfil || perfilDe(p);
  const chip = String(process.env.WA_NUMERO || cfg.remitente.whatsapp || "").replace(/\D/g, "").slice(-10);
  const quiero = `https://wa.me/52${chip}?text=${encodeURIComponent(p.demo ? `Hola, vi la muestra de ${d.nombre.toLowerCase()} y me interesa una para mi negocio.` : `Hola, vi la muestra que me hicieron para ${p.nombre} y me interesa.`)}`;
  const mapa = p.lat && p.lon ? `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lon}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${p.nombre} ${p.ciudad || ""}`)}`;
  const lugar = [p.colonia, p.ciudad].filter(Boolean).join(", ");
  const tel = String(p.telefono || "").replace(/\D/g, "");
  const accion = d.accion || { menu: "Pedir", cafe: "Pedir", catalogo: "Pedir", citas: "Agendar", fidelidad: "Escribir", inmobiliaria: "Preguntar", escuela: "Informes", servicios: "Cotizar" }[d.tipo] || "Escribir";
  const titulo = `${p.nombre} · muestra de ${d.que}`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(titulo)}</title><meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="${d.color}">
<meta property="og:title" content="${esc(p.nombre)}"><meta property="og:description" content="Una muestra de ${esc(d.que)} hecha para ${esc(p.nombre)}.">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--c:${d.color};--bg:#f6f5f3;--card:#fff;--tx:#18181b;--mu:#71717a;--ln:#e7e5e4}
@media (prefers-color-scheme:dark){:root{--bg:#0c0c0d;--card:#18181b;--tx:#f4f4f5;--mu:#a1a1aa;--ln:#27272a}}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.5 "Plus Jakarta Sans",system-ui,sans-serif;padding-bottom:96px}
button,input{font:inherit;color:inherit}
.aviso{background:#18181b;color:#fafafa;font-size:12.5px;padding:9px 16px;text-align:center}.aviso b{color:#fff}
.hero{background:linear-gradient(160deg,var(--c),color-mix(in srgb,var(--c) 55%,#000));color:#fff;padding:34px 18px 54px;position:relative;overflow:hidden}
.hero:after{content:"";position:absolute;inset:auto -40px -60px auto;width:220px;height:220px;border-radius:50%;background:#ffffff14}
.wrap{max-width:560px;margin:0 auto;padding:0 16px}
.logo{width:64px;height:64px;border-radius:18px;background:#ffffff26;border:1px solid #ffffff40;display:grid;place-items:center;font-weight:800;font-size:22px;letter-spacing:.5px;backdrop-filter:blur(6px)}
.hero h1{margin:14px 0 4px;font-size:clamp(24px,7vw,32px);line-height:1.15;font-weight:800;letter-spacing:-.02em;overflow-wrap:anywhere}
.hero p{margin:0;opacity:.88;font-size:14px;display:flex;gap:6px;align-items:center}
.abierto{display:inline-flex;align-items:center;gap:6px;margin-top:12px;background:#ffffff26;border-radius:99px;padding:4px 11px;font-size:12.5px;font-weight:600}.abierto i{width:7px;height:7px;border-radius:50%;background:#69db7c}
.acciones{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:-30px auto 0;position:relative;z-index:1}
.acc{background:var(--card);border:1px solid var(--ln);border-radius:16px;padding:12px 6px;display:flex;flex-direction:column;align-items:center;gap:4px;font-size:12.5px;font-weight:600;color:var(--tx);text-decoration:none;box-shadow:0 6px 20px #0000000f}
.acc svg{color:var(--c)}
.sec{background:var(--card);border:1px solid var(--ln);border-radius:20px;padding:18px;margin:14px 0}
.sec h2{margin:0 0 12px;font-size:17px;font-weight:800;letter-spacing:-.01em}
.mini{color:var(--mu);font-size:13px;margin:10px 0 8px}
.tabs{display:flex;gap:6px;overflow-x:auto;margin:0 -4px 12px;padding:0 4px;scrollbar-width:none}
.tab{border:1px solid var(--ln);background:none;border-radius:99px;padding:7px 14px;white-space:nowrap;cursor:pointer;font-weight:600;font-size:13px}
.tab.on{background:var(--c);border-color:var(--c);color:#fff}
.item{display:flex;gap:12px;align-items:center;padding:11px 0;border-top:1px solid var(--ln)}.item:first-child{border-top:0}
.foto{width:58px;height:58px;flex:none;border-radius:14px;background:color-mix(in srgb,var(--c) 16%,var(--card));color:var(--c);display:grid;place-items:center;font-weight:800}
.info{flex:1;min-width:0;display:flex;flex-direction:column}.info small{color:var(--mu);font-size:12.5px}
.precio{font-weight:800;color:var(--c);font-size:14.5px;margin-top:2px}
.mas{width:34px;height:34px;flex:none;border-radius:50%;border:0;background:var(--c);color:#fff;font-size:20px;font-weight:700;cursor:pointer;line-height:1}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.prod{border:1px solid var(--ln);border-radius:16px;padding:10px;display:flex;flex-direction:column;gap:2px;min-width:0}
.prod small{color:var(--mu);font-size:12px}.prod .row{display:flex;justify-content:space-between;align-items:center;margin-top:4px}
.pfoto{aspect-ratio:1.2;border-radius:12px;margin-bottom:6px;display:grid;place-items:center;font-weight:800;font-size:20px;color:#fff;background:linear-gradient(135deg,color-mix(in srgb,var(--c) 85%,hsl(var(--h) 70% 50%)),color-mix(in srgb,var(--c) 45%,#000))}
.wallet{border-radius:18px;padding:18px;color:#fff;background:linear-gradient(135deg,var(--c),color-mix(in srgb,var(--c) 40%,#000));box-shadow:0 10px 30px color-mix(in srgb,var(--c) 35%,transparent)}
.w-top{display:flex;justify-content:space-between;align-items:baseline;gap:8px}.w-top span{font-size:12px;opacity:.8}.w-top b{overflow-wrap:anywhere}
.sellos{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin:18px 0}
.sellos i{aspect-ratio:1;border-radius:50%;border:2px dashed #ffffff80;display:grid;place-items:center}.sellos i.on{background:#fff;color:var(--c);border:0}
.w-pie{display:flex;flex-direction:column;font-size:13px}.w-pie span{opacity:.85}
.botones2{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}
.b2{border:1px solid var(--ln);background:var(--bg);border-radius:12px;padding:10px 6px;font-size:12.5px;font-weight:700;cursor:pointer}
.servs{display:grid;gap:8px}
.serv{text-align:left;border:1px solid var(--ln);background:none;border-radius:14px;padding:11px 13px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:10px}
.serv small{color:var(--mu);display:flex;align-items:center;gap:4px;white-space:nowrap}.serv.on{border-color:var(--c);background:color-mix(in srgb,var(--c) 9%,transparent)}
.dias{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:6px}
.dia{border:1px solid var(--ln);background:none;border-radius:12px;padding:8px 0;cursor:pointer;display:flex;flex-direction:column;align-items:center}
.dia small{font-size:11px;color:var(--mu);text-transform:capitalize}.dia.on{background:var(--c);border-color:var(--c);color:#fff}.dia.on small{color:#ffffffcc}
.horas{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.hora{border:1px solid var(--ln);background:none;border-radius:10px;padding:9px 0;font-weight:600;cursor:pointer}.hora.on{border-color:var(--c);color:var(--c);background:color-mix(in srgb,var(--c) 9%,transparent)}
.hora.ocupada{opacity:.35;text-decoration:line-through;cursor:not-allowed}
.cta{width:100%;margin-top:14px;border:0;border-radius:14px;background:var(--c);color:#fff;padding:14px;font-weight:700;font-size:15px;display:flex;gap:8px;justify-content:center;align-items:center;cursor:pointer;text-decoration:none}
.planes{display:grid;gap:8px}
.plan{border:1px solid var(--ln);border-radius:14px;padding:12px 14px;display:grid;grid-template-columns:1fr auto;align-items:center}.plan small{color:var(--mu);grid-column:1;font-size:12.5px}.plan .precio{grid-row:1/3;grid-column:2}
.plan.dest{border-color:var(--c);background:color-mix(in srgb,var(--c) 8%,transparent)}
.casa{color:#ffffffe6}
.form{display:grid;gap:8px;margin-top:12px}.form input{border:1px solid var(--ln);background:var(--bg);border-radius:12px;padding:12px}
.chat{display:flex;flex-direction:column;gap:8px;background:color-mix(in srgb,var(--c) 6%,var(--bg));border-radius:16px;padding:12px}
.burbuja{max-width:85%;padding:9px 12px;border-radius:14px;font-size:13.5px}.burbuja svg{vertical-align:-2px;color:var(--c)}
.ellos{align-self:flex-start;background:var(--card);border:1px solid var(--ln)}.yo{align-self:flex-end;background:color-mix(in srgb,var(--c) 16%,var(--card))}
.donde{display:flex;gap:10px;align-items:flex-start;color:var(--mu);font-size:13.5px}.donde svg{color:var(--c);flex:none;margin-top:2px}
.pie{background:#18181b;color:#fafafa;border-radius:22px;padding:22px 18px;margin:22px 0 10px;text-align:center}
.pie h3{margin:0 0 6px;font-size:19px;font-weight:800}.pie p{color:#a1a1aa;margin:0 0 14px;font-size:13.5px}
.pie .cta{background:#fff;color:#18181b}.pie a.sec2{display:block;color:#d4d4d8;font-size:13px;margin-top:12px}
.firma{text-align:center;color:var(--mu);font-size:12px;margin:8px 0 0}
.barra{position:fixed;left:0;right:0;bottom:0;padding:10px 16px calc(10px + env(safe-area-inset-bottom));background:color-mix(in srgb,var(--bg) 85%,transparent);backdrop-filter:blur(10px);border-top:1px solid var(--ln);transform:translateY(110%);transition:transform .25s}
.barra.on{transform:none}.barra .cta{margin:0;max-width:528px;margin-inline:auto}
.modal{position:fixed;inset:0;background:#0009;display:none;align-items:flex-end;justify-content:center;z-index:9;padding:16px}.modal.on{display:flex}
.hoja{background:var(--card);border-radius:22px;padding:20px;width:100%;max-width:480px;animation:sube .25s}
@keyframes sube{from{transform:translateY(30px);opacity:0}}
.hoja h3{margin:0 0 6px;font-size:18px}.hoja p{color:var(--mu);margin:0 0 12px;font-size:14px}
.msj{background:color-mix(in srgb,#25d366 14%,var(--bg));border-radius:12px;padding:12px;font-size:13.5px;white-space:pre-line;margin-bottom:12px}
.cerrar{float:right;border:0;background:none;cursor:pointer;color:var(--mu)}
.resenas{display:grid;gap:8px}.resena{border:1px solid var(--ln);border-radius:14px;padding:12px}.resena p{margin:6px 0 4px;font-size:14px}.resena small{color:var(--mu);font-size:12px}
.estrellas{color:#f59f00;display:flex;gap:2px}.estrellas svg{fill:currentColor}
</style></head><body>
<div class="aviso">Muestra hecha para <b>${esc(p.nombre)}</b> por sss.solutions. El contenido es de ejemplo.</div>
<header class="hero"><div class="wrap"><div class="logo">${esc(iniciales(p.nombre))}</div>
<h1>${esc(p.nombre)}</h1><p>${ico("pin", 14)} ${esc(lugar || "Tu ciudad")}</p><span class="abierto"><i></i>Abierto ahora</span></div></header>
<main class="wrap">
<div class="acciones">
  <a class="acc" href="#" data-demo="${d.tipo === "citas" ? "cita" : "pedido"}">${ico(d.tipo === "citas" ? "cal" : "wa", 20)}${accion}</a>
  <a class="acc" href="${tel ? `tel:${tel}` : "#"}">${ico("phone", 20)}Llamar</a>
  <a class="acc" href="${esc(mapa)}" target="_blank" rel="noopener">${ico("pin", 20)}Cómo llegar</a>
</div>
${seccionPrincipal(p, d)}
${d.ia ? chatIA(p, d) : ""}
<section class="sec"><h2>Dónde estamos</h2><div class="donde">${ico("pin")}<div>${esc(p.direccion || "")}${p.direccion ? "<br>" : ""}${esc(lugar)}</div></div></section>
<div class="pie"><h3>¿Te gusta cómo se ve?</h3><p>Esto es solo una muestra. La tuya se hace a la medida, con tus fotos, tus precios y tu logo, y funciona desde el celular de tus clientes.</p>
<a class="cta" href="${esc(quiero)}">${ico("wa")} Quiero la mía</a>
<a class="sec2" href="${esc(cfg.remitente.portafolio)}" target="_blank" rel="noopener">Ver más trabajos de sss.solutions</a></div>
<p class="firma">Hecho por ${esc(cfg.remitente.nombre)} · ${esc(cfg.remitente.empresa)}</p>
</main>
<div class="barra" id="barra"><button class="cta" data-demo="pedido">${ico("bag")} <span id="bt">Ver pedido</span></button></div>
<div class="modal" id="modal"><div class="hoja"><button class="cerrar" id="cerrar" aria-label="Cerrar">${ico("x")}</button><h3 id="mt"></h3><p id="mp"></p><div class="msj" id="mm"></div>
<a class="cta" href="${esc(quiero)}">${ico("wa")} Quiero esto para ${esc(p.nombre)}</a></div></div>
<script>
(function(){
var NEG=${JSON.stringify(String(p.nombre)).replace(/</g, "\\u003c")};var pedido=[];var $=function(s){return document.querySelector(s)};var all=function(s){return document.querySelectorAll(s)};
function sel(grupo,cls){all(grupo).forEach(function(b){b.addEventListener("click",function(){if(b.disabled)return;all(grupo).forEach(function(x){x.classList.remove(cls)});b.classList.add(cls)})})}
sel(".serv","on");sel(".dia","on");sel(".hora","on");
all(".tab").forEach(function(t){t.addEventListener("click",function(){all(".tab").forEach(function(x){x.classList.toggle("on",x===t)});var i=t.dataset.tab;if(i==null)return;all("[data-lista]").forEach(function(l){l.hidden=l.dataset.lista!==i})})});
all("[data-add]").forEach(function(b){b.addEventListener("click",function(){pedido.push([b.dataset.add,Number(b.dataset.precio)||0]);var tot=pedido.reduce(function(a,x){return a+x[1]},0);$("#bt").textContent="Ver pedido ("+pedido.length+") · $"+tot.toLocaleString("es-MX");$("#barra").classList.add("on");b.textContent="✓";setTimeout(function(){b.textContent="+"},700)})});
function modal(t,p,m){$("#mt").textContent=t;$("#mp").textContent=p;$("#mm").textContent=m;$("#modal").classList.add("on")}
$("#cerrar").onclick=function(){$("#modal").classList.remove("on")};$("#modal").onclick=function(e){if(e.target.id==="modal")$("#modal").classList.remove("on")};
all("[data-demo]").forEach(function(b){b.addEventListener("click",function(e){e.preventDefault();var k=b.dataset.demo;
if(k==="pedido"){var l=pedido.length?pedido:[["(elige algo del menú)",0]];var tot=pedido.reduce(function(a,x){return a+x[1]},0);modal("Así te llegaría el pedido","Ordenado y directo a tu WhatsApp, sin errores ni llamadas.","Nuevo pedido para "+NEG+"\\n\\n"+l.map(function(x){return "• "+x[0]+(x[1]?"  $"+x[1]:"")}).join("\\n")+(tot?"\\n\\nTotal: $"+tot.toLocaleString("es-MX"):"")+"\\nCliente: María López\\nEntrega: a domicilio")}
else if(k==="cita"){var s=$(".serv.on"),d=$(".dia.on"),h=$(".hora.on");modal("Así quedaría agendada","Al cliente le llega la confirmación y un recordatorio; a ti, el aviso con sus datos.","Cita confirmada en "+NEG+"\\n\\n"+(s?s.dataset.serv:"Servicio")+"\\n"+(d?d.dataset.dia:"")+" a las "+(h?h.dataset.hora:"")+"\\nCliente: Juan Pérez\\n\\nTe recordamos un día antes y una hora antes.")}
else if(k==="wallet"){modal("Tarjeta en el celular","Tus clientes la agregan con un toque y les llegan avisos cuando están cerca o cuando tienes promoción.","Hola, ya casi completas tu tarjeta en "+NEG+". Te faltan pocos para tu premio. Te esperamos.")}
else{modal("Así te llegarían los informes","Cada interesado queda registrado y te llega su mensaje directo.","Nuevo interesado en "+NEG+"\\nNombre: Ana Ruiz\\nWhatsApp: 871 000 0000")}})});
})();
</script></body></html>`;
}

// ---------- Galería: una muestra de cada tipo de negocio (para verlas o enseñarlas en persona) ----------

/** Muestra de un perfil con un negocio de ejemplo ("Tu pizzería"). */
export function renderMuestra(id) {
  const d = perfilesGaleria().find((x) => x.id === id);
  if (!d) return null;
  const tu = /^(cualquier)/i.test(d.nombre) ? "Tu negocio" : `Tu ${d.nombre.split(" y ")[0].toLowerCase()}`;
  return renderBoceto({ id: 0, demo: true, perfil: d, nombre: tu, colonia: "Centro", ciudad: "Torreón", direccion: "Tu dirección", telefono: "" });
}

export function renderGaleria() {
  const cfg = getProspeccion();
  const tarjetas = perfilesGaleria()
    .map((d) => `<a class="t" href="/muestras/${d.id}" style="--c:${d.color}"><i>${esc(iniciales(d.nombre))}</i><b>${esc(d.nombre)}</b><small>${esc(d.que)}</small></a>`)
    .join("");
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Muestras · ${esc(cfg.remitente.empresa)}</title><meta name="robots" content="noindex,nofollow">
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;800&display=swap" rel="stylesheet">
<style>:root{--bg:#f6f5f3;--card:#fff;--tx:#18181b;--mu:#71717a;--ln:#e7e5e4}@media (prefers-color-scheme:dark){:root{--bg:#0c0c0d;--card:#18181b;--tx:#f4f4f5;--mu:#a1a1aa;--ln:#27272a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.5 "Plus Jakarta Sans",system-ui,sans-serif}
main{max-width:980px;margin:0 auto;padding:28px 16px 48px}h1{margin:0;font-size:clamp(24px,6vw,34px);letter-spacing:-.02em}p{color:var(--mu);margin:6px 0 22px}
.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,210px),1fr));gap:10px}
.t{background:var(--card);border:1px solid var(--ln);border-radius:16px;padding:14px;color:inherit;text-decoration:none;display:flex;flex-direction:column;gap:2px;transition:transform .15s,border-color .15s}
.t:hover{transform:translateY(-2px);border-color:var(--c)}.t i{width:40px;height:40px;border-radius:12px;background:var(--c);color:#fff;display:grid;place-items:center;font-style:normal;font-weight:800;font-size:14px;margin-bottom:8px}
.t small{color:var(--mu);font-size:12.5px}</style></head>
<body><main><h1>Muestras por tipo de negocio</h1><p>${perfilesGaleria().length} tipos. A cada negocio que contacta, el agente le arma la suya con su nombre, su colonia y su teléfono. Toca una para verla como la vería el cliente.</p>
<div class="g">${tarjetas}</div></main></body></html>`;
}

/** Página para claves que no existen. */
export const bocetoNoEncontrado = () =>
  `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Muestra no encontrada</title><meta name="robots" content="noindex">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f5f3;color:#18181b;font-family:system-ui,sans-serif;text-align:center;padding:16px}</style></head>
<body><main><h2>Esta muestra ya no está disponible</h2><p>Si te interesa una página para tu negocio, escríbenos.</p></main></body></html>`;
