// Bocetos: una página de muestra hecha "para" cada negocio (con su nombre, colonia y teléfono),
// que se manda en el primer mensaje: "les preparé una muestra de cómo se vería lo suyo".
// Se sirve en /m/<nombre>-<clave>. Cuando el negocio la abre, te llega un aviso.
import crypto from "node:crypto";
import { settings } from "../config.js";
import { getDb, now, logEvent } from "../db.js";
import { getProspeccion } from "./config.js";
import { perfilDe, perfilesGaleria } from "./perfiles.js";
import { fotosDe, fotosParaNegocio } from "./fotos.js";
import { marcaDe } from "./marca.js";

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
/** Muestras fijas en GitHub Pages (ver publicar.js): si están configuradas, los links usan esa dirección. */
export const bocetosFijos = () => /^https:\/\//.test(process.env.BOCETOS_URL || "") && !!process.env.BOCETOS_DIR;
export const baseBocetos = () => (bocetosFijos() ? process.env.BOCETOS_URL.replace(/\/$/, "") : settings.publicUrl);
export const bocetosDisponibles = () => /^https:\/\//.test(baseBocetos());

export function urlBoceto(p) {
  if (!p?.id) return null;
  return `${baseBocetos()}/m/${slug(p.nombre)}-${claveBoceto(p)}`;
}

export function buscarPorClave(ruta) {
  const clave = String(ruta || "").split("-").pop();
  if (!/^[0-9a-f]{8}$/.test(clave)) return null;
  return db().prepare("SELECT * FROM prospectos WHERE boceto = ?").get(clave) || null;
}

const BOTS = /bot|crawler|spider|preview|facebookexternalhit|whatsapp|telegram|slack|discord|curl|wget|python|node-fetch|headless|powershell/i;

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

/**
 * ¿El negocio REGRESÓ a ver su muestra? (otra visita al menos 30 min después de la anterior).
 * Es la mejor señal de interés. Avisa como máximo una vez cada 12 h por negocio.
 * @returns {number} veces que la ha abierto, o 0 si no hay que avisar.
 */
export function regresoVisita(p) {
  const vis = db()
    .prepare("SELECT creado FROM eventos WHERE tipo = 'boceto_visto' AND json_extract(datos, '$.prospecto') = ? ORDER BY id DESC")
    .all(p.id);
  if (vis.length < 2 || Date.parse(vis[0].creado) - Date.parse(vis[1].creado) < 30 * 60_000) return 0;
  const reciente = db()
    .prepare("SELECT 1 FROM eventos WHERE tipo = 'boceto_regreso' AND json_extract(datos, '$.prospecto') = ? AND creado > ?")
    .get(p.id, new Date(Date.now() - 12 * 3600_000).toISOString());
  if (reciente) return 0;
  logEvent("boceto_regreso", null, { prospecto: p.id });
  return vis.length;
}

// ---------- Página ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// "$850 / noche": la unidad va chica, para que el precio se lea primero y quepa en la tarjeta.
const dinero = (n) => {
  if (typeof n === "number") return n === 0 ? "Sin costo" : `$${n.toLocaleString("es-MX")}`;
  const [monto, ...unidad] = String(n ?? "").split(/\s*\/\s*/);
  return unidad.length ? `${esc(monto)}<small class="u">/${esc(unidad.join("/"))}</small>` : esc(n);
};
const iniciales = (n) =>
  String(n || "?")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .split(/\s+/)
    .filter((w) => w && !/^(el|la|los|las|de|del|y|e|en|para|con|sa|cv|s|a)$/i.test(w))
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase() || "N";

/**
 * El color del negocio, oscurecido lo justo para que el texto blanco encima se lea (contraste ≥ 4.8:1, con margen para textos semitransparentes).
 * Un naranja o un amarillo de marca quedan casi igual, pero los botones dejan de verse deslavados.
 */
export function colorLegible(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  let rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const lum = (c) => {
    const [r, g, b] = c.map((v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  for (let i = 0; i < 20 && 1.05 / (lum(rgb) + 0.05) < 4.8; i++) rgb = rgb.map((v) => Math.round(v * 0.94));
  return "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");
}

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
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>',
  app: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/>',
  flecha: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  izq: '<path d="m15 18-6-6 6-6"/>',
  der: '<path d="m9 18 6-6-6-6"/>',
};
const ico = (n, s = 18, w = 2) =>
  `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICO[n]}</svg>`;

// ---------- Piezas de la experiencia a pantalla completa ----------

/** Una pantalla del recorrido (parte 1 = su página, parte 2 = la propuesta). */
const pant = (id, tono, parte, label, cuerpo, cls = "") =>
  `<section class="pant${cls ? ` ${cls}` : ""}" id="s-${id}" data-parte="${parte}" data-tono="${tono}" aria-label="${esc(label)}"><div class="cuerpo">\n${cuerpo}\n</div></section>`;
/** Etiqueta + título (+ bajada) con la entrada escalonada. */
// La etiqueta va solo cuando dice algo que el título no dice (sin etiqueta = "").
const encab = (eti, titulo, baj) =>
  `${eti ? `<p class="eti a" style="--d:0">${eti}</p>\n` : ""}<h2 class="t a" style="--d:1">${titulo}</h2>${baj ? `\n<p class="baj a" style="--d:2">${baj}</p>` : ""}`;
const mas = (n, pr) => `<button class="mas" type="button" data-add="${esc(n)}" data-precio="${esc(pr)}" aria-label="Agregar ${esc(n)}">+</button>`;
const item = (n, desc, pr, conBoton = true, extra = "") =>
  `<div class="item"><div class="info"><b>${esc(n)}${extra}</b>${desc ? `<small>${esc(desc)}</small>` : ""}${pr != null && pr !== "" ? `<span class="precio">${dinero(pr)}</span>` : ""}</div>${conBoton ? mas(n, pr) : ""}</div>`;

/** "Lo más pedido": galería con fotos (de muestra) de los primeros productos. */
function sDestacados(lista, platos, eti) {
  const xs = lista.slice(0, Math.min(platos.length, lista.length, 4));
  if (!xs.length) return "";
  return pant("dest", "claro", 1, "Lo más pedido", `${encab("", "Lo más pedido")}
<div class="galeria a" style="--d:2" data-galeria data-notap>${xs
    .map(([n, , pr], i) => `<figure class="g-item${i ? "" : " on"}"><img src="${platos[i]}" alt="${esc(n)}" loading="${i ? "lazy" : "eager"}" decoding="async" width="720" height="900"><figcaption><b>${esc(n)}</b><span class="precio">${dinero(pr)}</span></figcaption>${mas(n, pr)}</figure>`)
    .join("")}</div>
<div class="g-sel a" style="--d:3">${xs.map(([n], i) => `<button type="button" data-ver="${i}" aria-pressed="${i ? "false" : "true"}"${i ? "" : ' class="on"'}>${esc(n)}</button>`).join("")}</div>`);
}

function sMenu(d) {
  const tabs = Object.keys(d.cats);
  return pant("menu", "claro", 1, "Menú", `${encab("", "Menú", "Pide aquí y te llega a WhatsApp.")}
<div class="tabs a" style="--d:3">${tabs.map((t, i) => `<button class="tab${i ? "" : " on"}" type="button" data-tab="${i}" aria-pressed="${i ? "false" : "true"}">${esc(t)}</button>`).join("")}</div>
<div class="a" style="--d:4">
${tabs.map((t, i) => `<div class="lista" data-lista="${i}"${i ? " hidden" : ""}>${d.cats[t].map(([n, desc, pr]) => item(n, desc, pr)).join("")}</div>`).join("\n")}
</div>`);
}

function sCatalogo(d) {
  // Cada giro con sus palabras: un hotel no "arma un pedido", reserva una habitación.
  const t = { eti: "Pide aquí", titulo: "Catálogo", sub: "Arma tu pedido o cotiza por WhatsApp.", ...(d.textosCatalogo || {}) };
  return pant("cat", "claro", 1, t.titulo, `${encab(esc(t.eti), esc(t.titulo), esc(t.sub))}
<div class="cat a" style="--d:3">${d.items
    .map(([n, desc, pr]) => `<div class="tile"><b>${esc(n)}</b><small>${esc(desc)}</small><div class="tile-pie"><span class="precio">${dinero(pr)}</span>${mas(n, pr)}</div></div>`)
    .join("")}</div>`);
}

function sTarjeta(p, d) {
  const s = d.sellos;
  const llevas = Math.min(s.llevas, s.total - 1);
  const palabra = d.palabraSello || "visitas";
  const circ = Array.from({ length: s.total }, (_, i) => (i < llevas ? `<i class="on">${ico("check", 14)}</i>` : "<i></i>")).join("");
  return pant("tarjeta", "claro", 1, "Cliente frecuente", `${encab("", "Cliente frecuente")}
<div class="wallet a" style="--d:2" data-premio="${esc(s.premio)}" data-palabra="${esc(palabra)}"><div class="w-top"><b>${esc(p.nombre)}</b><span>Cliente frecuente</span></div>
<div class="sellos">${circ}</div>
<div class="w-pie" role="status"><span data-w-n>Llevas ${llevas} de ${s.total} ${esc(palabra)}</span><b data-w-f>Te faltan ${s.total - llevas} para ${esc(s.premio)}</b></div>
<button class="w-sellar" type="button" data-sellar>${ico("check", 18, 2.6)} Toca para sellar</button></div>
<div class="botones2 a" style="--d:3"><button class="b2" type="button" data-demo="wallet">Apple Wallet</button><button class="b2" type="button" data-demo="wallet">Google Wallet</button></div>
<p class="mini a" style="--d:4">No se pierde y ves quién regresa.</p>`);
}

function sCitas(d) {
  const hoy = new Date();
  const dias = [];
  for (let i = 1; dias.length < 6; i++) {
    const f = new Date(hoy.getTime() + i * 86400_000);
    if (f.getDay() === 0) continue;
    dias.push(f);
  }
  const nom = (f) => f.toLocaleDateString("es-MX", { weekday: "short", timeZone: "America/Monterrey" }).replace(".", "");
  const num = (f) => f.toLocaleDateString("es-MX", { day: "numeric", timeZone: "America/Monterrey" });
  // Textos por perfil (p. ej. un restaurante "reserva", un consultorio "agenda cita").
  const t = { eti: "Agenda tu cita", titulo: "¿Qué servicio?", baj: "Sin llamadas: eliges y listo.", titulo2: "¿Qué día y hora?", confirmar: "Confirmar cita", ...(d.citas || {}) };
  const detalle = (min, pr) => [typeof min === "number" ? `${min} min` : min, pr != null && pr !== "" ? dinero(pr) : ""].filter(Boolean).join(", ");
  const servicio = pant("serv", "claro", 1, "Elige servicio", `${encab(esc(t.eti), esc(t.titulo), esc(t.baj))}
<div class="servs a" style="--d:3">${d.servicios
    .map(([n, min, pr], i) => `<button class="serv${i ? "" : " on"}" type="button" data-serv="${esc(n)}" aria-pressed="${i ? "false" : "true"}"><b>${esc(n)}</b><small>${ico("clock", 13)} ${esc(detalle(min, pr))}</small></button>`)
    .join("")}</div>
<button class="cta a" style="--d:4" type="button" data-ir="s-hora">Elegir día y hora</button>`);
  const hora = pant("hora", "claro", 1, "Elige día y hora", `${encab(esc(t.eti), esc(t.titulo2))}
<p class="rot a" style="--d:2">Día</p>
<div class="dias a" style="--d:2">${dias.map((f, i) => `<button class="dia${i ? "" : " on"}" type="button" data-dia="${esc(nom(f))} ${esc(num(f))}" aria-pressed="${i ? "false" : "true"}"><small>${esc(nom(f))}</small><b>${esc(num(f))}</b></button>`).join("")}</div>
<p class="rot a" style="--d:3">Hora</p>
<div class="horas a" style="--d:3">${(d.horas || ["10:00", "11:00", "12:30", "16:00", "17:00", "18:30"])
    .map((h, i) => `<button class="hora${i === 1 ? " on" : ""}${i === 2 ? " ocupada" : ""}" type="button" data-hora="${h}" aria-pressed="${i === 1 ? "true" : "false"}"${i === 2 ? " disabled" : ""}>${h}</button>`)
    .join("")}</div>
<button class="cta a" style="--d:4" type="button" data-demo="cita">${ico("cal")} ${esc(t.confirmar)}</button>`);
  return servicio + "\n" + hora;
}

function sPlanes(d) {
  const titulo = d.palabraSello === "lavados" ? "Servicios" : "Planes";
  return pant("planes", "claro", 1, titulo, `${encab("Precios claros", titulo)}
<div class="lista a" style="--d:2">${d.planes.map(([n, desc, pr], i) => item(n, desc, pr, false, i === 1 ? `<span class="top-v">El más pedido</span>` : "")).join("")}</div>
<button class="cta a" style="--d:3" type="button" data-demo="informes">${ico("wa")} Pedir informes</button>`);
}

function sPropiedades(p, d) {
  return pant("props", "claro", 1, "Propiedades", `${encab("", "Propiedades")}
<div class="tabs a" style="--d:2"><button class="tab on" type="button" aria-pressed="true">Todas</button><button class="tab" type="button" aria-pressed="false">Venta</button><button class="tab" type="button" aria-pressed="false">Renta</button></div>
<div class="lista a" style="--d:3">${d.items.map(([n, desc, pr]) => item(n, `${desc}${p.colonia ? ` · ${p.colonia}` : ""}`, pr, false)).join("")}</div>
<button class="cta a" style="--d:4" type="button" data-demo="informes">${ico("cal")} Agendar una visita</button>`);
}

function sServicios(d) {
  const ts = { eti: "", titulo: "Servicios", cotizaEti: "Sin compromiso", cotizaTitulo: "Cotiza aquí", cotizaQue: "¿Qué necesitas?", ...(d.textosServicios || {}) };
  const servicios = pant("servicios", "claro", 1, ts.titulo, `${encab(esc(ts.eti), esc(ts.titulo))}
<div class="lista a" style="--d:2">${d.items.map(([n, desc]) => item(n, desc, null, false)).join("")}</div>`);
  const resenas = pant("resenas", "claro", 1, "Reseñas", `${encab("Reseñas de ejemplo", "Lo que dicen")}
<div class="resenas a" style="--d:2">${[
    ["Muy buena atención y cumplieron.", "Laura G."],
    ["Respondieron rápido y el precio fue justo.", "Carlos M."],
    ["Muy profesionales, los recomiendo.", "Ana R."],
  ]
    .map(([t, a]) => `<div class="resena"><div class="estrellas">${ico("star", 14).repeat(5)}</div><p>${esc(t)}</p><small>${esc(a)}</small></div>`)
    .join("")}</div>`);
  const cotiza = pant("cotiza", "claro", 1, "Cotiza", `${encab(esc(ts.cotizaEti), esc(ts.cotizaTitulo))}
<div class="form a" style="--d:2"><input placeholder="Tu nombre" aria-label="Tu nombre" autocomplete="name"><input placeholder="WhatsApp" aria-label="WhatsApp" type="tel" inputmode="tel" autocomplete="tel"><input placeholder="${esc(ts.cotizaQue)}" aria-label="${esc(ts.cotizaQue)}"></div>
<button class="cta a" style="--d:3" type="button" data-demo="cotizacion">${ico("wa")} Pedir cotización</button>`);
  return [servicios, resenas, cotiza].join("\n");
}

function sEscuela(d) {
  return pant("inscripcion", "claro", 1, "Inscripciones", `${encab("Inscripciones abiertas", "Elige tu curso")}
<div class="lista a" style="--d:2">${d.items.map(([n, desc]) => item(n, desc, null, false)).join("")}</div>
<div class="form a" style="--d:3"><input placeholder="Nombre del alumno" aria-label="Nombre del alumno"><input placeholder="WhatsApp" aria-label="WhatsApp" type="tel" inputmode="tel" autocomplete="tel"></div>
<button class="cta a" style="--d:4" type="button" data-demo="inscripcion">${ico("wa")} Quiero informes</button>`);
}

/** Las pantallas de "su página" según el tipo de negocio. */
/** "El lugar": mosaico de 3 fotos (las reales del negocio si las hay) con movimiento lento. */
function sAmbiente(p, d, fotos, reales, lugar = null) {
  if (fotos.length < 3) return "";
  const chips = ({ menu: ["Para llevar", "A domicilio", "Pago con tarjeta"], cafe: ["Para llevar", "Wi-Fi", "Pago con tarjeta"], catalogo: ["Envíos", "Apartados", "Pago con tarjeta"] }[d.tipo]) || ["Atención personal", "Pago con tarjeta", "Estacionamiento"];
  const titulo = lugar?.titulo ? [lugar.eti || "", lugar.titulo, lugar.texto || ""] : reales ? ["", "Así se ve lo tuyo", "Tomadas de tu página: así de bien se verían."] : ["", "Que se antoje venir", "Con tus fotos, se ve como es."];
  if (lugar?.chips) chips.splice(0, chips.length, ...lugar.chips);
  return pant("lugar", "oscuro", 1, "El lugar", `${encab(...titulo.map((x) => esc(x)))}
<div class="mosaico a" style="--d:2">${fotos.slice(0, 3).map((u, i) => `<figure class="mz mz${i}"><img src="${esc(u)}" alt="" loading="lazy" decoding="async"></figure>`).join("")}</div>
<div class="chips a" style="--d:3">${chips.map((c) => `<span>${ico("check", 14, 2.6)}${esc(c)}</span>`).join("")}</div>`, "lugar");
}

/** "Historia": lo que hace único al negocio (año, una frase y datos reales), si lo investigamos. */
function sHistoria(h) {
  if (!h?.titulo) return "";
  return pant("historia", "marca", 1, "Historia", `${h.anio ? `<p class="anio a" style="--d:0" aria-hidden="true">${esc(h.anio)}</p>` : ""}${encab(esc(h.eti || "Nuestra historia"), esc(h.titulo), h.texto ? esc(h.texto) : "")}
${h.datos?.length ? `<div class="chips claro a" style="--d:3">${h.datos.map((x) => `<span>${ico("check", 14, 2.6)}${esc(x)}</span>`).join("")}</div>` : ""}`, "historia");
}

/** Sello redondo con el nombre del negocio alrededor (cuando no tenemos su logo). */
function sello(p, ini) {
  const texto = `${p.nombre} · ${p.ciudad || "La Laguna"} · `.toUpperCase();
  const veces = Math.max(1, Math.floor(62 / texto.length));
  return `<div class="mono sello a" style="--d:1" aria-hidden="true"><svg viewBox="0 0 120 120" width="88" height="88"><defs><path id="circ" d="M60 60m-46 0a46 46 0 1 1 92 0a46 46 0 1 1-92 0"/></defs><circle cx="60" cy="60" r="58" fill="var(--c-f)"/><circle cx="60" cy="60" r="35" fill="none" stroke="#ffffff66" stroke-width="1"/><g class="anillo"><text fill="#fff" font-size="10.5" font-weight="700" letter-spacing="2.2"><textPath href="#circ">${esc(texto.repeat(veces))}</textPath></text></g><text x="60" y="68" text-anchor="middle" fill="#fff" font-size="24" font-weight="800" font-family="Bricolage Grotesque,sans-serif">${ini}</text></svg></div>`;
}

function pantallasNegocio(p, d) {
  // marca.perfil.platos: fotos reales de SUS platillos (en el orden de los primeros del menú).
  const platos = d.platos?.length ? d.platos : fotosDe(d.id).platos || [];
  const sellos = d.sellos ? sTarjeta(p, d) : "";
  switch (d.tipo) {
    case "menu":
      return [sDestacados(Object.values(d.cats).flat(), platos, "Menú"), sMenu(d), sellos];
    case "cafe":
      return [sellos, sDestacados(Object.values(d.cats).flat(), platos, "Menú"), sMenu(d)];
    case "catalogo":
      return [sDestacados(d.items, platos, "Catálogo"), sCatalogo(d), sellos];
    case "citas":
      return [sCitas(d), d.items ? sServicios(d) : "", sellos];
    case "fidelidad":
      return [sellos, sPlanes(d)];
    case "inmobiliaria":
      return [sPropiedades(p, d)];
    case "servicios":
      return [sServicios(d)];
    case "escuela":
      return [sEscuela(d)];
    default:
      return [];
  }
}

function sIA(p, d) {
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
  return pant("ia", "marca", 1, "Asistente de IA", `${encab("En tu WhatsApp", "Asistente de IA")}
<div class="ia-cab a" style="--d:2"><div class="orbe" aria-hidden="true"></div><div><b>Asistente de ${esc(p.nombre)}</b><small><i></i>En línea, contesta en segundos</small></div></div>
<div class="chat a" style="--d:3">
${conv.map((t, i) => `<div class="burbuja ${i % 2 ? "yo" : "ellos"}">${i % 2 ? ico("bot", 14) + " " : ""}${esc(t)}</div>`).join("\n")}</div>
<p class="mini a" style="--d:4">Contesta, agenda y te avisa, a cualquier hora.</p>`);
}

/** "Así se ve como app": el ícono del negocio en la pantalla de inicio del cliente. */
function sApp(p) {
  const fondo = Array.from({ length: 11 }, (_, i) => (i === 4 ? `<i class="mio">${esc(iniciales(p.nombre))}</i>` : "<i></i>")).join("");
  return pant("app", "claro", 1, "Tu app", `${encab("Tu app", "En el celular de tus clientes")}
<div class="app-fila a" style="--d:2"><div class="cel" aria-hidden="true">${fondo}</div>
<ul class="oks"><li>${ico("check")}Sin Play Store ni App Store</li><li>${ico("check")}Tu logo siempre a la vista</li><li>${ico("check")}Avisos de promociones</li></ul></div>
<button class="cta a" style="--d:3" type="button" data-instalar>${ico("app")} Agregar a inicio</button>
<p class="listo-msg" data-instalado hidden role="status">¡Listo! Ya está en su pantalla de inicio.</p>`);
}

/** "Video" animado de cómo funciona, adaptado al tipo de negocio (4 escenas en un celular). */
function video(p, d) {
  const tipo = d.tipo === "citas" ? "cita" : ["menu", "cafe", "catalogo"].includes(d.tipo) ? "pedido" : d.tipo === "fidelidad" && d.sellos ? "sellos" : "informes";
  const fuente = d.servicios || d.items || d.planes || (d.cats ? Object.values(d.cats).flat() : []);
  // Hoteles: el cliente no "pide", reserva (una habitación, con llegada y noches).
  const R = tipo === "pedido" && !!d.reservas;
  let filas = fuente.slice(0, 3).map((x) => [x[0], typeof x[2] === "number" || (typeof x[2] === "string" && /\$/.test(x[2])) ? x[2] : null]);
  if (!filas.length) filas = [["Informes", null], ["Horarios", null], ["Ubicación", null]];
  const elegidos = tipo === "pedido" && !R ? filas.slice(0, 2) : filas.slice(0, 1);
  const total = elegidos.reduce((a, [, pr]) => a + (typeof pr === "number" ? pr : 0), 0);
  const nom = esc(p.nombre), ini = esc(iniciales(p.nombre));
  const dom = (String(p.nombre).normalize("NFD").replace(/[^A-Za-z0-9]/g, "").toLowerCase().slice(0, 16) || "tunegocio") + ".com";
  const caps = {
    pedido: R
      ? ["Tu huésped abre tu link", "Elige su habitación", "Toca «Reservar» y listo", "Te llega la reserva, sin comisión"]
      : ["Tu cliente abre tu link", "Elige con fotos y precios", "Toca «Enviar pedido» y listo", "Te llega ordenado a tu WhatsApp"],
    cita: ["Tu cliente abre tu link", "Elige servicio y hora libre", "Confirma en un toque", "Te llega el aviso y a él su recordatorio"],
    sellos: ["Abre tu link o escanea tu código", "Guarda su tarjeta en el celular", "Cada visita suma un sello", "Le llega su premio y tus promos"],
    informes: ["Te encuentra en Google", "Ve tus servicios y tu información", "Te escribe con un toque", "Te llega su mensaje con sus datos"],
  }[tipo];
  const precio = (pr) => (pr == null ? "" : `<span>${dinero(pr)}</span>`);
  const s1 = `<div class="v-url">${ico("globe", 11)}<span class="v-tip" style="--n:${dom.length}">${esc(dom)}</span></div>
<div class="v-hero"${fotosDe(d.id).portada ? ` style="background:linear-gradient(#0000 20%,#000000b3),url(${fotosDe(d.id).portada}) center/cover"` : ""}><i>${ini}</i><b>${nom}</b><small>Abierto ahora</small></div><div class="v-esq">${filas.map(([n]) => `<i>${esc(n)}</i>`).join("")}</div>`;
  const sellosHtml = (extra) => {
    const s = d.sellos || { total: 8, llevas: 5, premio: "un regalo" };
    const llevas = Math.min(s.llevas, s.total - 1);
    return `<div class="v-tarj"><b>${nom}</b><small>Cliente frecuente</small><div class="v-sellos">${Array.from({ length: s.total }, (_, k) => `<i class="${k < llevas ? "on" : k === llevas && extra ? "on v-nuevo" : ""}">${k < llevas || (k === llevas && extra) ? "✓" : ""}</i>`).join("")}</div>
<small>${extra ? `Llevas ${llevas + 1} de ${s.total}` : `Llevas ${llevas} de ${s.total}`}, premio: ${esc(s.premio)}</small></div>`;
  };
  let s2, s3, msg, quien;
  if (tipo === "sellos") {
    s2 = `${sellosHtml(false)}<div class="v-boton v-negro v-toca">Guardar en mi celular</div><div class="v-ok">Tarjeta guardada ✓</div>`;
    s3 = `${sellosHtml(true)}<div class="v-mas">+1 sello</div>`;
    const s = d.sellos;
    quien = nom;
    const ya = Math.min(s.llevas, s.total - 1) + 1;
    msg = ya >= s.total ? `¡Felicidades! Completaste tu tarjeta y te ganaste ${esc(s.premio)}. Te esperamos para dártelo.` : `¡Gracias por tu visita! Ya llevas ${ya} de ${s.total}. Te faltan ${s.total - ya} para ${esc(s.premio)}.`;
  } else {
    const lista = filas.map(([n, pr], k) => `<div class="v-fila${k < elegidos.length && tipo !== "informes" ? " v-sel" : ""}" style="--k:${k}"><b>${esc(n)}</b>${precio(pr)}<em></em></div>`).join("");
    const horas = tipo === "cita" ? `<div class="v-horas"><i>10:00</i><i class="v-sel" style="--k:2">11:00</i><i>16:00</i></div>` : "";
    const barra = R ? "Reservar" : tipo === "pedido" ? `Ver pedido (${elegidos.length})${total ? ` · ${dinero(total)}` : ""}` : tipo === "cita" ? "Continuar" : "Escribir por WhatsApp";
    const titLista = tipo === "pedido" ? (d.tipo === "catalogo" ? d.textosCatalogo?.titulo || "Catálogo" : "Menú") : tipo === "cita" ? "Agenda tu cita" : "Servicios";
    const fechas = R ? `<div class="v-horas"><i>Llega vie 12</i><i class="v-sel" style="--k:2">2 noches</i></div>` : "";
    s2 = `<div class="v-tit">${esc(titLista)}</div>${lista}${horas}${fechas}<div class="v-barra">${esc(barra)}</div>`;
    const lineas = R
      ? `<div><span>${esc(filas[0][0])}</span></div><div><span>Llegada</span><span>Viernes 12</span></div><div><span>Noches</span><span>2</span></div>`
      : tipo === "pedido"
        ? elegidos.map(([n, pr]) => `<div><span>${esc(n)}</span>${precio(pr)}</div>`).join("") + (total ? `<div class="v-tot"><span>Total</span><span>${dinero(total)}</span></div>` : "")
        : tipo === "cita"
          ? `<div><span>${esc(filas[0][0])}</span></div><div><span>Mañana</span><span>11:00</span></div>`
          : `<div><span>Para: ${nom}</span></div><div><span>“Hola, quiero informes de ${esc(filas[0][0])}”</span></div>`;
    const accion = R ? "Enviar reserva por WhatsApp" : tipo === "pedido" ? "Enviar pedido por WhatsApp" : tipo === "cita" ? "Confirmar cita" : "Enviar mensaje";
    s3 = `<div class="v-tit">${R ? "Tu reserva" : tipo === "pedido" ? "Tu pedido" : tipo === "cita" ? "Tu cita" : "Escríbenos"}</div><div class="v-res">${lineas}</div><div class="v-boton v-toca">${esc(accion)}</div><div class="v-ok">${tipo === "cita" ? "Cita confirmada ✓" : "Enviado ✓"}</div>`;
    quien = tipo === "informes" ? "Ana Ruiz" : tipo === "cita" ? "Juan Pérez" : "María López";
    msg = R
      ? `Nueva reserva
• ${esc(filas[0][0])}
Llegada: viernes 12 · 2 noches
A nombre de: María López`
      : tipo === "pedido"
        ? `Nuevo pedido\n${elegidos.map(([n, pr]) => `• ${esc(n)}${pr ? `  ${dinero(pr)}` : ""}`).join("\n")}${total ? `\nTotal: ${dinero(total)}` : ""}\nEntrega: a domicilio`
        : tipo === "cita"
          ? `Cita confirmada\n${esc(filas[0][0])}\nMañana a las 11:00`
          : `Hola, quiero informes de ${esc(filas[0][0])}.\nMi nombre es Ana Ruiz.`;
  }
  const sist = { pedido: R ? "Reserva directa, sin comisión" : "Pedido recibido, listo para preparar", cita: "Recordatorio programado para Juan", sellos: "Tu tarjeta se actualizó sola", informes: "Nuevo interesado guardado" }[tipo];
  const s4 = `<div class="v-noti"><i>${ico("wa", 14)}</i><div><b>WhatsApp · ahora</b><small>${tipo === "sellos" ? `${nom}: ¡ya casi es tu premio!` : `${esc(quien)}: ${R ? "nueva reserva" : tipo === "pedido" ? "nuevo pedido" : tipo === "cita" ? "nueva cita" : "quiere informes"}`}</small></div></div>
<div class="v-wah"><i>${tipo === "sellos" ? ini : esc(iniciales(quien))}</i><b>${tipo === "sellos" ? nom : esc(quien)}</b></div><div class="v-msg">${msg}</div><div class="v-sist">${sist}</div>`;
  const pantallas = [s1, s2, s3, s4].map((h, k) => `<div class="p-pant${k === 3 ? " v-wa" : ""}${k ? "" : " on"}" data-cap="${esc(caps[k])}" aria-hidden="${k ? "true" : "false"}">${h}</div>`).join("");
  return `<div class="peli a" style="--d:2" data-peli data-notap><div class="p-barras" aria-hidden="true">${"<i><b></b></i>".repeat(4)}</div>
<div class="p-escena"><div class="p-cel">${pantallas}</div></div>
<div class="p-pie"><button class="p-btn" type="button" aria-label="Reproducir"></button><p class="p-cap" aria-live="polite"><span class="p-num">1 / 4</span> <span class="p-txt"></span></p><button class="p-sig" type="button" aria-label="Siguiente paso">${ico("der", 16, 2.4)}</button></div></div>`;
}

/** La propuesta (parte 2): puente, cómo funciona, antes y después, qué incluye y cierre. */
function pantallasPropuesta(p, d, quiero, cfg, fondoPuente) {
  const pedidos = ["menu", "cafe", "catalogo"].includes(d.tipo);
  const cosa = d.tipo === "catalogo" ? "catálogo" : "menú";
  const [antes, despues] =
    d.reservas
      ? [["Reservas por llamada que se pierden", "Pagas comisión por cada noche en las plataformas", "Si no contestas, reservan en otro lado"], ["Reservas directas a tu WhatsApp", "Sin comisiones: la noche completa es tuya", "Tus huéspedes regresan con tu app"]]
      : d.tipo === "citas"
      ? [["Te marcan y no siempre contestas", "Olvidan la cita y pierdes el espacio", "Te buscan en Google y no apareces"], ["Agendan solos, a cualquier hora", "Recordatorio automático", "Apareces en Google con tu página"]]
      : pedidos
        ? [["Pedidos por llamada que se confunden", `Tu ${cosa} es una foto que nadie encuentra`, "Si no contestas, piden en otro lado"], ["Pedidos ordenados a tu WhatsApp", `Tu ${cosa} con fotos y precios`, "Tus clientes regresan con tu app"]]
        : [["Te buscan en Google y no apareces", "Contestas lo mismo una y otra vez", "No tienen cómo volver a encontrarte"], ["Apareces con tu propia página", "Tu información siempre a la mano", "Tu app los invita a regresar"]];
  const li = (xs) => xs.map((x) => `<li>${esc(x)}</li>`).join("");
  const llamada = `${quiero.split("?text=")[0]}?text=${encodeURIComponent(`Hola, vi la propuesta para ${p.nombre}. Prefiero platicarlo en una llamada, ¿cuándo puedes?`)}`;
  const proyectos = ["Barbería Vázquez", "Los Compadres", "KB Huates", "Milea Studio", "Copa Zona Laguna", "TikEduca"];
  const conectada = d.reservas ? "Habitaciones y reservas directas" : d.tipo === "citas" ? "Citas y avisos directo" : pedidos ? "Menú o catálogo con pedidos" : "Mensajes y clientes en orden";
  return [
    conFondo(pant("puente", "oscuro", 2, "La propuesta", `${encab("La propuesta", `Todo esto, listo para <span class="nom">${esc(p.nombre)}</span>`, "Con tus fotos, tus precios y tu logo.")}
<button class="sig-btn a" style="--d:3" type="button" data-ir="s-funciona">Ver cómo funciona</button>`, "puente"), fondoPuente),
    pant("funciona", "oscuro", 2, "Así funciona", `${encab("Así funciona", "4 pasos, cero llamadas")}
${video(p, d)}`),
    pant("vs", "oscuro", 2, "Antes y después", `${encab("", "Así cambia tu día")}
<div class="vs a" style="--d:2" data-vs data-notap>
<div class="vs-tog" role="group" aria-label="Comparar"><button type="button" data-vs-btn="0" aria-pressed="true">Hoy</button><button type="button" data-vs-btn="1" aria-pressed="false">Con lo tuyo</button></div>
<div class="vs-panel">
<div class="vs-lado vs-hoy"><div class="vs-sim">${ico("x", 26, 2.6)}</div><ul>${li(antes)}</ul></div>
<div class="vs-lado vs-con"><div class="vs-sim">${ico("check", 26, 3)}</div><ul>${li(despues)}</ul></div>
</div>
<p class="vs-pista">Toca para comparar</p>
</div>`),
    pant("incluye", "oscuro", 2, "Qué incluye", `${encab("", "Qué incluye")}
<div class="incs">
<div class="inc a" style="--d:2">${ico("globe", 22)}<b>Página web</b><small>Lista para el celular y Google</small></div>
<div class="inc a" style="--d:3">${ico("app", 22)}<b>App instalable</b><small>Tu logo en su celular</small></div>
<div class="inc a" style="--d:4">${ico("wa", 22)}<b>Conectada a tu WhatsApp</b><small>${conectada}</small></div>
</div>
<p class="rot2 a" style="--d:5">En 3 pasos</p>
<ol class="pasos a" style="--d:6"><li>Te visitamos y juntamos tus datos</li><li>Ajustamos el diseño contigo</li><li>Lo publicamos y te enseñamos</li></ol>`),
    pant("cierre", "oscuro", 2, "Quién te atiende", `<p class="eti a" style="--d:0">Quién te atiende</p>
<div class="quien a" style="--d:1"><video src="/presentacion.mp4#t=0.1" controls playsinline preload="metadata"></video></div>
<p class="quien-txt a" style="--d:2"><b>${esc(cfg.remitente.nombre)}</b>, de ${esc(cfg.remitente.ciudad || "Lerdo, Durango")}<br>Diseño, programo y te atiendo en persona.</p>
<a class="cta a" style="--d:3" href="${esc(quiero)}">${ico("wa", 20)} Quiero arrancar</a>
<a class="sec2 a" style="--d:4" href="${esc(llamada)}">Prefiero una llamada primero</a>
<p class="rail-t a" style="--d:5">Proyectos que ya hicimos</p>
<ul class="rail a" style="--d:5">${proyectos.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
<a class="sec3 a" style="--d:6" href="${esc(cfg.remitente.portafolio)}" target="_blank" rel="noopener">Ver más trabajos de ${esc(cfg.remitente.empresa)}</a>
<p class="firma">Hecho por ${esc(cfg.remitente.nombre)} en ${esc(cfg.remitente.empresa)}</p>`, "cierre"),
  ].join("\n");
}

/** HTML completo del boceto de un prospecto: un recorrido a pantalla completa que se desliza como historias. */
/**
 * Las pantallas blancas (servicios, reseñas, cotiza, catálogo, tu app) llevan abajo una foto del
 * negocio (o de su giro) que se desvanece hacia arriba: así no se ven vacías y se siente su lugar.
 * "Lo más pedido" no, porque ya es una galería de fotos.
 */
/** Foto a pantalla completa detrás de una pantalla oscura o de color (Visítanos, La propuesta), con velo para leer. */
function conFondo(html, foto) {
  if (typeof foto !== "string" || !/^https?:\/\//.test(foto)) return html;
  const f = foto.replace(/["'()\\\s]/g, encodeURIComponent);
  return html.replace(/<section class="pant ([a-z]+)"/, (m, c) => `<section class="pant ${c} con-fondo" style="--foto:url('${esc(f)}')"`);
}

function conFoto(html, fotos) {
  const lista = fotos.filter((f) => typeof f === "string" && /^https?:\/\//.test(f));
  if (!lista.length) return html;
  let k = 0;
  return html.replace(/<section class="pant" id="s-([a-z]+)" data-parte="1" data-tono="claro"/g, (m, id) => {
    if (id === "dest") return m;
    const f = lista[k++ % lista.length].replace(/["'()\\\s]/g, encodeURIComponent);
    return m.replace('class="pant"', `class="pant con-foto" style="--foto:url('${esc(f)}')"`);
  });
}

export function renderBoceto(p) {
  const cfg = getProspeccion();
  // marca.perfil ajusta el perfil para UN negocio (textos, servicios, horarios) sin tocar el de su giro.
  const marcaP = marcaDe(p);
  const d = p.perfil || (marcaP?.perfil ? { ...perfilDe(p), ...marcaP.perfil } : perfilDe(p));
  const chip = String(process.env.WA_NUMERO || cfg.remitente.whatsapp || "").replace(/\D/g, "").slice(-10);
  const quiero = `https://wa.me/52${chip}?text=${encodeURIComponent(p.demo ? `Hola, vi la muestra de ${d.nombre.toLowerCase()} y me interesa una para mi negocio.` : `Hola, vi la propuesta que me hicieron para ${p.nombre} y me interesa arrancar.`)}`;
  const mapa = p.lat && p.lon ? `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lon}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${p.nombre} ${p.ciudad || ""}`)}`;
  // "Sombrerete, Sombrerete" no: si la colonia se llama como la ciudad, va una sola vez.
  const lugar = [...new Map([p.colonia, p.ciudad].filter(Boolean).map((x) => [String(x).trim().toLowerCase(), x])).values()].join(", ");
  const tel = String(p.telefono || "").replace(/\D/g, "");
  const accion = d.accion || { menu: "Pedir", cafe: "Pedir", catalogo: "Pedir", citas: "Agendar", fidelidad: "Escribir", inmobiliaria: "Preguntar", escuela: "Informes", servicios: "Cotizar" }[d.tipo] || "Escribir";
  const titulo = `${p.nombre} · muestra de ${d.que}`;
  const marca = marcaDe(p);
  const fs0 = fotosParaNegocio(d.id, p.id ?? p.nombre);
  const reales = (marca?.fotos || []).map((x) => (typeof x === "string" ? x : x.u));
  const fx = { ...fs0, portada: reales[0] || fs0.portada };
  const ambiente = reales.length >= 4 ? reales.slice(1, 4) : reales.length ? [...reales.slice(1), ...fs0.ambiente].slice(0, 3) : fs0.ambiente;
  const ini = esc(iniciales(p.nombre));
  const logoHtml = marca?.logo
    ? `<div class="mono logo-real a" style="--d:1"><img src="${esc(marca.logo)}" alt="Logo de ${esc(p.nombre)}" decoding="async"></div>`
    : sello(p, ini);

  const negocio = pantallasNegocio(p, d).filter(Boolean);
  const primera = (negocio[0] || "").match(/id="(s-[a-z]+)"/)?.[1] || "s-app";
  const visita = conFondo(pant("visita", "marca", 1, "Visítanos", `${encab(esc(lugar || "Encuéntranos"), "Visítanos")}
<p class="dir a" style="--d:2">${esc(p.direccion || lugar || p.nombre)}${p.direccion && lugar ? `<small>${esc(lugar)}</small>` : ""}</p>
<a class="maps a" style="--d:3" href="${esc(mapa)}" target="_blank" rel="noopener">${ico("pin", 20)} Abrir en Google Maps</a>`, "visita").replace('class="pant visita"', `class="pant visita" data-ini="${ini}"`), (ambiente || [])[0] || fx.portada);
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(titulo)}</title><meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="${d.color}">
<meta property="og:title" content="${esc(p.nombre)}"><meta property="og:description" content="Una muestra de ${esc(d.que)} hecha para ${esc(p.nombre)}.">${fx.portada ? `<meta property="og:image" content="${fx.portada}">` : ""}<link rel="preconnect" href="https://images.unsplash.com">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600..800&family=Schibsted+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--c:${colorLegible(d.color)};--bg:#fff;--card:#fff;--tx:#141413;--mu:#5f5f5b;--ln:#e7e6e3;--chip:#f0efec;--c-f:var(--c);--c-t:var(--c);--fd:"Bricolage Grotesque","Schibsted Grotesk",system-ui,sans-serif;--fb:"Schibsted Grotesk",system-ui,sans-serif;--k0:color-mix(in srgb,var(--c-f) 14%,#060708);--k1:color-mix(in srgb,var(--c-f) 18%,#0e1013);--k2:color-mix(in srgb,var(--c-f) 22%,#181b20);--k3:color-mix(in srgb,var(--c-f) 26%,#22262d);--kst:color-mix(in srgb,var(--c-f) 28%,#323843);--kas:#a3abb8;--kfo:#c2c8d2;--kaz:color-mix(in srgb,var(--c) 45%,#fff);--kaz2:var(--kaz);--kb:var(--c-f);--wa:#15803d;--ease:cubic-bezier(.2,.8,.2,1);--rebote:cubic-bezier(.3,1.6,.5,1);--top:calc(env(safe-area-inset-top) + 64px);--bot:calc(env(safe-area-inset-bottom) + 92px);--px:20px}
@media (prefers-color-scheme:dark){:root{--bg:#0c0c0d;--card:#161618;--tx:#f4f4f2;--mu:#a9a9a5;--ln:#2a2a2d;--chip:#222225;--c-t:color-mix(in srgb,var(--c) 55%,#fff)}}
@supports (color:oklch(from red min(l,.5) c h)){
  :root{--c-f:oklch(from var(--c) min(l,.55) c h);--c-t:oklch(from var(--c) min(l,.5) c h);--kaz:oklch(from var(--c) max(l,.82) min(c,.12) h)}
  @media (prefers-color-scheme:dark){:root{--c-f:oklch(from var(--c) clamp(.4,l,.56) c h);--c-t:oklch(from var(--c) max(l,.76) min(c,.16) h)}}
}
[hidden]{display:none!important}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--tx);font:16px/1.5 var(--fb);-webkit-font-smoothing:antialiased;overflow:hidden;overscroll-behavior:none}
button,input{font:inherit;color:inherit}
button{cursor:pointer;-webkit-user-select:none;user-select:none}
:focus-visible{outline:3px solid var(--c-t);outline-offset:3px}
.pant:not([data-tono=claro]) :focus-visible{outline-color:#fff}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
img.cargando{opacity:0}
.ic{flex:none;display:block}

/* ---------- Marco ---------- */
.app{position:relative;width:100%;height:100svh;overflow:hidden;background:var(--bg);--ui:#fff;--uib:#141413}
.app[data-tono=claro]{--ui:var(--tx);--uib:var(--bg)}
@media (min-width:640px) and (min-height:720px){
  body{display:grid;place-items:center;background:radial-gradient(80% 70% at 50% 0%,color-mix(in srgb,var(--c-f) 60%,#000),#08080a 78%)}
  .app{width:430px;height:min(calc(100svh - 48px),920px);border-radius:36px;box-shadow:0 0 0 1px #ffffff1f,0 50px 100px -30px #000}
}

/* ---------- Pantallas ---------- */
.deck{display:flex;width:100%;height:100%;overflow-x:auto;overflow-y:hidden;scroll-snap-type:x mandatory;overscroll-behavior-x:contain;scrollbar-width:none}
.deck::-webkit-scrollbar{display:none}
.pant{position:relative;flex:none;width:100%;height:100%;scroll-snap-align:start;scroll-snap-stop:always;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:none;isolation:isolate;display:flex;flex-direction:column;padding:var(--top) var(--px) var(--bot);background:var(--bg);color:var(--tx);transition:padding-bottom .3s var(--ease)}
.pant::-webkit-scrollbar{display:none}
.pant[data-tono=marca]{background:radial-gradient(120% 70% at 100% 0%,#ffffff2b,transparent 60%),linear-gradient(180deg,transparent 50%,#00000033),var(--c-f);color:#fff}
.pant[data-tono=oscuro]{background:radial-gradient(110% 55% at 100% 0%,color-mix(in srgb,var(--c-f) 45%,transparent),transparent 62%),var(--k0);color:#fff}
.pant[data-tono=foto]{background:var(--c-f);color:#fff;padding:0}
.app.con-pedido[data-parte="1"] .pant:not(.portada){padding-bottom:calc(var(--bot) + 60px)}
.cuerpo{margin-block:auto;width:100%;display:flex;flex-direction:column}

.eti{margin:0 0 10px;font-size:16px;line-height:1.3;font-weight:600;color:var(--c-t)}
.pant[data-tono=marca] .eti{color:#ffffffe0}
.pant[data-tono=oscuro] .eti{color:var(--kaz2)}
.t{margin:0;font:800 clamp(40px,11.6vw,58px)/.94 var(--fd);letter-spacing:-.045em;text-wrap:balance;overflow-wrap:anywhere}
.baj{margin:12px 0 0;font-size:17px;line-height:1.4;color:var(--mu);max-width:30ch}
.pant[data-tono=marca] .baj{color:#ffffffe6}
.pant[data-tono=oscuro] .baj{color:var(--kfo)}
.rot{margin:22px 0 10px;font-size:15px;font-weight:600;color:var(--mu)}
.mini{margin:16px 0 0;font-size:15px;line-height:1.45;color:var(--mu)}
.pant[data-tono=marca] .mini{color:#ffffffe0}

/* ---------- Encabezado y progreso ---------- */
.cab{position:absolute;z-index:6;top:0;left:0;right:0;padding:calc(env(safe-area-inset-top) + 10px) 14px 0;color:var(--ui);pointer-events:none;transition:color .3s}
.prog{display:flex;gap:4px}
.prog i{flex:1;height:3px;border-radius:3px;background:color-mix(in srgb,var(--ui) 28%,transparent);overflow:hidden;transition:background .3s}
.prog i.corte{margin-left:8px}
.prog b{display:block;height:100%;background:var(--ui);transform:scaleX(0);transform-origin:left;transition:transform .35s var(--ease),background .3s}
.prog i.ya b,.prog i.ahora b{transform:none}
.cab-fila{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:10px;font-size:12px;font-weight:700}
.cab-parte{font-size:13px}
.cab-muestra{padding:4px 10px;border-radius:99px;background:color-mix(in srgb,var(--ui) 15%,transparent);font-weight:600;transition:background .3s}

/* ---------- Barra inferior ---------- */
.dock{position:absolute;z-index:6;left:0;right:0;bottom:0;display:grid;grid-template-columns:48px 1fr 48px;gap:12px;align-items:center;padding:12px 16px calc(env(safe-area-inset-bottom) + 16px);pointer-events:none}
.dock>*{pointer-events:auto}
.nav{width:48px;height:48px;border-radius:50%;display:grid;place-items:center;border:1.5px solid color-mix(in srgb,var(--ui) 35%,transparent);background:color-mix(in srgb,var(--uib) 25%,transparent);color:var(--ui);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);transition:opacity .2s,transform .15s var(--ease),color .3s,border-color .3s,background .3s}
.nav:disabled{opacity:0;pointer-events:none}
.nav:active{transform:scale(.9)}
.dock-cta{display:flex;align-items:center;justify-content:center;gap:10px;height:52px;border-radius:99px;background:var(--ui);color:var(--uib);font-weight:800;font-size:16px;text-decoration:none;white-space:nowrap;box-shadow:0 14px 30px -14px #000000b3;transition:background .3s,color .3s,transform .15s var(--ease),opacity .25s}
.dock-cta .ic{color:var(--wa)}
.app[data-tono=claro] .dock-cta .ic{color:#22c55e}
.dock-cta:active{transform:scale(.96)}
.app[data-ultima] .dock-cta{opacity:0;pointer-events:none}

.bolsa{position:absolute;z-index:6;left:50%;bottom:calc(env(safe-area-inset-bottom) + 80px);transform:translateX(-50%);display:flex;align-items:center;gap:10px;min-height:48px;padding:0 18px 0 8px;border-radius:99px;border:1px solid #ffffff2e;background:#141413;color:#fff;font-weight:700;font-size:15px;white-space:nowrap;box-shadow:0 16px 32px -14px #000000cc}
.bolsa .n{min-width:32px;height:32px;padding:0 8px;border-radius:99px;background:var(--c-f);display:grid;place-items:center;font-variant-numeric:tabular-nums}
.app[data-parte="2"] .bolsa{display:none}

/* ---------- Portada ---------- */
.portada .fondo{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:-2}
.portada:after{content:"";position:absolute;inset:0;z-index:-1;pointer-events:none;background:linear-gradient(180deg,#000000a6 0%,#0000 24%,#0000 38%,#000000c2 70%,#000000f0 100%),radial-gradient(120% 60% at 0% 100%,color-mix(in srgb,var(--c) 55%,transparent),transparent 70%)}
.p-in{display:flex;flex-direction:column;min-height:100%;padding:var(--top) var(--px) var(--bot)}
.sello{margin:0;align-self:center;font-size:12px;line-height:1.35;padding:6px 12px;border-radius:99px;background:#0000006b;border:1px solid #ffffff2e;-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);text-align:center;max-width:34ch;color:#fffffff0}
.sello b{color:#fff}
.mono{margin-top:auto;width:60px;height:60px;border-radius:18px;background:var(--c-f);display:grid;place-items:center;font:800 20px/1 var(--fd);box-shadow:0 0 0 2px #ffffff80,0 14px 28px -10px #000;margin-bottom:18px}
.mono.logo-real{width:auto;height:auto;max-width:180px;padding:0;background:none;box-shadow:none;border-radius:0}
.mono.logo-real img{display:block;max-width:180px;max-height:96px;width:auto;height:auto;filter:drop-shadow(0 6px 18px #0009)}
.mono.sello{width:88px;height:88px;padding:0;background:none;border-radius:50%;box-shadow:0 14px 28px -10px #000}
.mono.sello svg{display:block}
.portada h1{margin:0;font:800 clamp(54px,16.5vw,92px)/.88 var(--fd);letter-spacing:-.05em;text-wrap:balance;overflow-wrap:anywhere;text-shadow:0 2px 30px #00000040}
.meta{margin:14px 0 0;display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;font-size:15px;color:#fffffff0}
.ab{display:inline-flex;align-items:center;gap:7px;font-weight:700;color:#bbf7d0}
.ab:before{content:"";width:8px;height:8px;border-radius:50%;background:#4ade80;box-shadow:0 0 0 3px #4ade8040}
.acciones{display:flex;gap:10px;margin-top:22px}
.acc{display:inline-flex;align-items:center;justify-content:center;gap:10px;height:58px;border-radius:99px;padding:0 24px;border:1px solid #ffffff38;background:#ffffff24;-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);color:#fff;font-weight:800;font-size:18px;text-decoration:none;flex:none;transition:transform .15s var(--ease),background .2s}
.acc.pri{flex:1;background:var(--c-f);border-color:color-mix(in srgb,var(--c-f) 60%,#fff);box-shadow:0 16px 32px -14px #000000cc}
.acc.redondo{width:58px;padding:0}
.acc:active{transform:scale(.95)}
.pista{margin:16px 0 0;display:flex;align-items:center;gap:6px;font-size:14px;font-weight:600;color:#ffffffcc}

/* ---------- Lo más pedido ---------- */
.mosaico{display:grid;grid-template-columns:1.25fr 1fr;grid-template-rows:1fr 1fr;gap:8px;height:min(46svh,440px);margin-top:20px}
.mz{margin:0;border-radius:20px;overflow:hidden;background:var(--k2)}.mz0{grid-row:1/3}
.mz img{width:100%;height:100%;object-fit:cover;display:block}
.anio{margin:0 0 -6px;font:800 clamp(88px,30vw,150px)/.85 var(--fd);letter-spacing:-.06em;color:#ffffff38}
.chips.claro span{background:#ffffff26;color:#fff}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
.chips span{display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border-radius:99px;background:#ffffff14;color:var(--kfo);font-size:13.5px;font-weight:600}
.galeria{--gh:min(42svh,420px);position:relative;width:min(100%,calc(var(--gh) * .8));aspect-ratio:4/5;margin:20px auto 0;border-radius:28px;overflow:hidden;background:var(--chip);box-shadow:0 30px 50px -30px #000000b3;cursor:pointer}
.g-item{position:absolute;inset:0;margin:0;opacity:0;visibility:hidden;transition:opacity .35s,visibility .35s}
.g-item.on{opacity:1;visibility:visible}
.g-item img{width:100%;height:100%;object-fit:cover;display:block}
.g-item:after{content:"";position:absolute;inset:auto 0 0;height:55%;background:linear-gradient(#0000,#000000d9);pointer-events:none}
.g-item figcaption{position:absolute;z-index:1;left:18px;right:84px;bottom:18px;color:#fff;display:flex;flex-direction:column;gap:6px}
.g-item figcaption b{font:800 32px/1 var(--fd);letter-spacing:-.03em}
.g-item .precio{color:#fff;font-size:19px}
.g-item .mas{position:absolute;z-index:2;right:16px;bottom:16px;width:58px;height:58px;background:#fff;color:#111;font-size:30px;box-shadow:0 10px 24px -8px #00000099}
.g-sel{display:flex;justify-content:center;gap:8px;margin-top:16px;flex-wrap:wrap}
.g-sel button{min-height:44px;padding:0 18px;border:0;border-radius:99px;background:var(--chip);font-weight:700;font-size:15px;color:var(--tx);transition:background .2s,color .2s}
.g-sel button.on{background:var(--c-f);color:#fff}

/* ---------- Menú / catálogo ---------- */
.tabs{display:flex;gap:8px;margin-top:22px;overflow-x:auto;scrollbar-width:none}.tabs::-webkit-scrollbar{display:none}
.tab{border:0;min-height:44px;padding:0 18px;border-radius:99px;background:var(--chip);font-weight:700;font-size:15px;white-space:nowrap;color:var(--tx);transition:background .2s,color .2s,transform .15s var(--ease)}
.tab.on{background:var(--c-f);color:#fff}
.tab:active{transform:scale(.95)}
.lista{margin-top:6px}
.item{display:flex;align-items:center;gap:14px;padding:14px 0;border-bottom:1px solid var(--ln)}.item:last-child{border-bottom:0}
.info{flex:1;min-width:0;display:grid;grid-template-columns:1fr auto;column-gap:12px;row-gap:2px;align-items:baseline}
.info b{font-size:18px;font-weight:700;line-height:1.25;letter-spacing:-.01em;min-width:0}
.info small{grid-column:1/-1;color:var(--mu);font-size:14.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.info .precio{grid-column:2;grid-row:1}
.precio{font-weight:800;font-size:18px;font-variant-numeric:proportional-nums;white-space:nowrap}
.mas{flex:none;width:48px;height:48px;border-radius:50%;border:0;background:var(--tx);color:var(--bg);font-size:26px;line-height:1;display:grid;place-items:center;transition:transform .15s var(--ease),background .2s,color .2s}
.mas:active{transform:scale(.88)}
.mas.listo{background:var(--c-f);color:#fff}
.pant.con-foto:before{content:"";position:absolute;left:0;right:0;bottom:0;height:36%;z-index:-1;pointer-events:none;background:var(--foto) center 40%/cover no-repeat;opacity:.6;-webkit-mask-image:linear-gradient(transparent,#000 75%);mask-image:linear-gradient(transparent,#000 75%)}
.cat{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:20px}
.tile{min-width:0;display:flex;flex-direction:column;gap:2px;min-height:124px;padding:14px;border-radius:20px;background:var(--card);border:1.5px solid var(--ln)}
.tile .precio{font-size:17px;min-width:0;line-height:1.15}
.tile .precio .u{display:block;margin-left:0}
.precio .u{font-size:.72em;font-weight:600;color:var(--mu);margin-left:2px;letter-spacing:0}
.g-item .precio .u{color:#ffffffc7}
.tile b{font-size:16px;line-height:1.2;font-weight:700;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.tile small{color:var(--mu);font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tile-pie{margin-top:auto;padding-top:8px;display:flex;align-items:center;justify-content:space-between;gap:8px}
.tile .mas{width:44px;height:44px;font-size:24px}

/* ---------- Tarjeta de cliente frecuente ---------- */
.wallet{position:relative;overflow:hidden;isolation:isolate;margin-top:22px;border-radius:28px;padding:22px;color:#fff;background:linear-gradient(150deg,color-mix(in srgb,var(--c-f) 88%,#fff),color-mix(in srgb,var(--c-f) 40%,#000));box-shadow:0 30px 50px -28px #000000b3,inset 0 1px 0 #ffffff40}
.wallet:before{content:"";position:absolute;z-index:-1;width:260px;height:260px;right:-100px;top:-130px;border-radius:50%;border:44px solid #ffffff14;pointer-events:none}
.w-top{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.w-top b{font:800 22px/1.1 var(--fd);letter-spacing:-.02em;overflow-wrap:anywhere}
.w-top span{flex:none;font-size:13px;font-weight:600;opacity:.92}
.sellos{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin:22px 0 18px}
.sellos i{aspect-ratio:1;border-radius:50%;border:2px dashed #ffffff8c;display:grid;place-items:center}
.sellos i.on{background:#fff;color:var(--c-f);border:0}
.w-pie{display:grid;gap:2px}
.w-pie span{font-size:15px;opacity:.92}
.w-pie b{font:800 20px/1.15 var(--fd);letter-spacing:-.02em}
.w-sellar{margin-top:18px;width:100%;min-height:52px;border:0;border-radius:99px;background:#fff;color:#141413;font-weight:800;font-size:16px;display:flex;align-items:center;justify-content:center;gap:8px;transition:transform .15s var(--ease)}
.w-sellar:active{transform:scale(.96)}
.w-sellar:disabled{opacity:.75;cursor:default}
.botones2{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}
.b2{min-height:48px;border:0;border-radius:99px;background:var(--chip);color:var(--tx);font-weight:700;font-size:15px}

/* ---------- Citas ---------- */
.servs{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:22px}
.serv{position:relative;text-align:left;min-height:112px;border:1.5px solid var(--ln);border-radius:22px;background:var(--card);color:var(--tx);padding:16px;display:flex;flex-direction:column;justify-content:flex-end;gap:4px;transition:background .2s,border-color .2s,color .2s,transform .15s var(--ease)}
.serv:after{content:"";position:absolute;top:14px;right:14px;width:22px;height:22px;border-radius:50%;border:2px solid color-mix(in srgb,var(--tx) 28%,transparent);transition:border .2s}
.serv b{display:block;font:800 19px/1.1 var(--fd);letter-spacing:-.02em;padding-right:24px}
.serv small{display:flex;align-items:center;gap:5px;color:var(--mu);font-size:13.5px}
.serv.on{background:var(--c-f);border-color:var(--c-f);color:#fff}
.serv.on small{color:#ffffffe6}
.serv.on:after{border:6px solid #fff}
.serv:active{transform:scale(.97)}
.dias{display:grid;grid-template-columns:repeat(6,1fr);gap:6px}
.dia{min-height:72px;border:1.5px solid var(--ln);border-radius:18px;background:var(--card);color:var(--tx);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;padding:0;transition:background .2s,border-color .2s}
.dia small{display:block;font-size:12px;color:var(--mu);text-transform:capitalize}
.dia b{display:block;font:800 22px/1 var(--fd)}
.dia.on{background:var(--c-f);border-color:var(--c-f);color:#fff}.dia.on small{color:#ffffffe6}
.horas{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.hora{min-height:48px;border:1.5px solid var(--ln);border-radius:99px;background:var(--card);color:var(--tx);font-weight:700;font-variant-numeric:tabular-nums;transition:background .2s,border-color .2s}
.hora.on{background:var(--c-f);border-color:var(--c-f);color:#fff}
.hora.ocupada{opacity:.4;text-decoration:line-through;cursor:not-allowed}
.cta{width:100%;margin-top:22px;min-height:58px;padding:0 24px;border:0;border-radius:99px;background:var(--c-f);color:#fff;font-weight:800;font-size:17px;display:flex;align-items:center;justify-content:center;gap:10px;text-decoration:none;box-shadow:0 16px 30px -16px color-mix(in srgb,var(--c-f) 85%,#000),inset 0 1px 0 #ffffff33;transition:transform .15s var(--ease),background .2s}
.cta:active{transform:scale(.97)}

/* ---------- Asistente ---------- */
.ia-cab{display:flex;gap:12px;align-items:center;margin-top:20px}
.orbe{width:52px;height:52px;border-radius:50%;flex:none;background:radial-gradient(circle at 35% 30%,#fff 0,#ffffff00 58%),conic-gradient(from 0deg,#fff,color-mix(in srgb,var(--c) 35%,#fff),#ffffff80,#fff);box-shadow:0 0 0 3px #ffffff40}
.ia-cab b{display:block;font-size:16px}
.ia-cab small{display:flex;align-items:center;gap:6px;font-size:13.5px;color:#ffffffe0}
.ia-cab small i{width:8px;height:8px;border-radius:50%;background:#4ade80;flex:none}
.chat{margin-top:16px;display:flex;flex-direction:column;gap:8px;background:#efeae2;color:#111;border-radius:24px;padding:16px 12px;box-shadow:0 30px 50px -30px #000000b3}
.burbuja{max-width:86%;padding:9px 12px;border-radius:14px;font-size:15px;line-height:1.4;box-shadow:0 1px 1px #0000001a}
.burbuja .ic{display:inline;vertical-align:-2px;color:#128c7e}
.ellos{align-self:flex-start;background:#fff;border-top-left-radius:4px}
.yo{align-self:flex-end;background:#d9fdd3;border-top-right-radius:4px}

/* ---------- Tu app ---------- */
.app-fila{display:grid;grid-template-columns:auto 1fr;gap:20px;align-items:center;margin-top:24px}
.cel{width:124px;aspect-ratio:9/17;border-radius:26px;border:5px solid #141414;background:linear-gradient(180deg,color-mix(in srgb,var(--c) 40%,#1e1e24),#0f0f12);padding:16px 10px;display:grid;grid-template-columns:repeat(3,1fr);gap:9px;align-content:start;box-shadow:0 30px 50px -28px #000}
.cel i{aspect-ratio:1;border-radius:8px;background:#ffffff1f}
/* Íconos de colores, como un celular de verdad (sin marcas): así no se ve vacío. */
.cel i:nth-child(6n+1){background:linear-gradient(160deg,#5ac8fa,#2f7cf6)}.cel i:nth-child(6n+2){background:linear-gradient(160deg,#ffd166,#f59f00)}
.cel i:nth-child(6n+3){background:linear-gradient(160deg,#8ce99a,#2f9e44)}.cel i:nth-child(6n+4){background:linear-gradient(160deg,#f783ac,#d6336c)}
.cel i:nth-child(6n+5){background:linear-gradient(160deg,#b197fc,#7048e8)}.cel i:nth-child(6n){background:linear-gradient(160deg,#ced4da,#868e96)}
.cel i:not(.mio){opacity:.55}
.cel i.mio{display:grid;place-items:center;background:color-mix(in srgb,var(--c) 30%,transparent);color:#ffffffd9;outline:2px dashed #ffffffb3;outline-offset:-2px;font-style:normal;font-weight:800;font-size:11px}
.cel.instalada i.mio{background:var(--c-f);color:#fff;outline:0;box-shadow:0 0 0 2px #ffffff8c}
.oks{list-style:none;margin:0;padding:0;display:grid;gap:14px}
.oks li{display:flex;gap:10px;align-items:flex-start;font-size:16px;font-weight:600;line-height:1.3}
.oks .ic{color:#16a34a;margin-top:1px}
@media (prefers-color-scheme:dark){.oks .ic{color:#4ade80}}
.listo-msg{margin:12px 0 0;text-align:center;font-weight:700;color:var(--c-t)}

/* ---------- Visítanos ---------- */
.pant.con-fondo:after{content:"";position:absolute;inset:0;z-index:-2;pointer-events:none;background:var(--velo),var(--foto) center/cover no-repeat}
.visita.con-fondo{--velo:linear-gradient(180deg,color-mix(in srgb,var(--c-f) 50%,transparent),color-mix(in srgb,var(--c-f) 88%,transparent) 50%,var(--c-f) 85%)}
.puente.con-fondo{--velo:linear-gradient(180deg,color-mix(in srgb,var(--k0) 50%,transparent),color-mix(in srgb,var(--k0) 88%,transparent) 42%,var(--k0) 70%)}
.visita .t{font-size:clamp(56px,17vw,92px)}
.visita:before{content:attr(data-ini);position:absolute;right:-20px;bottom:60px;z-index:-1;font:800 260px/1 var(--fd);letter-spacing:-.06em;color:#ffffff17;pointer-events:none}
.dir{margin:20px 0 0;font:600 clamp(24px,7vw,32px)/1.15 var(--fd);letter-spacing:-.02em}
.dir small{display:block;margin-top:8px;font:500 17px/1.3 var(--fb);letter-spacing:0;color:#ffffffe6}
.maps{align-self:flex-start;display:inline-flex;align-items:center;gap:10px;margin-top:28px;height:58px;padding:0 26px;border-radius:99px;background:#fff;color:#111;font-weight:800;font-size:17px;text-decoration:none;box-shadow:0 14px 28px -14px #00000099;transition:transform .15s var(--ease)}
.maps:active{transform:scale(.96)}

/* ---------- Propuesta ---------- */
.puente .t{font-size:clamp(46px,13.5vw,72px)}
.nom{color:var(--kaz2);overflow-wrap:anywhere}
.sig-btn{margin-top:28px;align-self:flex-start;display:inline-flex;align-items:center;gap:10px;min-height:52px;padding:0 22px;border-radius:99px;border:1.5px solid #ffffff40;background:transparent;color:#fff;font-weight:700;font-size:16px;transition:background .2s,transform .15s var(--ease)}
.sig-btn:active{transform:scale(.96)}

/* Así funciona */
.peli{margin-top:6px}
.p-barras{display:flex;gap:4px;margin-bottom:12px}.p-barras i{flex:1;height:3px;border-radius:3px;background:var(--kst);overflow:hidden}
.p-barras b{display:block;height:100%;background:#fff;transform:scaleX(0);transform-origin:left}.p-barras .ya b{transform:none}
.p-barras .ahora b{animation:p-barra 4.6s linear forwards}@keyframes p-barra{to{transform:none}}
.peli:not(.corre) .ahora b,.peli:not(.corre) .p-pant *,.peli:not(.corre) .p-pant{animation-play-state:paused!important}
.p-escena{position:relative;height:min(48svh,400px);border-radius:24px;border:1px solid var(--k2);background:radial-gradient(55% 65% at 50% 45%,color-mix(in srgb,var(--c-f) 40%,transparent),transparent 72%),radial-gradient(var(--k3) 1px,transparent 1.4px) 0 0/16px 16px,var(--k1);overflow:hidden;display:flex;justify-content:center;padding-top:20px;cursor:pointer}
.p-escena:after{content:"";position:absolute;inset:auto 0 0;height:80px;background:linear-gradient(transparent,var(--k1));pointer-events:none}
.p-cel{position:relative;width:200px;height:380px;flex:none;border-radius:32px;border:7px solid #2b2f37;background:#f6f5f3;overflow:hidden;box-shadow:0 0 0 1px var(--kst),0 30px 60px -20px #000}
.p-pant{position:absolute;inset:0;padding:12px 10px;display:flex;flex-direction:column;gap:7px;font-size:11px;line-height:1.35;color:#18181b;background:#f6f5f3;opacity:0;visibility:hidden;transition:opacity .35s,visibility .35s}
.p-pant.on{opacity:1;visibility:visible}
.p-pie{display:flex;align-items:center;gap:12px;margin-top:14px}
.p-btn,.p-sig{flex:none;width:44px;height:44px;border-radius:50%;display:grid;place-items:center;color:#fff;transition:transform .15s var(--ease)}
.p-btn{background:var(--kb);border:0}.p-sig{background:transparent;border:1px solid var(--kst)}
.p-btn:active,.p-sig:active{transform:scale(.9)}
.p-cap{flex:1;margin:0;font-size:15px;line-height:1.3;font-weight:600;min-height:2.6em;display:flex;align-items:center;gap:10px}
.p-num{flex:none;font-size:11px;font-weight:700;letter-spacing:.08em;color:var(--kas);border:1px solid var(--kst);border-radius:6px;padding:3px 6px;font-variant-numeric:tabular-nums}
.v-url{display:flex;align-items:center;gap:5px;background:#e9e7e4;border-radius:99px;padding:6px 10px;color:#52525b;font:10.5px/1 ui-monospace,Consolas,monospace}
.v-tip{display:inline-block;overflow:hidden;white-space:nowrap;width:calc(var(--n) * 1ch)}
.v-hero{display:grid;gap:2px;border-radius:14px;padding:14px 11px;color:#fff;background:linear-gradient(160deg,var(--c-f),color-mix(in srgb,var(--c-f) 55%,#000))}
.v-hero i{width:30px;height:30px;border-radius:9px;background:#ffffff30;display:grid;place-items:center;font-style:normal;font-weight:800;font-size:11px;margin-bottom:6px}.v-hero b{font-size:14px;overflow-wrap:anywhere}.v-hero small{opacity:.85;font-size:10px}
.v-esq i{display:flex;align-items:center;height:36px;padding:0 10px;border-radius:10px;background:#fff;margin-top:7px;border:1px solid #ebe9e6;font-style:normal;font-weight:600;color:#3f3f46;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.v-tit{font-weight:800;font-size:13px;margin:2px 0}
.v-fila{display:flex;align-items:center;gap:6px;background:#fff;border:1.5px solid #e7e5e4;border-radius:10px;padding:8px}.v-fila b{flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.v-fila span{color:#71717a}
.v-fila em{flex:none;width:17px;height:17px;border-radius:50%;border:1.5px solid #d4d4d8;display:grid;place-items:center;font-style:normal;color:#fff;font-size:10px;font-weight:800}
.v-fila.v-sel{border-color:var(--c-f);background:color-mix(in srgb,var(--c) 8%,#fff)}.v-sel em{background:var(--c-f);border-color:var(--c-f)}.v-sel em:after{content:"✓"}
.v-horas{display:flex;gap:5px}.v-horas i{flex:1;font-style:normal;text-align:center;background:#fff;border:1.5px solid #e7e5e4;border-radius:8px;padding:6px 0;font-weight:600}
.v-horas .v-sel{border-color:var(--c-f);background:var(--c-f);color:#fff}
.v-barra{margin-top:auto;margin-bottom:10px;background:var(--c-f);color:#fff;border-radius:99px;padding:10px;text-align:center;font-weight:700}
.v-res{display:grid;gap:6px;background:#fff;border-radius:12px;padding:10px;border:1px solid #ebe9e6}.v-res div{display:flex;justify-content:space-between;gap:8px}.v-res span:last-child{color:#71717a;flex:none}
.v-res .v-tot{border-top:1px dashed #d4d4d8;padding-top:6px;font-weight:800}.v-res .v-tot span:last-child{color:#18181b}
.v-boton{margin-top:6px;background:#25d366;color:#fff;border-radius:99px;padding:10px;text-align:center;font-weight:700}
.v-ok{align-self:center;background:#18181b;color:#fff;border-radius:99px;padding:5px 10px;font-weight:600;font-size:10.5px}
.p-pant.v-wa{background:#efeae2;padding-top:0}
.v-wah{display:flex;align-items:center;gap:7px;background:#075e54;color:#fff;margin:0 -10px 4px;padding:30px 10px 9px}.v-wah i{width:24px;height:24px;border-radius:50%;background:#ffffff30;display:grid;place-items:center;font-style:normal;font-size:9px;font-weight:800}.v-wah b{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.v-msg{align-self:flex-start;max-width:90%;background:#fff;border-radius:0 10px 10px 10px;padding:8px 9px;white-space:pre-line;box-shadow:0 1px 1px #0000001a;overflow-wrap:anywhere}
.v-sist{align-self:center;background:#fffbe6;color:#52525b;border-radius:8px;padding:4px 8px;font-size:10px;text-align:center}
.v-noti{position:absolute;z-index:2;top:8px;left:7px;right:7px;display:flex;gap:7px;align-items:center;background:#ffffffeb;backdrop-filter:blur(8px);border-radius:12px;padding:7px 8px;box-shadow:0 8px 20px #0000002e;transform:translateY(-140%)}
.v-noti i{flex:none;width:24px;height:24px;border-radius:7px;background:#25d366;color:#fff;display:grid;place-items:center}.v-noti b{display:block;font-size:10px}.v-noti small{display:block;font-size:10px;color:#52525b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.v-noti div{min-width:0}

/* Antes y después */
.vs{margin-top:22px}
.vs-tog{position:relative;display:grid;grid-template-columns:1fr 1fr;padding:4px;border-radius:99px;background:var(--k1);border:1px solid var(--k2)}
.vs-tog:before{content:"";position:absolute;top:4px;bottom:4px;left:4px;width:calc(50% - 4px);border-radius:99px;background:var(--k3);transition:transform .35s var(--ease),background .35s}
.vs.con .vs-tog:before{transform:translateX(100%);background:var(--kb)}
.vs-tog button{position:relative;z-index:1;min-height:48px;border:0;background:none;color:var(--kfo);font-weight:800;font-size:15px;transition:color .3s}
.vs-tog button[aria-pressed=true]{color:#fff}
.vs-panel{display:grid;margin-top:14px;border-radius:26px;padding:22px 20px;background:var(--k1);border:1px solid var(--k2);transition:background .35s,border-color .35s,box-shadow .35s;cursor:pointer}
.vs.con .vs-panel{background:linear-gradient(160deg,color-mix(in srgb,var(--c-f) 55%,var(--k1)),var(--k2) 75%);border-color:var(--kaz);box-shadow:0 30px 60px -30px color-mix(in srgb,var(--c-f) 70%,transparent)}
.vs-lado{grid-area:1/1;transition:opacity .15s,visibility 0s .15s,transform .2s var(--ease)}
.vs .vs-con,.vs.con .vs-hoy{opacity:0;visibility:hidden;transform:translateY(10px)}
.vs.con .vs-con,.vs:not(.con) .vs-hoy{opacity:1;visibility:visible;transform:none;transition:opacity .3s .15s,visibility 0s .15s,transform .35s .15s var(--ease)}
.vs-sim{width:56px;height:56px;border-radius:50%;display:grid;place-items:center;margin-bottom:16px}
.vs-hoy .vs-sim{background:var(--k3);color:var(--kas)}
.vs-con .vs-sim{background:var(--kb);color:#fff}
.vs-lado ul{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.vs-lado li{font:700 19px/1.25 var(--fd);letter-spacing:-.015em}
.vs-hoy li{color:var(--kfo)}
.vs-pista{margin:12px 0 0;text-align:center;font-size:13.5px;color:var(--kas)}

/* Qué incluye */
.incs{display:grid;gap:18px;margin-top:24px}
.inc{display:grid;grid-template-columns:28px 1fr;column-gap:14px;align-items:start}
.inc .ic{grid-row:1/3;width:26px;height:26px;margin-top:1px;color:var(--kaz)}
.inc b{font:700 21px/1.15 var(--fd);letter-spacing:-.015em}
.inc small{color:var(--kfo);font-size:15px;margin-top:2px}
.rot2{margin:30px 0 12px;font-size:15px;font-weight:600;color:var(--kas)}
.pasos{counter-reset:p;list-style:none;margin:0;padding:0;display:grid;gap:10px}
.pasos li{counter-increment:p;display:flex;align-items:center;gap:14px;font-size:16px;font-weight:600;color:#e6e8ec}
.pasos li:before{content:counter(p);flex:none;width:36px;height:36px;border-radius:50%;background:var(--kb);color:#fff;display:grid;place-items:center;font:800 17px/1 var(--fd)}

/* Cierre */
.cierre{padding-bottom:calc(env(safe-area-inset-bottom) + 84px)}
.quien{border-radius:24px;overflow:hidden;background:#000;border:1px solid var(--k2);height:clamp(150px,30svh,320px);box-shadow:0 30px 60px -30px #000}
.quien video{display:block;width:100%;height:100%;object-fit:cover;background:#000}
.quien-txt{margin:12px 0 0;font-size:15px;line-height:1.4;color:var(--kfo)}
.quien-txt b{color:#fff}
.cierre .cta{position:relative;isolation:isolate;background:var(--wa);margin-top:18px;min-height:62px;font-size:18px;box-shadow:0 20px 40px -16px #15803dcc,inset 0 1px 0 #ffffff40}
.cierre .cta:after{content:"";position:absolute;inset:0;z-index:-1;border-radius:inherit;box-shadow:0 0 0 2px #22c55e;opacity:0;pointer-events:none}
.sec2{display:flex;align-items:center;justify-content:center;text-align:center;min-height:52px;margin-top:10px;padding:0 20px;border-radius:99px;border:1.5px solid #ffffff40;color:#fff;font-weight:700;font-size:15.5px;text-decoration:none}
.rail-t{margin:18px 0 8px;font-size:14px;font-weight:600;color:var(--kas)}
.rail{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px}
.rail li{font-size:12.5px;font-weight:600;color:var(--kfo);padding:5px 10px;border:1px solid var(--kst);border-radius:99px}
.sec3{display:block;text-align:center;margin-top:12px;padding:6px;color:var(--kas);font-size:13.5px;text-underline-offset:3px}
.firma{margin:2px 0 0;text-align:center;font-size:12px;color:var(--kas)}

/* ---------- Hoja (vista de WhatsApp) ---------- */
dialog.hoja{border:0;border-radius:24px;padding:22px;width:calc(100% - 24px);max-width:420px;margin:auto auto calc(12px + env(safe-area-inset-bottom));background:var(--card);color:var(--tx);overscroll-behavior:contain;box-shadow:0 30px 60px -20px #00000080;opacity:0;transition-property:opacity,transform,display,overlay;transition-duration:.25s;transition-timing-function:ease-out;transition-behavior:allow-discrete}
dialog.hoja::backdrop{background-color:rgb(0 0 0 / 0);transition-property:background-color,display,overlay;transition-duration:.25s;transition-behavior:allow-discrete}
dialog.hoja[open]{opacity:1}
dialog.hoja[open]::backdrop{background-color:rgb(0 0 0 / .6)}
@starting-style{dialog.hoja[open]{opacity:0}dialog.hoja[open]::backdrop{background-color:rgb(0 0 0 / 0)}}
.hoja h3{margin:0 52px 8px 0;font:800 22px/1.1 var(--fd);letter-spacing:-.02em}
.hoja p{color:var(--mu);margin:0 0 14px;font-size:15px}
.msj{background:color-mix(in srgb,#25d366 14%,var(--bg));border-radius:14px;padding:14px;font-size:14.5px;white-space:pre-line;margin-bottom:4px}
.hoja .cta{margin-top:14px}
.cerrar{float:right;width:44px;height:44px;margin:-8px -8px 0 0;border:0;border-radius:50%;background:var(--chip);color:var(--tx);display:grid;place-items:center}

@media (hover:hover){
  .nav:hover{background:color-mix(in srgb,var(--ui) 18%,transparent)}
  .cta:hover{background:color-mix(in srgb,var(--c-f) 88%,#fff)}
  .cierre .cta:hover{background:#168a43}
  .sec2:hover,.sig-btn:hover{background:#ffffff14}
  .mas:not(.listo):hover{background:var(--c-f);color:#fff}
  .g-item .mas:hover{background:var(--c-f);color:#fff}
  .tab:not(.on):hover,.g-sel button:not(.on):hover,.b2:hover{background:color-mix(in srgb,var(--chip) 82%,var(--tx))}
}
@media (max-height:640px){.mini,.vs-pista,.inc small{display:none}.t{font-size:clamp(36px,10.4vw,48px)}.mosaico{display:grid;grid-template-columns:1.25fr 1fr;grid-template-rows:1fr 1fr;gap:8px;height:min(46svh,440px);margin-top:20px}
.mz{margin:0;border-radius:20px;overflow:hidden;background:var(--k2)}.mz0{grid-row:1/3}
.mz img{width:100%;height:100%;object-fit:cover;display:block}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
.chips span{display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border-radius:99px;background:#ffffff14;color:var(--kfo);font-size:13.5px;font-weight:600}
.galeria{--gh:min(38svh,360px)}}

/* ---------- Movimiento ---------- */
@media (prefers-reduced-motion:no-preference){
  dialog.hoja{transform:translateY(28px)}dialog.hoja[open]{transform:none}
  @starting-style{dialog.hoja[open]{transform:translateY(28px)}}
  /* Un solo movimiento por pantalla: el título sube; lo demás aparece quieto, sin escalonar. */
  .js .pant .a{opacity:0;transition:opacity .4s var(--ease)}
  .js .pant.on .a{opacity:1;transition-delay:.12s}
  .js .pant .t{transform:translateY(18px);transition:opacity .4s var(--ease),transform .55s var(--ease)}
  .js .pant.on .t{transform:none;transition-delay:0s}
  .js .portada.on h1{animation:entra-t .6s var(--ease) both .15s}
  @keyframes entra-t{from{opacity:0;transform:translateY(40px) scale(.96);letter-spacing:-.02em}}
  .js .portada .fondo{transition:transform 1.2s var(--ease)}
  .js .lugar.on .mz img{animation:kb 9s ease-out both}.js .lugar.on .mz1 img{animation-delay:.2s;animation-name:kb2}.js .lugar.on .mz2 img{animation-delay:.4s}
  @keyframes kb{from{transform:scale(1.14) translate(2%,2%)}}@keyframes kb2{from{transform:scale(1.14) translate(-2%,-1%)}}

  .js .portada:not(.on) .fondo{transform:scale(1.08)}
  .g-item.on img{animation:acerca .7s var(--ease) both}
  @keyframes acerca{from{transform:scale(1.08)}}
  .pista .ic{animation:empuja 1.4s ease-in-out infinite}
  @keyframes empuja{50%{transform:translateX(5px)}}
  .bolsa.bump{animation:bump .35s var(--rebote)}
  @keyframes bump{40%{scale:1.08}}
  .mas.listo{animation:pop .35s var(--rebote)}
  @keyframes pop{from{transform:scale(.6)}}
  .pant.on .cel:not(.instalada) i.mio{animation:late 1.6s ease-in-out infinite}
  @keyframes late{50%{transform:scale(1.12);outline-color:#fff}}
  .sellos i.nuevo{animation:sello .5s var(--rebote)}
  @keyframes sello{from{opacity:0;transform:scale(2.2) rotate(-25deg)}}
  .cel.instalada i.mio{animation:pop .5s var(--rebote)}
  .js .pant.on .burbuja{animation:sube .4s var(--ease) both}
  .js .pant.on .burbuja:nth-child(1){animation-delay:.4s}.js .pant.on .burbuja:nth-child(2){animation-delay:1.2s}.js .pant.on .burbuja:nth-child(3){animation-delay:2s}.js .pant.on .burbuja:nth-child(4){animation-delay:2.8s}
  .js .pant:not(.on) .burbuja{opacity:0}
  @keyframes sube{from{opacity:0;transform:translateY(12px) scale(.96)}}
  .cierre.on .cta:after{animation:llama 2.4s ease-out 1s infinite}
  @keyframes llama{0%{opacity:.8;transform:scale(1)}100%{opacity:0;transform:scale(1.06,1.4)}}
  .p-pant.on .v-tip{animation:v-escribe .9s steps(var(--n)) .2s both}@keyframes v-escribe{from{width:0}}
  .p-pant.on .v-hero{animation:v-sube .5s 1.2s both}.p-pant.on .v-esq i{animation:v-sube .45s both}.p-pant.on .v-esq i:nth-child(1){animation-delay:1.5s}.p-pant.on .v-esq i:nth-child(2){animation-delay:1.65s}.p-pant.on .v-esq i:nth-child(3){animation-delay:1.8s}
  @keyframes v-sube{from{opacity:0;transform:translateY(12px)}}
  .p-pant.on .v-sel{animation:v-elige .5s calc(.7s + var(--k) * .7s) both}.p-pant.on .v-sel em{animation:v-elige-em .5s calc(.7s + var(--k) * .7s) both}
  @keyframes v-elige{0%{border-color:#e7e5e4;background:#fff;color:#18181b;box-shadow:0 0 0 0 color-mix(in srgb,var(--c) 45%,transparent)}70%{box-shadow:0 0 0 7px transparent}}
  @keyframes v-elige-em{from{background:transparent;border-color:#d4d4d8;color:transparent}}
  .p-pant.on .v-barra{animation:v-sube .45s 2.5s both}
  .p-pant.on .v-res{animation:v-sube .45s .3s both}
  .p-pant.on .v-toca{animation:v-toca .6s 1.5s both}@keyframes v-toca{40%{transform:scale(.93);box-shadow:0 0 0 0 #25d36680}100%{box-shadow:0 0 0 12px transparent}}
  .p-pant.on .v-ok{animation:v-pop .4s 2.3s both}@keyframes v-pop{from{opacity:0;transform:scale(.6)}}
  .p-pant.on .v-noti{animation:v-noti 2.6s .2s both}@keyframes v-noti{0%{transform:translateY(-140%)}12%,78%{transform:none}100%{transform:translateY(-140%)}}
  .p-pant.on .v-msg{animation:v-pop .4s 1.2s both;transform-origin:top left}.p-pant.on .v-sist{animation:v-sube .4s 2.5s both}
}
@media (prefers-reduced-motion:reduce){*,*:before,*:after{transition-duration:.01ms!important}}
.top-v{display:inline-block;margin-left:8px;font-size:13px;font-weight:600;color:var(--c-t);vertical-align:1px}
.resenas{display:grid;gap:10px}
.resena{background:var(--chip);border-radius:18px;padding:14px 16px}
.resena p{margin:6px 0 4px;font-size:15px;line-height:1.4}
.resena small{color:var(--mu);font-size:12.5px}
.estrellas{color:#f59f00;display:flex;gap:2px}.estrellas svg{fill:currentColor}
.form{display:grid;gap:10px;margin-top:16px}
.form input{border:1px solid var(--ln);background:var(--card);color:var(--tx);border-radius:16px;padding:15px 16px;font:inherit;font-size:16px;caret-color:var(--c)}
.form input::placeholder{color:var(--mu);opacity:1}
.form input:focus{outline:2px solid var(--c-t);outline-offset:-1px}
</style></head>
<body data-neg="${esc(p.nombre)}">
<div class="app" id="app" data-tono="foto" data-parte="1">
<header class="cab" aria-hidden="true"><div class="prog" id="prog"></div><div class="cab-fila"><span class="cab-parte" id="parte">Tu página</span><span class="cab-muestra">Muestra con datos de ejemplo</span></div></header>
<main class="deck" id="deck" aria-label="Muestra para ${esc(p.nombre)}">
<section class="pant portada" id="s-portada" data-parte="1" data-tono="foto" aria-label="Portada">
${fx.portada ? `<img class="fondo" src="${fx.portada}" alt="" fetchpriority="high" decoding="async" width="1400" height="933">` : ""}
<div class="p-in">
${logoHtml}
<h1>${esc(p.nombre)}</h1>
<p class="meta a" style="--d:3"><span class="ab">Abierto ahora</span><span>${esc(d.nombre)}</span>${lugar ? `<span>${esc(lugar)}</span>` : ""}</p>
<div class="acciones a" style="--d:4">
<button class="acc pri" type="button" data-ir="${primera}">${ico(d.tipo === "citas" ? "cal" : "wa", 20)}${esc(accion)}</button>
<a class="acc redondo" href="${tel ? `tel:${tel}` : "#"}" aria-label="Llamar">${ico("phone", 20)}</a>
<a class="acc redondo" href="${esc(mapa)}" target="_blank" rel="noopener" aria-label="Cómo llegar">${ico("pin", 20)}</a>
</div>
<p class="pista a" style="--d:5">Desliza para ver más ${ico("flecha", 16)}</p>
</div></section>
${sHistoria(marca?.historia)}
${sAmbiente(p, d, ambiente, reales.length > 1, marca?.lugar)}
${conFoto(negocio.join("\n"), [fx.portada, ...(ambiente || [])])}
${d.ia ? sIA(p, d) : ""}
${conFoto(sApp(p), [...(ambiente || []), fx.portada].reverse())}
${visita}
${pantallasPropuesta(p, d, quiero, cfg, (ambiente || [])[1] || fx.portada)}
</main>
<button class="bolsa" id="bolsa" type="button" data-demo="pedido" hidden><span class="n" id="bn">0</span>${ico("bag")}<span id="bt">Ver pedido</span></button>
<nav class="dock" aria-label="Navegación"><button class="nav" id="prev" type="button" aria-label="Pantalla anterior">${ico("izq", 22, 2.4)}</button><a class="dock-cta" href="${esc(quiero)}">${ico("wa", 20)} Quiero arrancar</a><button class="nav" id="next" type="button" aria-label="Siguiente pantalla">${ico("der", 22, 2.4)}</button></nav>
<p class="sr" id="vivo" aria-live="polite"></p>
</div>
<dialog class="hoja" id="modal" closedby="any" aria-labelledby="mt"><button class="cerrar" id="cerrar" type="button" aria-label="Cerrar">${ico("x")}</button><h3 id="mt"></h3><p id="mp"></p><div class="msj" id="mm"></div>
<a class="cta" href="${esc(quiero)}">${ico("wa")} Quiero esto para ${esc(p.nombre)}</a></dialog>
<script>
(function(){
var d=document;var $=function(s,r){return (r||d).querySelector(s)};var all=function(s,r){return (r||d).querySelectorAll(s)};
d.documentElement.classList.add("js");
var app=$("#app"),deck=$("#deck"),P=Array.prototype.slice.call(all(".pant",deck)),N=P.length,i=-1;
var NEG=d.body.dataset.neg||"";
var quieto=matchMedia("(prefers-reduced-motion: reduce)").matches;
var OK='<svg class="ic" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
var PLAY='<svg class="ic" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M7 4v16l13-8z"/></svg>',PAUSA='<svg class="ic" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';

/* ---- Progreso ---- */
var prog=$("#prog");
P.forEach(function(p,k){var s=d.createElement("i");if(k>0&&p.dataset.parte!==P[k-1].dataset.parte)s.className="corte";s.appendChild(d.createElement("b"));prog.appendChild(s)});
var segs=all("i",prog),parte=$("#parte"),vivo=$("#vivo"),prev=$("#prev"),next=$("#next");
var hooks=[];

function marcar(k){if(k===i||k<0||k>=N)return;i=k;var p=P[k];
  P.forEach(function(x,j){var on=j===k;x.classList.toggle("on",on);x.inert=!on;x.setAttribute("aria-hidden",on?"false":"true")});
  segs.forEach(function(s,j){s.classList.toggle("ya",j<k);s.classList.toggle("ahora",j===k)});
  app.dataset.tono=p.dataset.tono;app.dataset.parte=p.dataset.parte;
  if(k===N-1)app.setAttribute("data-ultima","");else app.removeAttribute("data-ultima");
  parte.textContent=p.dataset.parte==="2"?"La propuesta":"Tu página";
  prev.disabled=k===0;next.disabled=k===N-1;
  vivo.textContent="Pantalla "+(k+1)+" de "+N+": "+p.getAttribute("aria-label");
  hooks.forEach(function(h){h(p)});
}
function ir(k){k=Math.max(0,Math.min(N-1,k));deck.scrollTo({left:k*deck.clientWidth,behavior:quieto?"auto":"smooth"});if(quieto)marcar(k)}
var raf=0;
deck.addEventListener("scroll",function(){if(raf)return;raf=requestAnimationFrame(function(){raf=0;marcar(Math.round(deck.scrollLeft/deck.clientWidth))})},{passive:true});
window.addEventListener("resize",function(){deck.scrollTo({left:Math.max(i,0)*deck.clientWidth,behavior:"auto"})});
prev.addEventListener("click",function(){ir(i-1)});
next.addEventListener("click",function(){ir(i+1)});
deck.addEventListener("click",function(e){if(e.target.closest("a,button,input,label,video,select,textarea,[data-notap]"))return;var r=deck.getBoundingClientRect(),x=e.clientX-r.left;if(x<r.width*.25)ir(i-1);else if(x>r.width*.75)ir(i+1)});
all("[data-ir]").forEach(function(b){b.addEventListener("click",function(e){e.preventDefault();var k=P.indexOf(d.getElementById(b.dataset.ir));ir(k>-1?k:i+1)})});

/* ---- Selección (servicio, día, hora) ---- */
function sel(g){var bs=all(g);bs.forEach(function(b){b.addEventListener("click",function(){if(b.disabled)return;bs.forEach(function(x){x.classList.toggle("on",x===b);x.setAttribute("aria-pressed",x===b?"true":"false")})})})}
sel(".serv");sel(".dia");sel(".hora");

/* ---- Pestañas del menú ---- */
all(".tab").forEach(function(t){t.addEventListener("click",function(){all(".tab").forEach(function(x){x.classList.toggle("on",x===t);x.setAttribute("aria-pressed",x===t?"true":"false")});var n=t.dataset.tab;all("[data-lista]").forEach(function(l){l.hidden=l.dataset.lista!==n})})});

/* ---- Galería de lo más pedido ---- */
all("[data-galeria]").forEach(function(g){var it=all(".g-item",g),bs=g.nextElementSibling?all("[data-ver]",g.nextElementSibling):[],k=0;
  function ver(n){k=(n+it.length)%it.length;it.forEach(function(x,j){x.classList.toggle("on",j===k);x.inert=j!==k});bs.forEach(function(b,j){b.classList.toggle("on",j===k);b.setAttribute("aria-pressed",j===k?"true":"false")})}
  Array.prototype.forEach.call(bs,function(b,j){b.addEventListener("click",function(){ver(j)})});
  g.addEventListener("click",function(e){if(e.target.closest("button"))return;ver(k+1)});ver(0)});

/* ---- Pedido ---- */
var pedido=[],bolsa=$("#bolsa"),bn=$("#bn"),bt=$("#bt");
all("[data-add]").forEach(function(b){b.addEventListener("click",function(){pedido.push([b.dataset.add,Number(b.dataset.precio)||0]);var tot=pedido.reduce(function(a,x){return a+x[1]},0);
  bn.textContent=pedido.length;bt.textContent="Ver pedido · $"+tot.toLocaleString("es-MX");bolsa.hidden=false;app.classList.add("con-pedido");
  bolsa.classList.remove("bump");void bolsa.offsetWidth;bolsa.classList.add("bump");
  b.innerHTML=OK;b.classList.add("listo");clearTimeout(b._t);b._t=setTimeout(function(){b.textContent="+";b.classList.remove("listo")},900)})});

/* ---- Tarjeta de cliente frecuente ---- */
all("[data-sellar]").forEach(function(b){b.addEventListener("click",function(){var w=b.closest(".wallet"),s=all(".sellos i",w),on=all(".sellos i.on",w).length;if(on>=s.length)return;
  var n=s[on];n.classList.add("on","nuevo");n.innerHTML=OK;on++;var f=s.length-on,pr=w.dataset.premio||"tu premio";
  $("[data-w-n]",w).textContent="Llevas "+on+" de "+s.length+" "+(w.dataset.palabra||"visitas");
  $("[data-w-f]",w).textContent=f?"Te faltan "+f+" para "+pr:"¡Ganaste "+pr+"!";
  if(!f){b.disabled=true;b.textContent="Tarjeta completa"}})});

/* ---- Instalar app ---- */
all("[data-instalar]").forEach(function(b){b.addEventListener("click",function(){var c=$(".cel"),m=$("[data-instalado]");if(!c)return;c.classList.remove("instalada");void c.offsetWidth;c.classList.add("instalada");if(m)m.hidden=false})});

/* ---- Así funciona ---- */
var pl=$("[data-peli]");
if(pl){var ps=all(".p-pant",pl),pb=all(".p-barras i",pl),txt=$(".p-txt",pl),num=$(".p-num",pl),bp=$(".p-btn",pl),j=0,pausa=quieto,activa=false;
  var est=function(){pl.classList.toggle("corre",!pausa&&activa);bp.innerHTML=pausa?PLAY:PAUSA;bp.setAttribute("aria-label",pausa?"Reproducir":"Pausar")};
  var paso=function(k){j=(k+ps.length)%ps.length;ps.forEach(function(s){s.classList.remove("on")});pb.forEach(function(b){b.className=""});void pl.offsetWidth;
    ps.forEach(function(s,n){s.classList.toggle("on",n===j);s.setAttribute("aria-hidden",n===j?"false":"true")});pb.forEach(function(b,n){b.className=n<j?"ya":n===j?"ahora":""});
    txt.textContent=ps[j].dataset.cap;num.textContent=(j+1)+" / "+ps.length};
  pb.forEach(function(b){b.firstChild.addEventListener("animationend",function(){if(b.className==="ahora")paso(j+1)})});
  bp.addEventListener("click",function(){pausa=!pausa;est()});
  $(".p-sig",pl).addEventListener("click",function(){paso(j+1)});
  $(".p-escena",pl).addEventListener("click",function(){paso(j+1)});
  hooks.push(function(p){var a=p.contains(pl);if(a&&!activa)paso(0);activa=a;est()});
  paso(0);est()}

/* ---- Antes y después ---- */
var vs=$("[data-vs]");
if(vs){var vb=all("[data-vs-btn]",vs),tocado=false,visto=false;
  var vsSet=function(con){vs.classList.toggle("con",con);vb.forEach(function(b){b.setAttribute("aria-pressed",(b.dataset.vsBtn==="1")===con?"true":"false")})};
  vb.forEach(function(b){b.addEventListener("click",function(){tocado=true;vsSet(b.dataset.vsBtn==="1")})});
  $(".vs-panel",vs).addEventListener("click",function(){tocado=true;vsSet(!vs.classList.contains("con"))});
  hooks.push(function(p){if(p.contains(vs)&&!visto&&!quieto){visto=true;setTimeout(function(){if(!tocado)vsSet(true)},1600)}})}

/* ---- Video: pausa al salir ---- */
hooks.push(function(p){all("video").forEach(function(v){if(!p.contains(v)&&!v.paused)v.pause()})});

/* ---- Imágenes ---- */
all("img").forEach(function(im){if(im.complete)return;im.classList.add("cargando");var ya=function(){im.classList.remove("cargando")};im.addEventListener("load",ya);im.addEventListener("error",ya)});

/* ---- Vista de WhatsApp ---- */
var dlg=$("#modal");
function modal(t,p,m){$("#mt").textContent=t;$("#mp").textContent=p;$("#mm").textContent=m;if(!dlg.open)dlg.showModal()}
$("#cerrar").addEventListener("click",function(){dlg.close()});
if(!("closedBy" in HTMLDialogElement.prototype)){dlg.addEventListener("click",function(e){if(e.target!==dlg)return;var r=dlg.getBoundingClientRect();if(r.top<=e.clientY&&e.clientY<=r.bottom&&r.left<=e.clientX&&e.clientX<=r.right)return;dlg.close()})}
all("[data-demo]").forEach(function(b){b.addEventListener("click",function(e){e.preventDefault();var k=b.dataset.demo;
  if(k==="pedido"){var l=pedido.length?pedido:[["(elige algo del menú)",0]];var tot=pedido.reduce(function(a,x){return a+x[1]},0);modal("Así te llegaría el pedido","Ordenado y directo a tu WhatsApp, sin errores ni llamadas.","Nuevo pedido para "+NEG+"\\n\\n"+l.map(function(x){return "• "+x[0]+(x[1]?"  $"+x[1].toLocaleString("es-MX"):"")}).join("\\n")+(tot?"\\n\\nTotal: $"+tot.toLocaleString("es-MX"):"")+"\\nCliente: María López\\nEntrega: a domicilio")}
  else if(k==="cita"){var s=$(".serv.on"),dd=$(".dia.on"),h=$(".hora.on");modal("Así quedaría agendada","Al cliente le llega la confirmación y un recordatorio; a ti, el aviso con sus datos.","Cita confirmada en "+NEG+"\\n\\n"+(s?s.dataset.serv:"Servicio")+"\\n"+(dd?dd.dataset.dia:"")+" a las "+(h?h.dataset.hora:"")+"\\nCliente: Juan Pérez\\n\\nTe recordamos un día antes y una hora antes.")}
  else if(k==="app"){modal("Así se instala tu app","Tu cliente abre tu link, toca \\"Agregar a inicio\\" y listo: tu logo queda en su celular, sin tiendas de apps.",NEG+" ya está en tu pantalla de inicio.\\n\\nÁbrela para pedir, ver promociones y tu tarjeta de cliente frecuente.")}
  else if(k==="wallet"){modal("Tarjeta en el celular","Tus clientes la agregan con un toque y les llegan avisos cuando están cerca o cuando tienes promoción.","Hola, ya casi completas tu tarjeta en "+NEG+". Te faltan pocos para tu premio. Te esperamos.")}
  else{modal("Así te llegarían los informes","Cada interesado queda registrado y te llega su mensaje directo.","Nuevo interesado en "+NEG+"\\nNombre: Ana Ruiz\\nWhatsApp: 871 000 0000")}})});

/* ---- Teclado ---- */
d.addEventListener("keydown",function(e){if(dlg.open)return;var t=e.target;if(t&&t.closest&&t.closest("input,textarea,select,video"))return;
  if(e.key==="ArrowRight"){e.preventDefault();ir(i+1)}else if(e.key==="ArrowLeft"){e.preventDefault();ir(i-1)}});

marcar(Math.round(deck.scrollLeft/(deck.clientWidth||1)));
})();
</script></body></html>`;
}

// ---------- Galería: una muestra de cada tipo de negocio (para verlas o enseñarlas en persona) ----------

/** Muestra de un perfil con un negocio de ejemplo ("Tu pizzería"). */
export function renderMuestra(id) {
  const d = perfilesGaleria().find((x) => x.id === id);
  if (!d) return null;
  const palabra = d.nombre.split(" y ")[0].toLowerCase();
  // "Abogados", "Mariscos", "Seguros"… van en plural: "Tus abogados", no "Tu abogados".
  const tu = /^(cualquier)/i.test(d.nombre) ? "Tu negocio" : `${/s$/.test(palabra.split(" ")[0]) ? "Tus" : "Tu"} ${palabra}`;
  return renderBoceto({ id: 0, demo: true, perfil: d, nombre: tu, colonia: "Centro", ciudad: "Torreón", direccion: "Tu dirección", telefono: "" });
}

export function renderGaleria() {
  const cfg = getProspeccion();
  const tarjetas = perfilesGaleria()
    .map((d) => `<a class="t" href="/muestras/${d.id}" style="--c:${d.color}"><i>${esc(iniciales(d.nombre))}</i><b>${esc(d.nombre)}</b><small>${esc(d.que)}</small></a>`)
    .join("");
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Muestras · ${esc(cfg.remitente.empresa)}</title><meta name="robots" content="noindex,nofollow">
<link href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;600;800&display=swap" rel="stylesheet">
<style>:root{--bg:#f6f5f3;--card:#fff;--tx:#18181b;--mu:#71717a;--ln:#e7e5e4}@media (prefers-color-scheme:dark){:root{--bg:#0c0c0d;--card:#18181b;--tx:#f4f4f5;--mu:#a1a1aa;--ln:#27272a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.5 "Schibsted Grotesk",system-ui,sans-serif}
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
