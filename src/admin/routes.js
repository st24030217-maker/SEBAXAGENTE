// API del panel de administración (/admin). Protegida con ADMIN_TOKEN.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { DatabaseSync } from "node:sqlite";
import { Router } from "express";
import { settings, reloadNegocio, getNegocio } from "../config.js";
import { negocioActual } from "../contexto.js";
import { rutasPanelNegocio, rutasNegociosPrincipal } from "./negocios.js";
import { getDb, getConversation, getLead, upsertLead, setBotActive, now, logEvent } from "../db.js";
import { recordOutgoing } from "../agent/agent.js";
import { ETAPAS } from "../agent/tools.js";
import { sendToChannel } from "../channels/index.js";
import { setOrderStatus } from "../services/orders.js";
import { reloadProspeccion, getProspeccion } from "../prospeccion/config.js";
import { urlBoceto, baseBocetos, bocetosFijos } from "../prospeccion/boceto.js";
import { publicada, asegurarPublicada } from "../prospeccion/publicar.js";
import { probarGcal, gcalConfigurado } from "../services/gcal.js";
import { estadoWa, desconectarWa, enviadosWaHoy, limiteWaHoy, pedirCodigoVinculacion, avisarDueno, numeroDueno, videoPresentacion, probarPrimerMensaje, sendWaDocumento, sendWaVideoArchivo, avisarDuenoMedia } from "../channels/wa-web.js";
import {
  ESTADOS as ESTADOS_PROSPECTO,
  getProspecto,
  actualizarProspecto,
  buscarProspectos,
  analizarProspecto,
  reRedactar,
  correoDePrueba,
  cargarEjemplos,
  borrarEjemplos,
  resumenProspeccion,
} from "../prospeccion/servicio.js";

// USD por millón de tokens: [entrada, salida, lectura caché, escritura caché]. Estimación.
const PRECIOS = {
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
  gemini: [0, 0, 0, 0], // plan gratis de Google AI Studio
};

// Dentro de la red de casa (PC o celular en el mismo WiFi) no se pide contraseña.
// Se usa la IP real de la conexión (no cabeceras), y si la petición llega por un túnel/proxy
// (trae X-Forwarded-For) se exige el token igual.
const IP_LOCAL = /^(::1|127\.|::ffff:127\.|10\.|::ffff:10\.|192\.168\.|::ffff:192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::ffff:172\.(1[6-9]|2\d|3[01])\.)/;
export function esRedLocal(req) {
  if (!/^(1|true|si|sí|yes)$/i.test(process.env.ADMIN_SIN_TOKEN_EN_RED_LOCAL ?? "true")) return false;
  if (req.get("x-forwarded-for") || req.get("cf-connecting-ip") || req.get("forwarded")) return false;
  return IP_LOCAL.test(req.socket?.remoteAddress || "");
}

// Panel abierto (ADMIN_ABIERTO=true): se entra sin contraseña desde cualquier lugar.
// Aun así, estas acciones delicadas siempre la piden: reemplazar o descargar todos los datos y desvincular WhatsApp.
const SIEMPRE_CON_CLAVE = ["/respaldo", "/restaurar", "/whatsapp/desconectar", "/whatsapp/codigo"];
const panelAbierto = () => /^(1|true|si|sí|yes)$/i.test(process.env.ADMIN_ABIERTO || "");

const claveIgual = (token, esperado) =>
  !!esperado &&
  esperado !== "cambia-esta-clave" &&
  token.length === esperado.length &&
  crypto.timingSafeEqual(Buffer.from(token), Buffer.from(esperado));

// Contra adivinar la clave a lo bruto: 10 claves equivocadas en 15 min desde la misma IP la bloquean 15 min.
// (Solo cuentan los intentos que sí mandan una clave: el panel sin sesión no se bloquea a sí mismo.)
const FALLOS_MAX = Number(process.env.ADMIN_FALLOS_MAX || 10);
const VENTANA_FALLOS = 15 * 60_000;
const fallos = new Map(); // ip -> [tiempos]
export function bloqueadoPorFallos(ip, ahora = Date.now()) {
  const xs = (fallos.get(ip) || []).filter((t) => ahora - t < VENTANA_FALLOS);
  fallos.set(ip, xs);
  return xs.length >= FALLOS_MAX;
}
export function registrarFallo(ip, ahora = Date.now()) {
  const xs = (fallos.get(ip) || []).filter((t) => ahora - t < VENTANA_FALLOS);
  xs.push(ahora);
  fallos.set(ip, xs);
  if (fallos.size > 5000) fallos.clear();
  if (xs.length === FALLOS_MAX) console.warn(`[admin] ${ip} bloqueada 15 min por ${FALLOS_MAX} claves equivocadas`);
}

function auth(req, res, next) {
  if (esRedLocal(req)) return next();
  const token = req.get("x-admin-token") || "";
  const ip = req.ip || "?";
  if (bloqueadoPorFallos(ip)) return res.status(429).json({ error: "Demasiadas claves equivocadas. Espera 15 minutos." });
  const rechazar = (status, cuerpo) => {
    if (token) registrarFallo(ip);
    return res.status(status).json(cuerpo);
  };
  const n = negocioActual();
  if (n) {
    // Panel de un negocio cliente: entra su dueño con su clave, o tú con la tuya (ADMIN_TOKEN).
    // ADMIN_ABIERTO no aplica aquí: el panel de cada negocio siempre pide clave.
    if (claveIgual(token, n.meta.token) || claveIgual(token, settings.adminToken)) return next();
    return rechazar(401, { error: "Clave incorrecta. Pídele a sss.solutions la clave de tu panel." });
  }
  if (panelAbierto() && !SIEMPRE_CON_CLAVE.includes(req.path)) return next();
  if (!claveIgual(token, settings.adminToken)) return rechazar(401, { error: "No autorizado. Revisa ADMIN_TOKEN en .env (y que no sea el valor de ejemplo)." });
  next();
}

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    console.error("[admin]", e);
    res.status(400).json({ error: e.message });
  }
};

/**
 * @param {{negocio?: boolean}} opciones negocio=true: panel de un negocio cliente (/n/<slug>/admin),
 *   sin prospección y con su propio WhatsApp. Sin opciones: tu panel principal.
 */
export function adminRouter({ negocio: esNegocio = false } = {}) {
  const r = Router();
  r.use(auth);
  const db = () => getDb();

  r.get("/resumen", wrap((req, res) => {
    const dias = Math.max(1, Math.min(365, Number(req.query.dias || 30)));
    const desde = new Date(Date.now() - dias * 86400_000).toISOString();
    const one = (sql, ...p) => db().prepare(sql).get(...p);
    const conversaciones = one("SELECT COUNT(*) n FROM conversaciones WHERE creado >= ?", desde).n;
    const leads = one("SELECT COUNT(*) n FROM leads WHERE creado >= ?", desde).n;
    const cotizaciones = one("SELECT COUNT(*) n, COALESCE(SUM(total),0) monto FROM cotizaciones WHERE creado >= ?", desde);
    const pedidos = one("SELECT COUNT(*) n, COALESCE(SUM(total),0) monto FROM pedidos WHERE creado >= ? AND estado != 'cancelado'", desde);
    const pagados = one(
      "SELECT COUNT(*) n, COALESCE(SUM(total),0) monto FROM pedidos WHERE creado >= ? AND estado IN ('pagado','enviado','entregado')",
      desde
    );
    const citas = one("SELECT COUNT(*) n FROM citas WHERE creado >= ? AND estado != 'cancelada'", desde).n;
    const derivaciones = one("SELECT COUNT(*) n FROM eventos WHERE tipo = 'derivacion' AND creado >= ?", desde).n;
    const embudo = db()
      .prepare("SELECT etapa, COUNT(*) n FROM leads WHERE creado >= ? GROUP BY etapa")
      .all(desde);
    const porCanal = db()
      .prepare("SELECT canal, COUNT(*) n FROM conversaciones WHERE creado >= ? GROUP BY canal")
      .all(desde);
    const ventasPorDia = db()
      .prepare(
        "SELECT substr(creado,1,10) dia, COUNT(*) pedidos, SUM(total) monto FROM pedidos WHERE creado >= ? AND estado IN ('pagado','enviado','entregado') GROUP BY dia ORDER BY dia"
      )
      .all(desde);
    const uso = db()
      .prepare(
        "SELECT modelo, SUM(input_tokens) i, SUM(output_tokens) o, SUM(cache_read) cr, SUM(cache_write) cw, COUNT(*) llamadas FROM uso_ia WHERE creado >= ? GROUP BY modelo"
      )
      .all(desde);
    let costoUsd = 0;
    for (const u of uso) {
      const base = Object.keys(PRECIOS).find((k) => (u.modelo || "").startsWith(k));
      const [pi, po, pcr, pcw] = PRECIOS[base] || PRECIOS["claude-opus-5-5"];
      costoUsd += (u.i * pi + u.o * po + u.cr * pcr + u.cw * pcw) / 1e6;
    }
    res.json({
      dias,
      moneda: getNegocio().negocio.moneda,
      conversaciones,
      leads,
      cotizaciones,
      pedidos,
      pagados,
      citas,
      derivaciones,
      conversion: conversaciones ? Math.round((pagados.n / conversaciones) * 1000) / 10 : 0,
      embudo,
      porCanal,
      ventasPorDia,
      ia: { llamadas: uso.reduce((s, u) => s + u.llamadas, 0), costoUsdEstimado: Math.round(costoUsd * 100) / 100 },
    });
  }));

  r.get("/conversaciones", wrap((req, res) => {
    const q = `%${(req.query.q || "").trim()}%`;
    const filtro = req.query.filtro || "todas";
    const extra = filtro === "pausadas" ? "AND c.bot_activo = 0" : "";
    const rows = db()
      .prepare(
        `SELECT c.id, c.canal, c.nombre, c.bot_activo, c.actualizado, c.ultimo_mensaje_cliente,
                l.etapa, l.puntaje, l.telefono, l.email,
                (SELECT texto FROM mensajes m WHERE m.conversacion_id = c.id ORDER BY m.id DESC LIMIT 1) ultimo
         FROM conversaciones c LEFT JOIN leads l ON l.conversacion_id = c.id
         WHERE (c.id LIKE ? OR IFNULL(c.nombre,'') LIKE ? OR IFNULL(l.email,'') LIKE ? OR IFNULL(l.telefono,'') LIKE ?) ${extra}
         ORDER BY c.actualizado DESC LIMIT 200`
      )
      .all(q, q, q, q);
    res.json(rows);
  }));

  r.get("/conversaciones/:id", wrap((req, res) => {
    const id = req.params.id;
    const conv = getConversation(id);
    if (!conv) return res.status(404).json({ error: "No existe" });
    delete conv.historial;
    const all = (sql) => db().prepare(sql).all(id);
    res.json({
      conversacion: conv,
      lead: getLead(id) || null,
      mensajes: all("SELECT id, rol, texto, creado FROM mensajes WHERE conversacion_id = ? ORDER BY id"),
      cotizaciones: all("SELECT * FROM cotizaciones WHERE conversacion_id = ? ORDER BY id DESC"),
      pedidos: all("SELECT * FROM pedidos WHERE conversacion_id = ? ORDER BY id DESC"),
      citas: all("SELECT * FROM citas WHERE conversacion_id = ? ORDER BY inicio DESC"),
      seguimientos: all("SELECT * FROM seguimientos WHERE conversacion_id = ? ORDER BY id DESC"),
    });
  }));

  r.post("/conversaciones/:id/bot", wrap((req, res) => {
    const conv = getConversation(req.params.id);
    if (!conv) return res.status(404).json({ error: "No existe" });
    setBotActive(conv.id, !!req.body?.activo);
    logEvent(req.body?.activo ? "bot_reactivado" : "bot_pausado", conv.id, {});
    res.json({ ok: true });
  }));

  r.post("/conversaciones/:id/mensaje", wrap(async (req, res) => {
    const conv = getConversation(req.params.id);
    if (!conv) return res.status(404).json({ error: "No existe" });
    const texto = String(req.body?.texto || "").trim();
    if (!texto) return res.status(400).json({ error: "Mensaje vacío" });
    await sendToChannel(conv.canal, conv.externo_id, texto, {
      proactivo: true,
      ultimoMensajeCliente: conv.ultimo_mensaje_cliente,
      humano: true,
    });
    // origen "automatizacion" = lo envía n8n u otra integración: no pausa al agente.
    const automatico = req.body?.origen === "automatizacion";
    await recordOutgoing(
      conv.id,
      texto,
      automatico ? "agente" : "humano",
      automatico ? "El sistema de automatizaciones" : "Un asesor humano del equipo"
    );
    // Cuando un humano escribe, el agente se pausa para no interrumpir (se puede reactivar).
    if (!automatico && req.body?.pausarBot !== false) setBotActive(conv.id, false);
    res.json({ ok: true });
  }));

  // Manda un PDF (por ejemplo, una cotización) a una conversación de WhatsApp.
  // Cuerpo: el PDF tal cual. Query: ?nombre=Archivo.pdf&texto=Mensaje que va abajo
  // También acepta un video MP4 (sale como video con el texto abajo).
  r.post("/conversaciones/:id/archivo", express.raw({ type: ["application/pdf", "video/mp4"], limit: "16mb" }), wrap(async (req, res) => {
    const conv = getConversation(req.params.id);
    if (!conv) return res.status(404).json({ error: "No existe" });
    if (conv.canal !== "wa") return res.status(400).json({ error: "Solo se pueden mandar archivos por WhatsApp" });
    const esPdf = Buffer.isBuffer(req.body) && req.body.subarray(0, 4).toString() === "%PDF";
    const esMp4 = Buffer.isBuffer(req.body) && req.body.subarray(4, 8).toString() === "ftyp";
    if (!esPdf && !esMp4) {
      return res.status(400).json({ error: "Manda un PDF (Content-Type: application/pdf) o un MP4 (video/mp4)" });
    }
    if (esMp4) {
      const texto = String(req.query.texto || "").trim();
      await sendWaVideoArchivo(conv.externo_id, req.body, texto);
      await recordOutgoing(conv.id, `${texto ? `${texto}\n` : ""}[Video enviado]`, "humano", "Sebastián (envío de video)");
      logEvent("archivo_enviado", conv.id, { nombre: "video.mp4", bytes: req.body.length });
      return res.json({ ok: true, nombre: "video.mp4" });
    }
    const nombre = String(req.query.nombre || "Documento.pdf").replace(/[\\/]/g, "-").slice(0, 120);
    const texto = String(req.query.texto || "").trim();
    await sendWaDocumento(conv.externo_id, req.body, nombre, texto);
    await recordOutgoing(conv.id, `${texto ? `${texto}\n` : ""}[Archivo enviado: ${nombre}]`, "agente", "El equipo (envío de archivo)");
    logEvent("archivo_enviado", conv.id, { nombre, bytes: req.body.length });
    res.json({ ok: true, nombre });
  }));

  r.get("/leads", wrap((req, res) => {
    const etapa = req.query.etapa;
    const rows = etapa
      ? db().prepare("SELECT l.*, c.canal FROM leads l JOIN conversaciones c ON c.id = l.conversacion_id WHERE l.etapa = ? ORDER BY l.actualizado DESC").all(etapa)
      : db().prepare("SELECT l.*, c.canal FROM leads l JOIN conversaciones c ON c.id = l.conversacion_id ORDER BY l.actualizado DESC").all();
    res.json(rows);
  }));

  r.patch("/leads/:convId", wrap((req, res) => {
    const { etapa, notas, puntaje } = req.body || {};
    if (etapa && !ETAPAS.includes(etapa)) throw new Error("Etapa inválida");
    res.json(upsertLead(req.params.convId, { etapa, notas: notas ? `[equipo] ${notas}` : undefined, puntaje }));
  }));

  r.get("/leads.csv", wrap((_req, res) => {
    const rows = db()
      .prepare(
        "SELECT l.nombre, l.telefono, l.email, l.empresa, l.necesidad, l.presupuesto, l.etapa, l.puntaje, c.canal, l.notas, l.creado, l.actualizado FROM leads l JOIN conversaciones c ON c.id = l.conversacion_id ORDER BY l.creado DESC"
      )
      .all();
    const cols = ["nombre", "telefono", "email", "empresa", "necesidad", "presupuesto", "etapa", "puntaje", "canal", "notas", "creado", "actualizado"];
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = "﻿" + [cols.join(";"), ...rows.map((r) => cols.map((c) => esc(r[c])).join(";"))].join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="leads-${now().slice(0, 10)}.csv"`);
    res.send(csv);
  }));

  r.get("/pedidos", wrap((_req, res) => {
    res.json(
      db()
        .prepare(
          "SELECT p.*, c.nombre, c.canal, q.items FROM pedidos p JOIN conversaciones c ON c.id = p.conversacion_id JOIN cotizaciones q ON q.id = p.cotizacion_id ORDER BY p.id DESC LIMIT 300"
        )
        .all()
    );
  }));

  r.post("/pedidos/:id/estado", wrap(async (req, res) => {
    res.json(await setOrderStatus(req.params.id, req.body?.estado, { avisarCliente: req.body?.avisarCliente !== false }));
  }));

  r.get("/citas", wrap((_req, res) => {
    res.json(
      db()
        .prepare("SELECT ci.*, c.nombre, c.canal FROM citas ci JOIN conversaciones c ON c.id = ci.conversacion_id ORDER BY ci.inicio DESC LIMIT 300")
        .all()
    );
  }));

  r.post("/citas/:id/estado", wrap((req, res) => {
    const estado = req.body?.estado;
    if (!["confirmada", "cancelada", "realizada"].includes(estado)) throw new Error("Estado inválido");
    db().prepare("UPDATE citas SET estado = ? WHERE id = ?").run(estado, Number(req.params.id));
    res.json({ ok: true });
  }));

  r.get("/seguimientos", wrap((_req, res) => {
    res.json(
      db()
        .prepare("SELECT s.*, c.nombre, c.canal FROM seguimientos s JOIN conversaciones c ON c.id = s.conversacion_id ORDER BY s.id DESC LIMIT 300")
        .all()
    );
  }));

  r.post("/seguimientos/:id/cancelar", wrap((req, res) => {
    db().prepare("UPDATE seguimientos SET estado = 'cancelado' WHERE id = ? AND estado = 'pendiente'").run(Number(req.params.id));
    res.json({ ok: true });
  }));

  r.post("/recargar-config", wrap((_req, res) => {
    const n = reloadNegocio();
    if (!esNegocio) reloadProspeccion();
    res.json({ ok: true, productos: n.catalogo.length });
  }));

  if (esNegocio) {
    // Panel de un negocio cliente: su WhatsApp, su configuración y su respaldo. Nada de prospección.
    rutasPanelNegocio(r, wrap);
    r.get("/respaldo", wrap((_req, res) => {
      const tmp = path.join(os.tmpdir(), `agente-respaldo-${Date.now()}.db`);
      db().exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      res.download(tmp, `${negocioActual().slug}-respaldo-${now().slice(0, 10)}.db`, () => fs.rm(tmp, { force: true }, () => {}));
    }));
    return r;
  }

  // Tus negocios cliente (alta, lista, activar/pausar). Solo en tu panel.
  rutasNegociosPrincipal(r, wrap);

  r.get("/config", wrap((_req, res) => {
    res.json({
      negocio: getNegocio().negocio.nombre,
      modelo: settings.claude.model,
      esfuerzo: settings.claude.effort,
      pagos: settings.payments.provider,
      canales: {
        web: true,
        whatsapp: !!settings.whatsapp.token,
        messenger_instagram: !!settings.meta.pageToken,
        telegram: !!settings.telegram.token,
      },
      avisos: { telegram: !!settings.owner.telegramChatId, webhook: !!settings.owner.webhookUrl },
    });
  }));

  // ---------- Respaldo y restauración (para pasar los datos de la PC a la nube) ----------

  r.get("/respaldo", wrap((_req, res) => {
    const tmp = path.join(os.tmpdir(), `agente-respaldo-${Date.now()}.db`);
    db().exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    res.download(tmp, `agente-respaldo-${now().slice(0, 10)}.db`, () => fs.rm(tmp, { force: true }, () => {}));
  }));

  r.post("/restaurar", express.raw({ type: "application/octet-stream", limit: "300mb" }), wrap((req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length < 1024 || buf.subarray(0, 15).toString() !== "SQLite format 3") {
      throw new Error("El archivo no es un respaldo válido del agente (.db).");
    }
    const destino = `${settings.dbPath}.restaurar`;
    fs.writeFileSync(destino, buf);
    // Se verifica que sea una base del agente antes de aceptarla.
    try {
      const prueba = new DatabaseSync(destino, { readOnly: true });
      const tablas = prueba.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
      prueba.close();
      if (!tablas.includes("conversaciones")) throw new Error("no tiene las tablas del agente");
    } catch (e) {
      fs.rmSync(destino, { force: true });
      throw new Error("El respaldo no es válido: " + e.message);
    }
    res.json({ ok: true, mensaje: "Respaldo recibido. El agente se reinicia en unos segundos para cargarlo." });
    logEvent("respaldo_restaurado", null, { bytes: buf.length });
    // Se reinicia el proceso: Render (o el servicio de Windows) lo vuelve a levantar con la base nueva.
    setTimeout(() => process.exit(1), 800);
  }));

  // ---------- Prospección ----------

  r.get("/prospeccion", wrap(async (_req, res) => {
    const wa = await estadoWa();
    const lim = limiteWaHoy();
    res.json({ ...resumenProspeccion(), calendario: gcalConfigurado(), whatsapp: { ...wa, qr: undefined, enviadosHoy: enviadosWaHoy(), limite: lim.limite, calentamiento: lim, video: !!videoPresentacion() } });
  }));

  // WhatsApp (chip aparte): estado y QR para vincular.
  r.get("/whatsapp", wrap(async (_req, res) => res.json(await estadoWa())));
  r.post("/whatsapp/codigo", wrap(async (req, res) => res.json(await pedirCodigoVinculacion(req.body?.numero || undefined))));
  r.post("/whatsapp/desconectar", wrap(async (_req, res) => { await desconectarWa(); res.json({ ok: true }); }));
  // Comprueba la conexión con tu Google Calendar (lee tus horas ocupadas de los próximos 7 días).
  r.get("/calendario/prueba", wrap(async (_req, res) => {
    try {
      res.json(await probarGcal());
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message });
    }
  }));
  // Te manda el primer mensaje (video + texto) como lo recibiría un negocio.
  r.post("/whatsapp/primer-mensaje-prueba", wrap(async (_req, res) => res.json(await probarPrimerMensaje())));
  // Manda un aviso de prueba a tu WhatsApp personal, para comprobar que te llegan.
  r.post("/whatsapp/aviso-prueba", wrap(async (_req, res) => {
    const ok = await avisarDueno(`*Agente Sebax · Aviso de prueba*\n\nAsí te van a llegar los avisos: cuando un negocio conteste, cuando se agende una cita o cuando alguien pida hablar contigo.\n\nPanel: ${settings.publicUrl}/admin`);
    if (!ok) return res.status(409).json({ error: "No se pudo: revisa que el chip esté conectado y que tu número personal sea distinto al del chip." });
    res.json({ ok: true, numero: numeroDueno() });
  }));

  // Te manda un PDF (por ejemplo, una cotización), un video MP4 o una imagen PNG/JPG a tu WhatsApp personal (OWNER_WHATSAPP).
  // Cuerpo: el PDF o el MP4. Query: ?nombre=Archivo.pdf&texto=Mensaje&numero=10 dígitos (debe coincidir con el tuyo)
  r.post("/whatsapp/archivo-dueno", express.raw({ type: ["application/pdf", "video/mp4", "image/png", "image/jpeg"], limit: "16mb" }), wrap(async (req, res) => {
    const tel = numeroDueno();
    if (!tel) return res.status(409).json({ error: "No hay número personal configurado (OWNER_WHATSAPP)" });
    if (req.query.numero && String(req.query.numero).replace(/\D/g, "").slice(-10) !== tel) {
      return res.status(409).json({ error: "El número no coincide con tu número personal configurado" });
    }
    const esPdf = Buffer.isBuffer(req.body) && req.body.subarray(0, 4).toString() === "%PDF";
    const esMp4 = Buffer.isBuffer(req.body) && req.body.subarray(4, 8).toString() === "ftyp";
    const esImagen = Buffer.isBuffer(req.body) && req.body.length > 8 &&
      (req.body.readUInt32BE(0) === 0x89504e47 || req.body.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])));
    // Las imágenes llegan como foto (lista para guardar y publicar), no como archivo.
    if (esImagen) {
      if (!(await avisarDuenoMedia({ image: req.body }, String(req.query.texto || "").trim()))) {
        return res.status(409).json({ error: "No se pudo: revisa que el chip esté conectado" });
      }
      logEvent("archivo_enviado_dueno", null, { nombre: "imagen", bytes: req.body.length });
      return res.json({ ok: true, numero: tel, nombre: "imagen" });
    }
    if (!esPdf && !esMp4) {
      return res.status(400).json({ error: "Manda un PDF (application/pdf), un MP4 (video/mp4) o una imagen (image/png, image/jpeg)" });
    }
    if (esMp4) {
      await sendWaVideoArchivo(tel, req.body, String(req.query.texto || "").trim());
      logEvent("archivo_enviado_dueno", null, { nombre: "video.mp4", bytes: req.body.length });
      return res.json({ ok: true, numero: tel, nombre: "video.mp4" });
    }
    const nombre = String(req.query.nombre || "Documento.pdf").replace(/[\\/]/g, "-").slice(0, 120);
    await sendWaDocumento(tel, req.body, nombre, String(req.query.texto || "").trim());
    logEvent("archivo_enviado_dueno", null, { nombre, bytes: req.body.length });
    res.json({ ok: true, numero: tel, nombre });
  }));

  // Aprueba de golpe los N mejores "por revisar" que tengan teléfono (o correo).
  r.post("/prospeccion/aprobar-lote", wrap((req, res) => {
    const n = Math.max(1, Math.min(100, Number(req.body?.cantidad || 10)));
    const filtroRubro = req.body?.rubro ? "AND rubro = ?" : "";
    const ids = db()
      .prepare(`SELECT id FROM prospectos WHERE estado = 'por_revisar' AND (IFNULL(telefono,'') != '' OR IFNULL(email,'') != '') AND IFNULL(whatsapp_texto,'') != '' AND fuente != 'ejemplo' ${filtroRubro} ORDER BY puntaje DESC, id LIMIT ?`)
      .all(...(req.body?.rubro ? [req.body.rubro] : []), n)
      .map((r) => r.id);
    for (const id of ids) actualizarProspecto(id, { estado: "aprobado" });
    res.json({ aprobados: ids.length });
  }));

  r.post("/prospeccion/buscar", wrap(async (req, res) => {
    const nums = (a) => (Array.isArray(a) ? a.map(Number).filter((n) => Number.isInteger(n) && n >= 0) : []);
    res.json(await buscarProspectos({ rubros: nums(req.body?.rubros), ciudades: nums(req.body?.ciudades) }));
  }));

  r.post("/prospeccion/ejemplos", wrap((_req, res) => res.json({ nuevos: cargarEjemplos() })));
  r.delete("/prospeccion/ejemplos", wrap((_req, res) => res.json({ borrados: borrarEjemplos() })));
  r.post("/prospeccion/prueba-correo", wrap(async (_req, res) => res.json(await correoDePrueba())));

  r.get("/prospectos", wrap((req, res) => {
    const estado = String(req.query.estado || "");
    const q = `%${String(req.query.q || "").trim()}%`;
    const exacto = ESTADOS_PROSPECTO.includes(estado);
    const filtro = exacto ? "AND estado = ?" : estado === "activos" ? "AND estado NOT IN ('descartado','no_contactar')" : "";
    const rows = db()
      .prepare(
        `SELECT id, fuente, nombre, giro, rubro, ciudad, colonia, telefono, email, sitio_web, empleados, web_puntaje, puntaje, razones, estado, envios, ultimo_envio, error, actualizado
         FROM prospectos
         WHERE (nombre LIKE ? OR IFNULL(email,'') LIKE ? OR IFNULL(colonia,'') LIKE ? OR IFNULL(giro,'') LIKE ?) ${filtro}
         ORDER BY puntaje DESC, id DESC LIMIT 300`
      )
      .all(q, q, q, q, ...(exacto ? [estado] : []));
    res.json(rows);
  }));

  r.get("/prospectos/:id", wrap((req, res) => {
    const p = getProspecto(req.params.id);
    if (!p) return res.status(404).json({ error: "No existe" });
    const vistas = db().prepare("SELECT COUNT(*) n FROM eventos WHERE tipo = 'boceto_visto' AND json_extract(datos, '$.prospecto') = ?").get(p.id).n;
    // Desde el panel se abre con ?yo=1 para que tus propias vistas no cuenten como del negocio.
    // Si aún no está en GitHub Pages, se abre desde el agente (el link fijo todavía no existe).
    const fija = publicada(p);
    const url = fija ? urlBoceto(p) : urlBoceto(p).replace(baseBocetos(), settings.publicUrl);
    res.json({ ...p, boceto_url: `${url}?yo=1`, boceto_fijo: fija ? urlBoceto(p) : null, boceto_vistas: vistas });
  }));

  // Publica la muestra en su link fijo (GitHub Pages) SIN aprobar ni mandarle nada al negocio.
  r.post("/prospectos/:id/publicar", wrap(async (req, res) => {
    const p = getProspecto(req.params.id);
    if (!p) return res.status(404).json({ error: "No existe" });
    if (["no_contactar", "descartado"].includes(p.estado)) throw new Error("Este negocio está descartado o pidió no ser contactado.");
    if (!p.boceto) throw new Error("Este negocio todavía no tiene boceto.");
    if (!bocetosFijos()) throw new Error("Las muestras fijas (GitHub Pages) no están configuradas.");
    db().prepare("UPDATE prospectos SET publicado = 1, actualizado = ? WHERE id = ?").run(now(), p.id);
    const abre = await asegurarPublicada(getProspecto(p.id));
    res.json({ ok: true, abre, url: urlBoceto(p) });
  }));

  r.patch("/prospectos/:id", wrap((req, res) => {
    if (!getProspecto(req.params.id)) return res.status(404).json({ error: "No existe" });
    res.json(actualizarProspecto(req.params.id, req.body || {}));
  }));

  r.post("/prospectos/:id/aprobar", wrap((req, res) => {
    const p = getProspecto(req.params.id);
    if (!p) return res.status(404).json({ error: "No existe" });
    if (p.estado === "no_contactar") throw new Error("Este negocio pidió no ser contactado.");
    const asunto = req.body?.asunto ?? p.asunto;
    const correo = req.body?.correo ?? p.correo;
    const whatsapp_texto = req.body?.whatsapp_texto ?? p.whatsapp_texto;
    if (!p.telefono && !p.email) throw new Error("Este negocio no tiene teléfono ni correo.");
    if (p.telefono ? !whatsapp_texto : !(asunto && correo)) throw new Error("Todavía no hay mensaje redactado.");
    res.json(actualizarProspecto(p.id, { asunto, correo, whatsapp_texto, estado: "aprobado" }));
  }));

  r.post("/prospectos/:id/redactar", wrap(async (req, res) => res.json(await reRedactar(req.params.id))));
  r.post("/prospectos/:id/analizar", wrap(async (req, res) => res.json(await analizarProspecto(req.params.id, { forzarMedicion: true }))));

  return r;
}
