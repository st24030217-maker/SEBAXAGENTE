// Marca real del negocio para su boceto: logo y fotos sacados de su propia página web.
// Con esto la muestra deja de verse genérica: sale con SU logo y SUS fotos (el local, sus bebidas).
// Se guarda en prospectos.marca como JSON {logo, fotos[], fuente}. Si no tiene página (o es solo
// Facebook/Instagram, que no se pueden leer), el boceto usa fotos de muestra distintas para cada negocio.
import { esRedSocial } from "./fuentes.js";

const IMG = /\.(jpe?g|png|webp)(\?|$)/i;
// Íconos, recortes chicos de WordPress, sprites, banderas, pagos, etc.
const DESCARTAR = /favicon|icon|sprite|placeholder|blank|pixel|spinner|loader|flag|bandera|visa|mastercard|paypal|whatsapp|facebook|instagram|tiktok|google|apple|-\d{2,3}x\d{2,3}\.|cropped-|avatar|gravatar|emoji|badge|wp-includes/i;

const abs = (u, base) => {
  try {
    return new URL(u.replace(/&amp;/g, "&"), base).href;
  } catch {
    return null;
  }
};

/** Extrae {logo, fotos} del HTML de una página (puro, para pruebas). */
export function marcaDeHtml(html, base) {
  const host = (() => {
    try {
      return new URL(base).host.replace(/^www\./, "");
    } catch {
      return "";
    }
  })();
  const propia = (u) => {
    try {
      return new URL(u).host.replace(/^www\./, "") === host;
    } catch {
      return false;
    }
  };
  // Logo: una <img> cuyo src, alt o clase diga "logo"; si no, el ícono grande (apple-touch-icon).
  let logo = null;
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/logo/i.test(tag)) continue;
    const src = tag.match(/\b(?:data-src|src)="([^"]+)"/i)?.[1];
    const u = src && abs(src, base);
    if (u && /\.(png|svg|webp|jpe?g)(\?|$)/i.test(u)) {
      // Preferir la versión completa de WordPress (sin -150x150)
      logo = u.replace(/-\d{2,4}x\d{2,4}(\.\w+)$/, "$1");
      break;
    }
  }
  if (!logo) {
    const ic = html.match(/<link[^>]+rel="apple-touch-icon"[^>]*href="([^"]+)"/i)?.[1] || html.match(/<link[^>]+href="([^"]+)"[^>]*rel="apple-touch-icon"/i)?.[1];
    if (ic) logo = abs(ic, base);
  }
  // Fotos: og:image + imágenes del contenido, solo de su propio dominio (no de bancos de fotos).
  const fotos = [];
  const og = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)?.[1];
  const candidatas = [og, ...[...html.matchAll(/\b(?:data-src|src|data-lazy-src)="([^"]+)"/gi)].map((m) => m[1])];
  for (const c of candidatas) {
    const u = c && abs(c, base);
    if (!u || !IMG.test(u) || !propia(u) || DESCARTAR.test(u) || /logo/i.test(u) || u === logo) continue;
    if (!fotos.includes(u)) fotos.push(u);
    if (fotos.length >= 8) break;
  }
  return { logo, fotos };
}

/**
 * ¿Es una dirección pública de internet? Evita que un "sitio web" falso (localhost, 192.168.x, 10.x…)
 * haga que el agente lea cosas de la red de la casa o del propio servidor.
 */
export function esPublica(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h.includes(".") || /(^|\.)(localhost|local|internal|lan|home)$/.test(h)) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return false;
  }
  if (h.includes(":")) return false; // IPv6 literal: no hace falta para páginas de negocios
  return true;
}

/** Ancho y alto de una imagen PNG, JPEG o WebP a partir de sus primeros bytes (o null). */
export function medidas(b) {
  if (b.length > 24 && b.toString("ascii", 1, 4) === "PNG") return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.length > 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const t = b.toString("ascii", 12, 16);
    if (t === "VP8X") return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    if (t === "VP8 ") return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (t === "VP8L") { const v = b.readUInt32LE(21); return { w: 1 + (v & 0x3fff), h: 1 + ((v >> 14) & 0x3fff) }; }
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

async function medir(url) {
  if (!esPublica(url)) return null;
  try {
    const res = await fetch(url, { headers: { Range: "bytes=0-131071", "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const lector = res.body.getReader();
    const partes = [];
    let n = 0;
    while (n < 131072) {
      const { value, done } = await lector.read();
      if (done) break;
      partes.push(value);
      n += value.length;
      const m = medidas(Buffer.concat(partes));
      if (m) { lector.cancel().catch(() => {}); return m; }
    }
    lector.cancel().catch(() => {});
    return medidas(Buffer.concat(partes));
  } catch {
    return null;
  }
}

/**
 * Lee la página del negocio y regresa {logo, fotos:[{u,w,h}], fuente} o null.
 * Las fotos chicas (menos de 360 px) se descartan; van primero las verticales grandes (mejores para portada).
 */
export async function extraerMarca(sitio) {
  if (!sitio || esRedSocial(sitio) || !esPublica(sitio)) return null;
  try {
    const res = await fetch(sitio, { headers: { "User-Agent": "Mozilla/5.0 (compatible; sss.solutions)" }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
    if (!res.ok || !esPublica(res.url || sitio)) return null; // también si redirigió a una dirección interna
    const html = (await res.text()).slice(0, 2_000_000);
    const m = marcaDeHtml(html, res.url || sitio);
    const fotos = [];
    for (const u of m.fotos) {
      const t = await medir(u);
      if (t && Math.min(t.w, t.h) >= 360) fotos.push({ u, w: t.w, h: t.h });
    }
    fotos.sort((a, b) => b.h / b.w + b.h / 4000 - (a.h / a.w + a.h / 4000));
    if (!m.logo && !fotos.length) return null;
    return { logo: m.logo, fotos, fuente: res.url || sitio };
  } catch {
    return null;
  }
}

/** La marca guardada de un prospecto (o null). */
export function marcaDe(p) {
  try {
    const m = p?.marca ? JSON.parse(p.marca) : null;
    return m && (m.logo || m.fotos?.length) ? m : null;
  } catch {
    return null;
  }
}
