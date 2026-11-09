// Fuentes externas: DENUE del INEGI (buscar negocios), PageSpeed de Google (medir su página)
// y la propia página del negocio (buscar un correo de contacto). Todas gratuitas.
import { settings } from "../config.js";

const DENUE_BASE = "https://www.inegi.org.mx/app/api/denue/v1/consulta";

const titulo = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/(^|[\s.(/-])(\p{L})/gu, (_m, a, b) => a + b.toUpperCase())
    .replace(/\b(De|Del|La|Las|Los|El|Y|En|Sa|Cv|Rl)\b/g, (w) => (["Sa", "Cv", "Rl"].includes(w) ? w.toUpperCase() : w.toLowerCase()))
    .replace(/^\p{Ll}/u, (c) => c.toUpperCase())
    .trim();

/** Lee un campo del DENUE sin importar mayúsculas/minúsculas. */
function campo(reg, nombre) {
  const k = Object.keys(reg).find((x) => x.toLowerCase() === nombre.toLowerCase());
  const v = k ? String(reg[k] ?? "").trim() : "";
  return v && v !== "0" ? v : "";
}

export function normalizarTelefono(t) {
  const d = String(t || "").replace(/\D/g, "");
  if (d.length === 10) return d;
  if (d.length === 12 && d.startsWith("52")) return d.slice(2);
  if (d.length === 13 && d.startsWith("521")) return d.slice(3);
  return d.length >= 10 ? d.slice(-10) : "";
}

export function normalizarWeb(w) {
  let s = String(w || "").trim().toLowerCase();
  if (!s || s === "0" || !s.includes(".")) return "";
  if (!/^https?:\/\//.test(s)) s = "https://" + s.replace(/^\/+/, "");
  try {
    return new URL(s).toString();
  } catch {
    return "";
  }
}

export const esRedSocial = (url) => /(facebook|fb\.com|instagram|tiktok|twitter|x\.com|linktr\.ee|wa\.me|whatsapp)/i.test(url || "");

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const EMAIL_BASURA = /(example\.|sentry|wixpress|\.png|\.jpg|\.jpeg|\.gif|\.webp|\.svg|domain\.com|email\.com|tucorreo|yourdomain|godaddy|@2x)/i;

export function limpiarEmail(e) {
  const s = String(e || "").trim().toLowerCase();
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(s) && !EMAIL_BASURA.test(s) ? s : "";
}

/** Convierte un registro del DENUE al formato de la tabla prospectos. */
export function desdeDenue(reg, ciudad, rubro) {
  const direccion = [campo(reg, "Tipo_vialidad"), campo(reg, "Calle"), campo(reg, "Num_Exterior"), campo(reg, "Num_Interior") && `int. ${campo(reg, "Num_Interior")}`]
    .filter(Boolean)
    .join(" ");
  return {
    fuente: "denue",
    externo_id: campo(reg, "Id") || campo(reg, "CLEE"),
    nombre: titulo(campo(reg, "Nombre") || campo(reg, "Razon_social")),
    razon_social: titulo(campo(reg, "Razon_social")),
    giro: campo(reg, "Clase_actividad"),
    rubro: rubro.nombre,
    ciudad: ciudad.nombre,
    direccion: titulo(direccion),
    colonia: titulo(campo(reg, "Colonia")),
    telefono: normalizarTelefono(campo(reg, "Telefono")),
    email: limpiarEmail(campo(reg, "Correo_e")),
    sitio_web: normalizarWeb(campo(reg, "Sitio_internet")),
    empleados: campo(reg, "Estrato"),
    lat: Number(campo(reg, "Latitud")) || null,
    lon: Number(campo(reg, "Longitud")) || null,
  };
}

/** Busca negocios en el DENUE alrededor de un punto. Devuelve los registros crudos. */
export async function buscarDenue({ palabras, lat, lon, radio }) {
  const token = settings.prospeccion.denueToken;
  if (!token) throw new Error("Falta DENUE_TOKEN en .env (es gratis: https://www.inegi.org.mx/servicios/api_denue.html)");
  const condicion = encodeURIComponent(String(palabras).normalize("NFD").replace(/[̀-ͯ]/g, "").trim());
  const url = `${DENUE_BASE}/Buscar/${condicion}/${lat},${lon}/${Math.min(5000, radio)}/${encodeURIComponent(token)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
  const texto = await res.text();
  if (!res.ok) throw new Error(`DENUE respondió ${res.status}: ${texto.slice(0, 160)}`);
  let datos;
  try {
    datos = JSON.parse(texto.replace(/^﻿/, ""));
    // A veces el DENUE devuelve el JSON envuelto como texto: se decodifica una segunda vez.
    if (typeof datos === "string") datos = JSON.parse(datos);
  } catch {
    // Con token inválido o sin resultados el DENUE a veces responde texto/HTML.
    if (/token/i.test(texto)) throw new Error("El DENUE rechazó el token. Revisa DENUE_TOKEN en .env.");
    return [];
  }
  return Array.isArray(datos) ? datos : [];
}

/** Mide la página con PageSpeed (versión celular). Gratis; la key es opcional y solo sube el límite. */
export async function medirPagina(url) {
  const params = new URLSearchParams({ url, strategy: "mobile", category: "performance", locale: "es" });
  if (settings.prospeccion.pagespeedKey) params.set("key", settings.prospeccion.pagespeedKey);
  try {
    const res = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`, {
      signal: AbortSignal.timeout(90_000),
    });
    const d = await res.json().catch(() => ({}));
    if (res.status === 429) return { estado: "limite", detalle: "Límite de PageSpeed alcanzado, se reintenta después" };
    const lh = d.lighthouseResult;
    if (!res.ok || !lh) {
      const msg = d.error?.message || `HTTP ${res.status}`;
      // Si Lighthouse no pudo abrir la página, eso también es un dato útil para el mensaje.
      if (/unable|FAILED_DOCUMENT_REQUEST|ERRORED_DOCUMENT_REQUEST|DNS|NO_FCP|timed out/i.test(msg)) {
        return { estado: "no_carga", detalle: msg.slice(0, 200) };
      }
      return { estado: "error", detalle: msg.slice(0, 200) };
    }
    const score = lh.categories?.performance?.score;
    const a = lh.audits || {};
    return {
      estado: "ok",
      puntaje: typeof score === "number" ? Math.round(score * 100) : null,
      lcp: a["largest-contentful-paint"]?.displayValue || null,
      carga: a["speed-index"]?.displayValue || null,
      https: !String(lh.finalDisplayedUrl || lh.finalUrl || url).startsWith("http:"),
    };
  } catch (e) {
    return { estado: "error", detalle: e.message };
  }
}

/** Revisa la página de inicio del negocio buscando un correo de contacto. */
export async function buscarCorreoEnWeb(url) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(12_000),
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; sss-solutions-prospector/1.0)" },
    });
    if (!res.ok || !/text\/html/i.test(res.headers.get("content-type") || "")) return { carga: res.ok, email: "" };
    const html = (await res.text()).slice(0, 600_000);
    const mailtos = [...html.matchAll(/mailto:([^"'?>\s]+)/gi)].map((m) => decodeURIComponent(m[1]));
    const sueltos = html.match(EMAIL_RE) || [];
    const email = [...mailtos, ...sueltos].map(limpiarEmail).find(Boolean) || "";
    return { carga: true, email };
  } catch {
    return { carga: false, email: "" };
  }
}
