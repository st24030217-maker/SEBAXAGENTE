// Chat web: API que usa el widget (public/widget.js) que pegas en tu página.
import { Router } from "express";
import { handleIncoming } from "../agent/agent.js";
import { getDb } from "../db.js";
import { getNegocio } from "../config.js";
import { rateLimited } from "./index.js";

const SESION_OK = /^[A-Za-z0-9_-]{8,64}$/;

export function webRouter() {
  const r = Router();

  // Datos públicos para el widget (nombre del negocio y del agente).
  r.get("/info", (_req, res) => {
    const n = getNegocio();
    res.json({ negocio: n.negocio.nombre, agente: n.agente?.nombre || "Asistente" });
  });

  r.post("/", async (req, res) => {
    const { sesion, mensaje, nombre } = req.body || {};
    if (!SESION_OK.test(sesion || "")) return res.status(400).json({ error: "sesion inválida" });
    if (!mensaje || typeof mensaje !== "string" || !mensaje.trim()) return res.status(400).json({ error: "mensaje vacío" });
    if (rateLimited(`web:${sesion}`) || rateLimited(`ip:${req.ip}`, 60)) return res.status(429).json({ error: "Demasiados mensajes, espera un momento." });
    try {
      const { respuesta } = await handleIncoming({ canal: "web", externoId: sesion, texto: mensaje.slice(0, 2000), nombre: nombre || null });
      res.json({ respuesta, ultimoId: ultimoId(sesion) });
    } catch (e) {
      console.error("[web]", e);
      res.status(500).json({ error: "Error interno" });
    }
  });

  // El widget consulta mensajes nuevos (seguimientos o respuestas de un humano).
  r.get("/mensajes", (req, res) => {
    const { sesion } = req.query;
    const desde = Number(req.query.desde || 0);
    if (!SESION_OK.test(sesion || "")) return res.status(400).json({ error: "sesion inválida" });
    const mensajes = getDb()
      .prepare("SELECT id, rol, texto, creado FROM mensajes WHERE conversacion_id = ? AND id > ? AND rol != 'sistema' ORDER BY id")
      .all(`web:${sesion}`, desde);
    res.json({ mensajes });
  });

  return r;
}

function ultimoId(sesion) {
  return getDb().prepare("SELECT MAX(id) AS id FROM mensajes WHERE conversacion_id = ?").get(`web:${sesion}`)?.id || 0;
}

/** En la web los mensajes proactivos ya quedan guardados; el widget los recoge consultando /api/chat/mensajes. */
export async function pushWeb() {}
