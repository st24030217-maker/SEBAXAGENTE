// Motor de prospección: buscar negocios, analizarlos, redactar, y enviar la cola de correos aprobados.
import crypto from "node:crypto";
import nodemailer from "nodemailer";
import { settings } from "../config.js";
import { getDb, now, logEvent } from "../db.js";
import { localParts } from "../services/calendar.js";
import { getProspeccion } from "./config.js";
import { buscarDenue, desdeDenue, medirPagina, buscarCorreoEnWeb, esRedSocial } from "./fuentes.js";
import { calificar, redactar, pieCorreo } from "./redactar.js";
import { estadoIA, iaDisponible } from "../ia/proveedor.js";

export const ESTADOS = ["nuevo", "por_revisar", "aprobado", "enviado", "whatsapp", "respondio", "cliente", "descartado", "no_contactar", "fallido"];
const EDITABLES = ["asunto", "correo", "whatsapp_texto", "notas", "email", "telefono", "estado"];
const DIAS = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];

const db = () => getDb();
export const getProspecto = (id) => db().prepare("SELECT * FROM prospectos WHERE id = ?").get(Number(id));

// ---------- Guardar ----------

/** Inserta un prospecto si no existe ya (misma fuente+id, o mismo correo/teléfono). Devuelve true si es nuevo. */
export function guardarProspecto(p) {
  const d = db();
  if (p.externo_id && d.prepare("SELECT 1 FROM prospectos WHERE fuente = ? AND externo_id = ?").get(p.fuente, p.externo_id)) return false;
  if (p.email && d.prepare("SELECT 1 FROM prospectos WHERE email = ?").get(p.email)) return false;
  if (p.telefono && d.prepare("SELECT 1 FROM prospectos WHERE telefono = ?").get(p.telefono)) return false;
  const t = now();
  const cols = ["fuente", "externo_id", "nombre", "razon_social", "giro", "rubro", "ciudad", "direccion", "colonia", "telefono", "email", "sitio_web", "empleados", "lat", "lon"];
  d.prepare(
    `INSERT INTO prospectos (${cols.join(", ")}, baja_token, creado, actualizado) VALUES (${cols.map(() => "?").join(", ")}, ?, ?, ?)`
  ).run(...cols.map((c) => p[c] ?? null), crypto.randomBytes(16).toString("hex"), t, t);
  return true;
}

export function actualizarProspecto(id, campos) {
  const limpio = Object.fromEntries(Object.entries(campos).filter(([k, v]) => EDITABLES.includes(k) && v !== undefined));
  if (limpio.estado && !ESTADOS.includes(limpio.estado)) throw new Error("Estado inválido");
  if (!Object.keys(limpio).length) return getProspecto(id);
  const sets = Object.keys(limpio).map((k) => `${k} = ?`).join(", ");
  db().prepare(`UPDATE prospectos SET ${sets}, actualizado = ? WHERE id = ?`).run(...Object.values(limpio), now(), Number(id));
  return getProspecto(id);
}

// ---------- Buscar ----------

/**
 * Busca en el DENUE las combinaciones rubro × ciudad indicadas (índices de la config; vacío = todos).
 * Los nuevos quedan en estado "nuevo" y el analizador los procesa en segundo plano.
 */
export async function buscarProspectos({ rubros = [], ciudades = [] } = {}) {
  const cfg = getProspeccion();
  const rs = rubros.length ? rubros.map((i) => cfg.rubros[i]).filter(Boolean) : cfg.rubros;
  // Sin ciudades elegidas se busca solo en la zona propia (La Laguna): las demás son muchas y enormes.
  const cs = ciudades.length ? ciudades.map((i) => cfg.ciudades[i]).filter(Boolean) : cfg.ciudades.filter((c) => c.local);
  const tope = Number(cfg.automatico.maximo_por_busqueda) || Infinity;
  let encontrados = 0;
  let nuevos = 0;
  let sinContacto = 0;
  const errores = [];
  for (const rubro of rs) {
    for (const ciudad of cs) {
      try {
        const regs = await buscarDenue({ palabras: rubro.palabras, lat: ciudad.lat, lon: ciudad.lon, radio: cfg.radio_metros });
        encontrados += regs.length;
        const candidatos = [];
        for (const reg of regs) {
          const p = desdeDenue(reg, ciudad, rubro);
          // Muchos registros del DENUE no traen teléfono, correo ni web: no hay cómo contactarlos.
          if (!p.nombre || (!p.email && !p.telefono && !p.sitio_web)) {
            sinContacto++;
            continue;
          }
          if (/sin nombre/i.test(p.nombre)) p.nombre = `${rubro.nombre.replace(/s$/, "")} en ${p.colonia || ciudad.nombre}`;
          candidatos.push([calificar(p, cfg).puntaje, p]);
        }
        // En ciudades grandes salen miles: se guardan primero los más prometedores, hasta el tope.
        // Los demás se quedan para la próxima vuelta de esta misma búsqueda.
        candidatos.sort((a, b) => b[0] - a[0]);
        let deEsta = 0;
        for (const [, p] of candidatos) {
          if (deEsta >= tope) break;
          if (guardarProspecto(p)) {
            nuevos++;
            deEsta++;
          }
        }
      } catch (e) {
        errores.push(`${rubro.nombre} en ${ciudad.nombre}: ${e.message}`);
        if (/token/i.test(e.message)) return { encontrados, nuevos, sinContacto, errores };
      }
    }
  }
  logEvent("prospeccion_busqueda", null, { encontrados, nuevos, sinContacto, errores: errores.length });
  despertarAnalizador();
  return { encontrados, nuevos, sinContacto, errores };
}

// ---------- Analizar (PageSpeed + correo en su web + puntaje + borrador) ----------

export async function analizarProspecto(id, { forzarMedicion = false } = {}) {
  const cfg = getProspeccion();
  let p = getProspecto(id);
  if (!p) throw new Error("No existe el prospecto");
  const d = db();
  const detalle = {};
  if (p.sitio_web && !esRedSocial(p.sitio_web) && (forzarMedicion || p.web_puntaje === null)) {
    const web = await buscarCorreoEnWeb(p.sitio_web);
    detalle.carga = web.carga;
    if (web.email && !p.email) d.prepare("UPDATE prospectos SET email = ? WHERE id = ?").run(web.email, p.id);
    if (web.carga && Date.now() < pageSpeedPausadoHasta) {
      detalle.estado = "sin_medir";
    } else if (web.carga) {
      const m = await medirPagina(p.sitio_web);
      if (m.estado === "limite") {
        // Sin API key, Google permite pocas mediciones: se pausa una hora y se sigue sin medir
        // para no bloquear la fila de análisis.
        pageSpeedPausadoHasta = Date.now() + 3600_000;
        console.warn("[prospeccion] PageSpeed llegó a su límite; se mide de nuevo en 1 h");
        detalle.estado = "sin_medir";
      } else Object.assign(detalle, m);
    } else {
      detalle.estado = "no_carga";
    }
    d.prepare("UPDATE prospectos SET web_puntaje = ?, web_detalle = ? WHERE id = ?").run(detalle.puntaje ?? null, JSON.stringify(detalle), p.id);
    p = getProspecto(id);
  }
  const { puntaje, razones } = calificar(p, cfg);
  // Con Gemini gratis, el análisis masivo usa plantillas para no gastar la cuota diaria:
  // la IA se reserva para conversar con quien responde y para "Redactar otra vez".
  const msg = await redactar(p, cfg, { ia: estadoIA().activa !== "gemini" });
  d.prepare(
    `UPDATE prospectos SET puntaje = ?, razones = ?, asunto = ?, correo = ?, whatsapp_texto = ?, error = NULL,
       estado = CASE WHEN estado = 'nuevo' THEN 'por_revisar' ELSE estado END, actualizado = ? WHERE id = ?`
  ).run(puntaje, JSON.stringify(razones), msg.asunto, msg.correo, msg.whatsapp, now(), p.id);
  // Piloto automático: los mejores prospectos con correo pueden aprobarse solos (si así se configuró).
  const umbral = Number(cfg.automatico.aprobar_solos_desde_puntaje || 0);
  // Solo si el correo está configurado: si no, "aprobado" haría que se salten la fila de WhatsApp.
  if (umbral > 0 && puntaje >= umbral && correoConfigurado()) {
    const r = d
      .prepare("UPDATE prospectos SET estado = 'aprobado', notas = TRIM(COALESCE(notas,'') || char(10) || 'Aprobado automáticamente por puntaje') WHERE id = ? AND estado = 'por_revisar' AND IFNULL(email,'') != '' AND fuente != 'ejemplo'")
      .run(p.id);
    if (r.changes) logEvent("prospecto_autoaprobado", null, { prospecto: p.id, puntaje });
  }
  return getProspecto(id);
}

// ---------- Búsqueda automática ----------

/**
 * Negocios "listos" por rubro: a los que el agente ya puede escribirles (aprobados, o pendientes con
 * puntaje suficiente y teléfono) más los nuevos que aún se están analizando.
 */
export function listosPorRubro() {
  const umbral = Number(getProspeccion().automatico.aprobar_solos_desde_puntaje || 0);
  const filas = db()
    .prepare(
      `SELECT rubro, COUNT(*) n FROM prospectos WHERE fuente != 'ejemplo' AND (
         estado IN ('aprobado', 'nuevo')
         OR (estado = 'por_revisar' AND puntaje >= ? AND (? = 0 OR IFNULL(telefono,'') != ''))
       ) GROUP BY rubro`
    )
    .all(umbral, umbral);
  return Object.fromEntries(filas.map((f) => [f.rubro, f.n]));
}

/**
 * Elige la siguiente búsqueda: el rubro con menos negocios listos (por debajo de la meta), en la primera
 * ciudad que no se haya buscado hace poco, empezando por La Laguna. null = no hace falta buscar.
 */
function siguienteBusqueda(cfg, ahora) {
  const a = cfg.automatico;
  const listos = listosPorRubro();
  const desde = new Date(ahora.getTime() - Number(a.repetir_busqueda_dias || 14) * 86400_000).toISOString();
  const recientes = new Set(
    db()
      .prepare("SELECT datos FROM eventos WHERE tipo = 'prospeccion_auto' AND creado >= ?")
      .all(desde)
      .map((e) => {
        try {
          const d = JSON.parse(e.datos || "{}");
          return `${d.rubro}|${d.ciudad}`;
        } catch {
          return "";
        }
      })
  );
  const ciudades = [...cfg.ciudades.map((c, i) => [c, i]).filter(([c]) => c.local), ...cfg.ciudades.map((c, i) => [c, i]).filter(([c]) => !c.local)];
  const rubros = cfg.rubros
    .map((r, i) => [r, i, listos[r.nombre] || 0])
    .filter(([, , n]) => n < Number(a.listos_por_rubro || 40))
    .sort((x, y) => x[2] - y[2] || x[1] - y[1]);
  for (const [r, ri, n] of rubros) {
    for (const [c, ci] of ciudades) {
      if (!recientes.has(`${r.nombre}|${c.nombre}`)) return { ri, ci, rubro: r.nombre, ciudad: c.nombre, listos: n };
    }
  }
  return null;
}

export function estadoAutomatico(ahora = new Date()) {
  const cfg = getProspeccion();
  const a = cfg.automatico;
  const ultimo = db().prepare("SELECT creado, datos FROM eventos WHERE tipo = 'prospeccion_auto' ORDER BY id DESC LIMIT 1").get();
  const pendientes = db().prepare("SELECT COUNT(*) n FROM prospectos WHERE estado IN ('nuevo','por_revisar')").get().n;
  const sig = siguienteBusqueda(cfg, ahora);
  const proxima = ultimo ? new Date(new Date(ultimo.creado).getTime() + a.cada_horas * 3600_000) : ahora;
  let motivo = null;
  if (!a.buscar) motivo = "apagada";
  else if (!settings.prospeccion.denueToken) motivo = "falta DENUE_TOKEN";
  else if (pendientes >= a.maximo_por_revisar) motivo = `pausada: tienes ${pendientes} por revisar (máx. ${a.maximo_por_revisar})`;
  else if (!sig) motivo = `en espera: todos los rubros tienen ${a.listos_por_rubro} o más negocios listos (o ya se buscaron hace poco)`;
  return {
    activa: !!a.buscar,
    cadaHoras: a.cada_horas,
    aprobarDesde: Number(a.aprobar_solos_desde_puntaje || 0),
    proxima: proxima.toISOString(),
    siguiente: sig ? `${sig.rubro} en ${sig.ciudad}` : null,
    ultimo: ultimo ? { fecha: ultimo.creado, ...JSON.parse(ultimo.datos || "{}") } : null,
    motivo,
    _sig: sig,
  };
}

/** Si toca, busca la siguiente combinación rubro + ciudad. Se llama desde el ciclo de prospección. */
export async function busquedaAutomatica(ahora = new Date()) {
  const e = estadoAutomatico(ahora);
  if (e.motivo || new Date(e.proxima) > ahora) return null;
  const { ri, ci, rubro, ciudad } = e._sig;
  const base = { busqueda: e.siguiente, rubro, ciudad };
  // Se registra antes de buscar: si el INEGI falla, no se reintenta en bucle cada 30 s.
  const ev = db()
    .prepare("INSERT INTO eventos (tipo, conversacion_id, datos, creado) VALUES ('prospeccion_auto', NULL, ?, ?)")
    .run(JSON.stringify(base), ahora.toISOString());
  const r = await buscarProspectos({ rubros: [ri], ciudades: [ci] });
  db().prepare("UPDATE eventos SET datos = ? WHERE id = ?").run(JSON.stringify({ ...base, nuevos: r.nuevos, encontrados: r.encontrados, errores: r.errores.length }), ev.lastInsertRowid);
  console.log(`[prospeccion] búsqueda automática: ${e.siguiente} → ${r.nuevos} nuevos`);
  return r;
}

export async function reRedactar(id) {
  const p = getProspecto(id);
  if (!p) throw new Error("No existe el prospecto");
  const msg = await redactar(p, getProspeccion(), { seguimiento: p.envios > 0 });
  db().prepare("UPDATE prospectos SET asunto = ?, correo = ?, whatsapp_texto = ?, actualizado = ? WHERE id = ?").run(msg.asunto, msg.correo, msg.whatsapp, now(), p.id);
  return getProspecto(id);
}

let analizando = false;
let pageSpeedPausadoHasta = 0;
let despertar = null;
export function despertarAnalizador() {
  despertar?.();
}

async function cicloAnalizador() {
  if (analizando) return;
  analizando = true;
  try {
    for (;;) {
      const p = db().prepare("SELECT id FROM prospectos WHERE estado = 'nuevo' ORDER BY id LIMIT 1").get();
      if (!p) break;
      try {
        await analizarProspecto(p.id);
      } catch (e) {
        console.error(`[prospeccion] análisis #${p.id}:`, e.message);
        db().prepare("UPDATE prospectos SET error = ? WHERE id = ?").run(e.message, p.id);
        if (/límite/i.test(e.message)) break; // PageSpeed saturado: se reintenta en el próximo ciclo
        db().prepare("UPDATE prospectos SET estado = 'por_revisar' WHERE id = ? AND estado = 'nuevo'").run(p.id);
      }
    }
  } finally {
    analizando = false;
  }
}

// ---------- Correo ----------

let transporte = null;
export const correoConfigurado = () => !!(settings.smtp.user && settings.smtp.pass);

function getTransporte() {
  if (!correoConfigurado()) throw new Error("Falta configurar SMTP_USER y SMTP_PASS en .env");
  transporte ??= nodemailer.createTransport({
    host: settings.smtp.host,
    port: settings.smtp.port,
    secure: settings.smtp.port === 465,
    auth: { user: settings.smtp.user, pass: settings.smtp.pass },
  });
  return transporte;
}

const urlPublica = () => !/localhost|127\.0\.0\.1|192\.168\.|10\.\d/.test(settings.publicUrl);

/**
 * Envía un correo. pie=true agrega firma + opción de baja (prospección); en conversaciones
 * se usa firma corta. inReplyTo/references mantienen el hilo en Gmail.
 */
export async function enviarCorreo({ para, asunto, texto, bajaToken, pie = true, firma = "", inReplyTo, references, adjuntos }) {
  const cfg = getProspeccion();
  const bajaUrl = bajaToken && urlPublica() ? `${settings.publicUrl}/baja/${bajaToken}` : null;
  const from = `"${settings.smtp.fromName || `${cfg.remitente.nombre} | ${cfg.remitente.empresa}`}" <${settings.smtp.user}>`;
  return getTransporte().sendMail({
    from,
    to: para,
    subject: asunto,
    text: texto + (pie ? pieCorreo(cfg, bajaUrl) : firma),
    ...(inReplyTo ? { inReplyTo, references: references || inReplyTo } : {}),
    ...(adjuntos ? { attachments: adjuntos } : {}),
    headers: pie
      ? { "List-Unsubscribe": [`<mailto:${settings.smtp.user}?subject=BAJA>`, bajaUrl && `<${bajaUrl}>`].filter(Boolean).join(", ") }
      : {},
  });
}

export async function correoDePrueba() {
  await getTransporte().verify();
  const cfg = getProspeccion();
  await enviarCorreo({
    para: settings.smtp.user,
    asunto: "Prueba del agente de prospección",
    texto: `Hola ${cfg.remitente.nombre.split(" ")[0]}, si te llegó este correo, el envío funciona.`,
  });
  return { ok: true, para: settings.smtp.user };
}

export function dentroDeHorarioEnvio(cfg, ahora = new Date()) {
  const e = cfg.envio;
  const p = localParts(ahora, e.zona_horaria);
  if (!e.dias.includes(DIAS[p.weekday])) return false;
  const min = p.h * 60 + p.mi;
  const aMin = (s) => s.split(":").map(Number).reduce((h, m) => h * 60 + m);
  return min >= aMin(e.hora_inicio) && min < aMin(e.hora_fin);
}

export function enviadosUltimas24h(ahora = new Date()) {
  const desde = new Date(ahora.getTime() - 24 * 3600_000).toISOString();
  return db().prepare("SELECT COUNT(*) n FROM eventos WHERE tipo = 'prospecto_correo' AND creado >= ?").get(desde).n;
}

/** Envía UN correo de la cola si toca (horario, límite diario y espacio entre correos). */
export async function enviarSiguiente(ahora = new Date()) {
  const cfg = getProspeccion();
  if (!correoConfigurado() || !dentroDeHorarioEnvio(cfg, ahora)) return null;
  if (enviadosUltimas24h(ahora) >= cfg.envio.limite_diario) return null;
  const ultimo = db().prepare("SELECT MAX(creado) t FROM eventos WHERE tipo = 'prospecto_correo'").get().t;
  if (ultimo && ahora.getTime() - new Date(ultimo).getTime() < cfg.envio.minutos_entre_correos * 60_000) return null;

  const p = db()
    .prepare("SELECT * FROM prospectos WHERE estado = 'aprobado' AND email IS NOT NULL AND email != '' AND fuente != 'ejemplo' ORDER BY puntaje DESC, id LIMIT 1")
    .get();
  if (!p) return null;
  // Se marca antes de enviar para no mandar dos veces si algo se corta a la mitad.
  db().prepare("UPDATE prospectos SET estado = 'enviado', envios = envios + 1, ultimo_envio = ?, actualizado = ? WHERE id = ?").run(now(), now(), p.id);
  try {
    await enviarCorreo({ para: p.email, asunto: p.asunto, texto: p.correo, bajaToken: p.baja_token });
    logEvent("prospecto_correo", null, { prospecto: p.id, email: p.email, envio: p.envios + 1 });
    return p.id;
  } catch (e) {
    console.error(`[prospeccion] correo a #${p.id}:`, e.message);
    db().prepare("UPDATE prospectos SET estado = 'fallido', envios = envios - 1, error = ? WHERE id = ?").run(e.message, p.id);
    if (/auth|login|credentials|535|534/i.test(e.message)) transporte = null;
    return null;
  }
}

/** Prepara un correo de seguimiento para quienes no respondieron (queda "por revisar"). */
export async function prepararSeguimientos(ahora = new Date()) {
  const cfg = getProspeccion();
  const dias = Number(cfg.envio.dias_para_seguimiento || 0);
  if (!dias) return 0;
  const limite = new Date(ahora.getTime() - dias * 86400_000).toISOString();
  const rows = db().prepare("SELECT * FROM prospectos WHERE estado = 'enviado' AND envios = 1 AND ultimo_envio <= ? LIMIT 5").all(limite);
  for (const p of rows) {
    const msg = await redactar(p, cfg, { seguimiento: true });
    db()
      .prepare("UPDATE prospectos SET asunto = ?, correo = ?, whatsapp_texto = ?, estado = 'por_revisar', notas = TRIM(COALESCE(notas,'') || char(10) || ?), actualizado = ? WHERE id = ?")
      .run(msg.asunto, msg.correo, msg.whatsapp, `Seguimiento preparado el ${ahora.toISOString().slice(0, 10)} (no respondió al primer correo)`, now(), p.id);
  }
  return rows.length;
}

// ---------- Baja (no volver a contactar) ----------

export function darDeBaja(token) {
  const p = db().prepare("SELECT * FROM prospectos WHERE baja_token = ?").get(String(token));
  if (!p) return null;
  db().prepare("UPDATE prospectos SET estado = 'no_contactar', actualizado = ? WHERE id = ?").run(now(), p.id);
  logEvent("prospecto_baja", null, { prospecto: p.id });
  return p;
}

// ---------- Ejemplos para probar sin token ----------

export function cargarEjemplos() {
  const ejemplos = [
    { nombre: "Tacos El Güero (ejemplo)", rubro: "Taquerías y comida", giro: "Restaurantes con servicio de preparación de tacos y tortas", ciudad: "Torreón", colonia: "Centro", direccion: "Av. Morelos 123", telefono: "8710000001", empleados: "6 a 10 personas" },
    { nombre: "Barbería Los Compas (ejemplo)", rubro: "Barberías", giro: "Salones y clínicas de belleza y peluquerías", ciudad: "Gómez Palacio", colonia: "Las Rosas", direccion: "Calle Hidalgo 45", telefono: "8710000002", email: "ejemplo-barberia@example.invalid", sitio_web: "https://facebook.com/barberialoscompas", empleados: "0 a 5 personas" },
    { nombre: "Boutique Mariana (ejemplo)", rubro: "Tiendas y boutiques", giro: "Comercio al por menor de ropa", ciudad: "Lerdo", colonia: "Centro", direccion: "Av. Madero 210", email: "ejemplo-boutique@example.invalid", sitio_web: "https://boutique-ejemplo.invalid", empleados: "0 a 5 personas" },
    { nombre: "Gimnasio Fuerza Lagunera (ejemplo)", rubro: "Gimnasios", giro: "Centros de acondicionamiento físico", ciudad: "Torreón", colonia: "Campestre La Rosita", direccion: "Blvd. Independencia 900", telefono: "8710000004", email: "ejemplo-gym@example.invalid", empleados: "11 a 30 personas" },
    { nombre: "Consultorio Dental Sonrisa (ejemplo)", rubro: "Consultorios", giro: "Consultorios dentales del sector privado", ciudad: "Torreón", colonia: "Torreón Jardín", direccion: "Calle Árbol 77", telefono: "8710000005", email: "ejemplo-dental@example.invalid", empleados: "6 a 10 personas" },
  ];
  let n = 0;
  for (const [i, e] of ejemplos.entries()) {
    if (guardarProspecto({ fuente: "ejemplo", externo_id: `ej-${i + 1}`, ...e })) n++;
  }
  // La boutique simula una página lenta para ver cómo se ve ese caso.
  db().prepare("UPDATE prospectos SET web_puntaje = 34, web_detalle = ? WHERE fuente = 'ejemplo' AND externo_id = 'ej-3'").run(JSON.stringify({ estado: "ok", puntaje: 34, carga: "7.8 s" }));
  despertarAnalizador();
  return n;
}

export function borrarEjemplos() {
  return db().prepare("DELETE FROM prospectos WHERE fuente = 'ejemplo'").run().changes;
}

// ---------- Resumen para el panel ----------

export function resumenProspeccion() {
  const cfg = getProspeccion();
  const porEstado = Object.fromEntries(db().prepare("SELECT estado, COUNT(*) n FROM prospectos GROUP BY estado").all().map((r) => [r.estado, r.n]));
  return {
    porEstado,
    total: Object.values(porEstado).reduce((a, b) => a + b, 0),
    enviados24h: enviadosUltimas24h(),
    limiteDiario: cfg.envio.limite_diario,
    enHorario: dentroDeHorarioEnvio(cfg),
    horario: `${cfg.envio.dias.join(", ")} · ${cfg.envio.hora_inicio}-${cfg.envio.hora_fin}`,
    analizando,
    rubros: cfg.rubros.map((r) => r.nombre),
    ciudades: cfg.ciudades.map((c) => c.nombre),
    remitente: cfg.remitente,
    automatico: (({ _sig, ...e }) => e)(estadoAutomatico()),
    config: {
      denue: !!settings.prospeccion.denueToken,
      correo: correoConfigurado(),
      correoUsuario: settings.smtp.user || null,
      claude: iaDisponible(),
      ia: estadoIA(),
      urlPublica: urlPublica(),
    },
  };
}

// ---------- Arranque ----------

/** Vuelve a calcular el puntaje de los pendientes (al cambiar las reglas o las ciudades de la config). */
export function recalificarPendientes() {
  const cfg = getProspeccion();
  const upd = db().prepare("UPDATE prospectos SET puntaje = ?, razones = ? WHERE id = ?");
  let cambiados = 0;
  for (const p of db().prepare("SELECT * FROM prospectos WHERE estado = 'por_revisar'").all()) {
    const { puntaje, razones } = calificar(p, cfg);
    if (puntaje !== p.puntaje) cambiados++;
    upd.run(puntaje, JSON.stringify(razones), p.id);
  }
  if (cambiados) console.log(`[prospeccion] puntaje recalculado: ${cambiados} pendientes cambiaron`);
  return cambiados;
}

export function startProspeccion(intervaloMs = 30_000) {
  if (!settings.prospeccion.activo) return null;
  try {
    recalificarPendientes();
  } catch (e) {
    console.error("[prospeccion] no se pudo recalcular puntajes:", e.message);
  }
  let corriendo = false;
  const tick = async () => {
    if (corriendo) return;
    corriendo = true;
    try {
      cicloAnalizador().catch((e) => console.error("[prospeccion] analizador:", e.message));
      await prepararSeguimientos();
      await enviarSiguiente();
      await busquedaAutomatica();
    } catch (e) {
      console.error("[prospeccion]", e.message);
    } finally {
      corriendo = false;
    }
  };
  despertar = () => cicloAnalizador().catch((e) => console.error("[prospeccion] analizador:", e.message));
  setTimeout(tick, 3_000);
  return setInterval(tick, intervaloMs);
}
