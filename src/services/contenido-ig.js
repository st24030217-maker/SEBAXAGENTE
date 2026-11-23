// Contenido para Instagram, YA HECHO: cada día un reel (15 s, vertical) y un carrusel (5 imágenes)
// para @ssss.olutions, con caption y hashtags, que llegan al WhatsApp de Sebastián listos para subir.
//
//  1. Ideas de internet: tendencias del día en México (Google Trends), fechas comerciales que vienen y,
//     si la cuota de Gemini lo permite, una búsqueda en Google de tendencias de Instagram para negocios.
//  2. La IA arma el plan: tema, 4 escenas con texto corto, carrusel, caption, hashtags (formato según el día).
//  3. scripts/contenido-ig.mjs (proceso aparte, la laptop tiene poca RAM) baja clips REALES de Mixkit
//     (licencia libre), arma el reel con HyperFrames (videos/contenido) y las imágenes del carrusel.
//  4. A la hora (CONTENIDO_IG_HORA, 10:00) te manda todo. Si el render falló, te manda el guion en texto.
//
// Estilo: tipo historia, atrevido, poco texto; nada de imágenes hechas con IA ni capturas.
// CONTENIDO_IG=0 lo apaga. CONTENIDO_IG_GENERAR_HORA (6) es cuando empieza a prepararlo.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { getDb, logEvent } from "../db.js";
import { settings, getNegocio, ROOT } from "../config.js";
import { localParts, localDateString } from "./calendar.js";
import { generarTexto } from "../ia/texto.js";
import { iaDisponible } from "../ia/proveedor.js";
import { geminiConfigurado } from "../ia/gemini.js";

const HORA = () => Number(process.env.CONTENIDO_IG_HORA || 10);
const HORA_GENERAR = () => Number(process.env.CONTENIDO_IG_GENERAR_HORA || 6);
const ESPERA_RENDER_H = 3; // si a las HORA+3 el render no termina, se manda el guion en texto
export const CARPETA = path.join(ROOT, "data", "contenido");
const SCRIPT = path.join(ROOT, "scripts", "contenido-ig.mjs");

// Formato según el día (0 = domingo): define el ángulo del reel y del carrusel.
export const FORMATOS = [
  { nombre: "Pregunta a tu audiencia", guia: "Plantea una pregunta o reto al dueño de negocio; el carrusel cierra pidiendo que comente." },
  { nombre: "Antes / después", guia: "Escenas 1-2: el negocio sin el servicio (el problema). Escenas 3-4: con el servicio (el resultado)." },
  { nombre: "Tips rápidos", guia: "Cada escena y cada diapositiva es un tip concreto y accionable." },
  { nombre: "Error común", guia: "Un error que cometen los negocios de La Laguna con su presencia digital y cómo arreglarlo." },
  { nombre: "Tendencia del momento", guia: "Conecta una tendencia, noticia o fecha de esta semana con el negocio del cliente (sin forzarla)." },
  { nombre: "Mito vs. realidad", guia: "Un mito ('es caro', 'no lo necesito', 'nadie lo usa') y la realidad." },
  { nombre: "Detrás de cámaras", guia: "Cómo se hace un proyecto: visita al negocio, diseño, entrega. Humano y cercano." },
];

// Fechas que mueven ventas en México (mes, día, nombre). Se avisan con 3 semanas de anticipación.
const FECHAS = [
  [1, 6, "Día de Reyes"], [2, 14, "San Valentín"], [3, 8, "Día de la Mujer"], [4, 30, "Día del Niño"],
  [5, 10, "Día de las Madres"], [6, 15, "Día del Padre (3er domingo de junio, aprox.)"], [8, 20, "Regreso a clases"],
  [9, 16, "Fiestas Patrias"], [10, 31, "Halloween"], [11, 2, "Día de Muertos"], [11, 15, "El Buen Fin (mediados de noviembre)"],
  [12, 12, "Día de la Virgen de Guadalupe"], [12, 24, "Nochebuena y Navidad"], [12, 31, "Fin de año"],
];

export function fechasProximas(ahora = new Date(), dias = 21) {
  const out = [];
  for (const [m, d, nombre] of FECHAS) {
    for (const y of [ahora.getUTCFullYear(), ahora.getUTCFullYear() + 1]) {
      const f = new Date(Date.UTC(y, m - 1, d, 18));
      const faltan = Math.round((f - ahora) / 86400_000);
      if (faltan >= -1 && faltan <= dias) out.push(`${nombre} (${faltan <= 0 ? "hoy" : `en ${faltan} días`})`);
    }
  }
  return out;
}

/** Búsquedas del día en México (Google Trends, gratis y sin clave). */
export async function tendenciasMexico() {
  try {
    const res = await fetch("https://trends.google.com/trending/rss?geo=MX", { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15_000) });
    const xml = await res.text();
    return [...xml.matchAll(/<item>\s*<title>([^<]+)<\/title>/g)].map((m) => m[1].trim()).slice(0, 15);
  } catch {
    return [];
  }
}

/** Búsqueda en Google con Gemini (si hay cuota): qué está funcionando en Instagram para negocios. */
async function busquedaWeb(fecha) {
  if (!geminiConfigurado()) return "";
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_MODELO || "gemini-3.5-flash"}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": process.env.GEMINI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: `Hoy es ${fecha}. Busca en internet y resume en 6 viñetas cortas: formatos y temas de Instagram Reels que están funcionando ESTA semana para negocios pequeños en México (restaurantes, barberías, tiendas, consultorios), y noticias o fechas comerciales de esta semana en México que un negocio pueda aprovechar.` }] }],
        tools: [{ google_search: {} }],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    const j = await res.json();
    return (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim().slice(0, 2500);
  } catch {
    return "";
  }
}

/** Planes de los últimos días (temas y clips usados), para no repetir. */
export function historial(dias = 30) {
  const out = [];
  try {
    for (const f of fs.readdirSync(CARPETA).sort().reverse().slice(0, dias)) {
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(CARPETA, f, "plan.json"), "utf8")));
      } catch {}
    }
  } catch {}
  return out;
}

export function promptPlan({ fecha, negocio, formato, servicio, tendencias, fechas, web, recientes }) {
  return `Eres el community manager de ${negocio.negocio.nombre} (Instagram @ssss.olutions), empresa de Lerdo, Durango, que hace páginas web, apps, menús digitales y agentes de IA para WhatsApp a negocios de Torreón, Gómez Palacio y Lerdo. Responsable: Sebastián Salinas.

Hoy es ${fecha}. Prepara el contenido de HOY: un reel de 15 s y un carrusel de 5 diapositivas sobre el MISMO tema.

Formato de hoy: ${formato.nombre}. ${formato.guia}
Servicio a mover: ${servicio ? `${servicio.nombre}: ${servicio.descripcion}` : "cualquiera"}

Lo que está pasando (de internet):
- Lo más buscado hoy en México: ${tendencias.length ? tendencias.join(", ") : "(no disponible)"}
- Fechas comerciales que vienen: ${fechas.length ? fechas.join("; ") : "ninguna cercana"}
${web ? `- Búsqueda en Google:\n${web}\n` : ""}Usa una tendencia o fecha SOLO si conecta de forma natural con los negocios; si no, ignóralas.

Temas recientes que NO debes repetir: ${recientes.length ? recientes.map((t) => `"${t}"`).join(", ") : "(ninguno)"}

Reglas:
- La marca es MINIMALISTA: frases cortas, limpias y seguras, con tono tranquilo y elegante (nada de gritos, signos de exclamación ni frases de vendedor). Español de México, cercano, como alguien de La Laguna. Sin tecnicismos ni emojis en los textos del video.
- Textos del reel: máximo 5 palabras cada uno, mejor si son 3 o 4. Etiquetas: 1 o 2 palabras en MAYÚSCULAS.
- El video es con clips reales de stock: "busqueda" es UNA palabra EN INGLÉS, un sustantivo de lo que se ve en la toma (ej. "restaurant", "waiter", "barber", "smartphone", "cashier", "cafe", "chef", "laptop", "shop", "customer"). Evita tomas de personas famosas o marcas.
- Si mencionas precio: el paquete completo (web + app + menú digital) cuesta $4,000 MXN en 2 pagos.
- La llamada a la acción siempre es escribir por WhatsApp al ${negocio.negocio.telefono}.

Responde SOLO con este JSON (sin texto antes ni después):
{
  "tema": "máximo 8 palabras",
  "por_que_hoy": "una línea: qué tendencia, fecha o idea lo inspiró",
  "escenas": [
    {"etiqueta": "", "texto": "", "busqueda": ""},
    {"etiqueta": "", "texto": "", "busqueda": ""},
    {"etiqueta": "", "texto": "", "busqueda": ""},
    {"etiqueta": "", "texto": "", "busqueda": ""}
  ],
  "cierre": "pregunta final del reel, máximo 6 palabras",
  "carrusel": [
    {"titulo": "portada con gancho, máximo 6 palabras", "texto": ""},
    {"titulo": "máximo 5 palabras", "texto": "máximo 18 palabras"},
    {"titulo": "", "texto": ""},
    {"titulo": "", "texto": ""},
    {"titulo": "cierre, máximo 6 palabras", "texto": "llamada a la acción"}
  ],
  "caption": "2 a 4 líneas para la publicación, sobrio, máximo 1 emoji",
  "hashtags": "10 hashtags, incluye #Torreón #GómezPalacio #Lerdo #LaLaguna",
  "hora": "mejor hora para subirlo hoy"
}`;
}

/** Saca el JSON de la respuesta (las IAs a veces lo envuelven en ```json). */
export function leerPlan(texto) {
  const ini = texto.indexOf("{");
  const fin = texto.lastIndexOf("}");
  if (ini < 0 || fin <= ini) throw new Error("la IA no regresó JSON");
  const p = JSON.parse(texto.slice(ini, fin + 1));
  if (!p.tema || !Array.isArray(p.escenas) || p.escenas.length < 4 || !Array.isArray(p.carrusel) || p.carrusel.length < 3) throw new Error("plan incompleto");
  p.escenas = p.escenas.slice(0, 4);
  p.carrusel = p.carrusel.slice(0, 5);
  return p;
}

const servicioDelDia = (ahora, catalogo = []) => (catalogo.length ? catalogo[Math.floor(ahora.getTime() / 86400_000) % catalogo.length] : null);

/** Investiga y arma el plan del día. */
export async function planearContenido(ahora = new Date()) {
  const negocio = getNegocio();
  const tz = negocio.negocio.zona_horaria;
  const formato = FORMATOS[localParts(ahora, tz).weekday];
  const fecha = new Intl.DateTimeFormat("es-MX", { timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(ahora);
  const [tendencias, web] = await Promise.all([tendenciasMexico(), busquedaWeb(fecha)]);
  const fechas = fechasProximas(ahora);
  const recientes = historial().map((p) => p.tema).filter(Boolean);
  const prompt = promptPlan({ fecha, negocio, formato, servicio: servicioDelDia(ahora, negocio.catalogo || []), tendencias, fechas, web, recientes });
  let ultimo;
  for (let i = 0; i < 2; i++) {
    try {
      const { texto } = await generarTexto({ prompt, maxTokens: 8000, modeloClaude: settings.claude.model, usoId: "contenido_ig" });
      return { ...leerPlan(texto), formato: formato.nombre, fecha: localDateString(ahora, tz), fuentes: { tendencias: tendencias.length, web: !!web, fechas } };
    } catch (e) {
      ultimo = e;
    }
  }
  throw ultimo;
}

/** Texto que acompaña al contenido (o el guion completo si no hubo video). */
export function textoContenido(plan, { conVideo }) {
  const escenas = plan.escenas.map((e, i) => `${i + 1}. ${e.etiqueta} · ${e.texto}`).join("\n");
  const slides = plan.carrusel.map((s, i) => `${i + 1}. *${s.titulo}*${s.texto ? ` · ${s.texto}` : ""}`).join("\n");
  return [
    `*sss.solutions · Contenido de hoy para Instagram*`,
    `_${plan.formato} · ${plan.tema}_`,
    plan.por_que_hoy ? `Idea: ${plan.por_que_hoy}` : "",
    conVideo ? "Arriba: el reel y las 5 imágenes del carrusel. Copia y pega el caption:" : `No se pudo armar el video hoy; aquí va el guion para grabarlo:\n\n*Reel*\n${escenas}\nCierre: ${plan.cierre}\n\n*Carrusel*\n${slides}`,
    `*Caption:*\n${plan.caption}\n\n${plan.hashtags}`,
    plan.hora ? `*Mejor hora para subirlo:* ${plan.hora}` : "",
  ].filter(Boolean).join("\n\n");
}

const dirHoy = (fecha) => path.join(CARPETA, fecha);
const yaEnviado = (clave) =>
  !!getDb().prepare("SELECT 1 FROM eventos WHERE tipo = 'contenido_ig' AND json_extract(datos,'$.clave') = ? LIMIT 1").get(clave);

let hijo = null;
let ultimoFallo = 0;

function lanzarRender(dir) {
  if (hijo || !fs.existsSync(SCRIPT)) return;
  fs.mkdirSync(path.join(ROOT, "logs"), { recursive: true });
  const log = fs.openSync(path.join(ROOT, "logs", "contenido-ig.log"), "a");
  hijo = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", SCRIPT, dir], { cwd: ROOT, stdio: ["ignore", log, log], windowsHide: true });
  hijo.on("exit", () => {
    hijo = null;
    fs.closeSync(log);
  });
}

/**
 * Se llama cada pocos minutos. Prepara el plan y lanza el render a partir de HORA_GENERAR;
 * a partir de HORA manda lo que esté listo. `enviar` = { texto(t), video(buf, caption), imagen(buf, caption) }.
 */
export async function revisarContenidoIG(ahora = new Date(), enviar) {
  const tz = getNegocio().negocio.zona_horaria;
  const hoy = localDateString(ahora, tz);
  const h = localParts(ahora, tz).h;
  if (h < HORA_GENERAR() || h >= 22 || yaEnviado(hoy) || !iaDisponible()) return null;
  if (Date.now() - ultimoFallo < 30 * 60_000) return null;
  const dir = dirHoy(hoy);
  const planPath = path.join(dir, "plan.json");

  // 1) Plan del día
  if (!fs.existsSync(planPath)) {
    try {
      const plan = await planearContenido(ahora);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
    } catch (e) {
      ultimoFallo = Date.now();
      console.error("[contenido-ig] no se pudo armar el plan:", String(e.message).slice(0, 200));
      return null;
    }
  }
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const listo = path.join(dir, "listo.json");
  const fallo = fs.existsSync(path.join(dir, "fallo.txt"));

  // 2) Render (una vez; si falló, no se reintenta hoy)
  if (!fs.existsSync(listo) && !fallo) lanzarRender(dir);
  if (h < HORA()) return null;

  // 3) Envío: con video si está listo; si falló o tarda demasiado, el guion en texto.
  let r = null;
  if (fs.existsSync(listo)) {
    const { reel, slides = [] } = JSON.parse(fs.readFileSync(listo, "utf8"));
    if (!(await enviar.video(fs.readFileSync(path.join(dir, reel)), `Reel de hoy · ${plan.tema}`))) return (ultimoFallo = Date.now()), null;
    for (const [i, s] of slides.entries()) await enviar.imagen(fs.readFileSync(path.join(dir, s)), `Carrusel ${i + 1}/${slides.length}`);
    r = textoContenido(plan, { conVideo: true });
  } else if (fallo || h >= HORA() + ESPERA_RENDER_H) {
    r = textoContenido(plan, { conVideo: false });
  } else return null; // sigue renderizando
  if (!(await enviar.texto(r))) return (ultimoFallo = Date.now()), null;
  logEvent("contenido_ig", null, { clave: hoy, tema: plan.tema, video: fs.existsSync(listo) });
  return r;
}

/** Revisa cada 5 minutos. Solo el agente principal (sss.solutions). */
export function startContenidoIG(enviar, cadaMs = 5 * 60_000) {
  if (/^(0|false|no)$/i.test(process.env.CONTENIDO_IG || "")) return null;
  let corriendo = false;
  const tick = async () => {
    if (corriendo) return;
    corriendo = true;
    try {
      await revisarContenidoIG(new Date(), enviar);
    } catch (e) {
      console.error("[contenido-ig]", e.message);
    } finally {
      corriendo = false;
    }
  };
  setTimeout(tick, 45_000);
  return setInterval(tick, cadaMs);
}
