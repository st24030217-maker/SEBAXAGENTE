import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { settings } from "./config.js";

let db;

export function getDb() {
  if (!db) openDb(settings.dbPath);
  return db;
}

/** Abre (o crea) la base de datos. ":memory:" sirve para tests. */
export function openDb(file) {
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Restauración pendiente (subida desde el panel): reemplaza la base antes de abrirla.
    const pendiente = `${file}.restaurar`;
    if (fs.existsSync(pendiente)) {
      if (fs.existsSync(file)) fs.renameSync(file, `${file}.antes-de-restaurar`);
      for (const ext of ["-wal", "-shm"]) fs.rmSync(file + ext, { force: true });
      fs.renameSync(pendiente, file);
      console.log("[db] respaldo restaurado");
    }
  }
  db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

export const now = () => new Date().toISOString();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversaciones (
  id                      TEXT PRIMARY KEY,          -- "<canal>:<id externo>"
  canal                   TEXT NOT NULL,             -- web | whatsapp | messenger | instagram | telegram
  externo_id              TEXT NOT NULL,
  nombre                  TEXT,
  bot_activo              INTEGER NOT NULL DEFAULT 1,
  historial               TEXT NOT NULL DEFAULT '[]', -- mensajes en formato API de Claude (solo se agregan, nunca se editan)
  ultimo_mensaje_cliente  TEXT,
  ultimo_mensaje_agente   TEXT,
  seguimientos_enviados   INTEGER NOT NULL DEFAULT 0,
  creado                  TEXT NOT NULL,
  actualizado             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mensajes (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  conversacion_id  TEXT NOT NULL REFERENCES conversaciones(id),
  rol              TEXT NOT NULL,   -- cliente | agente | humano | sistema
  texto            TEXT NOT NULL,
  creado           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mensajes_conv ON mensajes(conversacion_id, id);

CREATE TABLE IF NOT EXISTS leads (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  conversacion_id  TEXT NOT NULL UNIQUE REFERENCES conversaciones(id),
  nombre           TEXT,
  telefono         TEXT,
  email            TEXT,
  empresa          TEXT,
  necesidad        TEXT,
  presupuesto      TEXT,
  etapa            TEXT NOT NULL DEFAULT 'nuevo', -- nuevo | interesado | cotizado | negociacion | ganado | perdido
  puntaje          INTEGER,                        -- 1-10, probabilidad de compra estimada por el agente
  motivo_perdida   TEXT,
  notas            TEXT,
  creado           TEXT NOT NULL,
  actualizado      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cotizaciones (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  conversacion_id  TEXT NOT NULL REFERENCES conversaciones(id),
  items            TEXT NOT NULL,  -- JSON [{id, nombre, precio, cantidad, subtotal}]
  subtotal         REAL NOT NULL,
  descuento_pct    REAL NOT NULL DEFAULT 0,
  descuento_monto  REAL NOT NULL DEFAULT 0,
  envio            REAL NOT NULL DEFAULT 0,
  total            REAL NOT NULL,
  moneda           TEXT NOT NULL,
  notas            TEXT,
  valida_hasta     TEXT NOT NULL,
  creado           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pedidos (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  conversacion_id  TEXT NOT NULL REFERENCES conversaciones(id),
  cotizacion_id    INTEGER NOT NULL REFERENCES cotizaciones(id),
  total            REAL NOT NULL,
  moneda           TEXT NOT NULL,
  estado           TEXT NOT NULL DEFAULT 'pendiente_pago', -- pendiente_pago | pagado | enviado | entregado | cancelado
  metodo_pago      TEXT,
  link_pago        TEXT,
  pago_ref         TEXT,
  entrega          TEXT,   -- despacho | retiro
  direccion        TEXT,
  datos_facturacion TEXT,
  creado           TEXT NOT NULL,
  actualizado      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS citas (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  conversacion_id  TEXT NOT NULL REFERENCES conversaciones(id),
  inicio           TEXT NOT NULL,  -- ISO UTC
  fin              TEXT NOT NULL,
  tipo             TEXT,
  notas            TEXT,
  estado           TEXT NOT NULL DEFAULT 'confirmada', -- confirmada | cancelada | realizada
  recordatorio_enviado INTEGER NOT NULL DEFAULT 0,
  creado           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS seguimientos (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  conversacion_id  TEXT NOT NULL REFERENCES conversaciones(id),
  ejecutar_en      TEXT NOT NULL,
  contexto         TEXT,
  origen           TEXT NOT NULL DEFAULT 'agente', -- agente | automatico
  estado           TEXT NOT NULL DEFAULT 'pendiente', -- pendiente | enviado | cancelado | fallido
  creado           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seg_pend ON seguimientos(estado, ejecutar_en);

CREATE TABLE IF NOT EXISTS eventos (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo             TEXT NOT NULL,
  conversacion_id  TEXT,
  datos            TEXT,
  creado           TEXT NOT NULL
);

-- Prospección: negocios encontrados por el agente para contactarlos.
CREATE TABLE IF NOT EXISTS prospectos (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  fuente           TEXT NOT NULL,              -- denue | ejemplo | manual
  externo_id       TEXT,                       -- Id del DENUE
  nombre           TEXT NOT NULL,
  razon_social     TEXT,
  giro             TEXT,
  rubro            TEXT,                       -- rubro de config/prospeccion.yaml que lo encontró
  ciudad           TEXT,
  direccion        TEXT,
  colonia          TEXT,
  telefono         TEXT,
  email            TEXT,
  sitio_web        TEXT,
  empleados        TEXT,                       -- estrato del DENUE, p. ej. "6 a 10 personas"
  lat              REAL,
  lon              REAL,
  web_puntaje      INTEGER,                    -- PageSpeed móvil 0-100 (null = sin analizar o sin web)
  web_detalle      TEXT,                       -- JSON con métricas
  puntaje          INTEGER NOT NULL DEFAULT 0, -- 0-10, qué tan buen prospecto es
  razones          TEXT,                       -- JSON: por qué tiene ese puntaje
  asunto           TEXT,
  correo           TEXT,
  whatsapp_texto   TEXT,
  estado           TEXT NOT NULL DEFAULT 'nuevo',
    -- nuevo | por_revisar | aprobado | enviado | whatsapp | respondio | cliente | descartado | no_contactar
  envios           INTEGER NOT NULL DEFAULT 0,
  ultimo_envio     TEXT,
  error            TEXT,
  notas            TEXT,
  baja_token       TEXT NOT NULL,
  creado           TEXT NOT NULL,
  actualizado      TEXT NOT NULL,
  UNIQUE (fuente, externo_id)
);
CREATE INDEX IF NOT EXISTS idx_prosp_estado ON prospectos(estado, puntaje DESC);

CREATE TABLE IF NOT EXISTS uso_ia (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  conversacion_id  TEXT,
  modelo           TEXT,
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  cache_read       INTEGER,
  cache_write      INTEGER,
  creado           TEXT NOT NULL
);
`;

// ---------- Conversaciones ----------

export function getOrCreateConversation(canal, externoId, nombre = null) {
  const d = getDb();
  const id = `${canal}:${externoId}`;
  let conv = d.prepare("SELECT * FROM conversaciones WHERE id = ?").get(id);
  if (!conv) {
    const t = now();
    d.prepare(
      "INSERT INTO conversaciones (id, canal, externo_id, nombre, creado, actualizado) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, canal, String(externoId), nombre, t, t);
    logEvent("conversacion_nueva", id, { canal });
    conv = d.prepare("SELECT * FROM conversaciones WHERE id = ?").get(id);
  } else if (nombre && !conv.nombre) {
    d.prepare("UPDATE conversaciones SET nombre = ? WHERE id = ?").run(nombre, id);
    conv.nombre = nombre;
  }
  return conv;
}

export function getConversation(id) {
  return getDb().prepare("SELECT * FROM conversaciones WHERE id = ?").get(id);
}

export function loadHistory(convId) {
  const row = getDb().prepare("SELECT historial FROM conversaciones WHERE id = ?").get(convId);
  return row ? JSON.parse(row.historial) : [];
}

export function saveHistory(convId, history) {
  getDb()
    .prepare("UPDATE conversaciones SET historial = ?, actualizado = ? WHERE id = ?")
    .run(JSON.stringify(history), now(), convId);
}

export function addTranscript(convId, rol, texto) {
  const d = getDb();
  const t = now();
  d.prepare("INSERT INTO mensajes (conversacion_id, rol, texto, creado) VALUES (?, ?, ?, ?)").run(convId, rol, texto, t);
  if (rol === "cliente") {
    d.prepare(
      "UPDATE conversaciones SET ultimo_mensaje_cliente = ?, seguimientos_enviados = 0, actualizado = ? WHERE id = ?"
    ).run(t, t, convId);
    // Si el cliente vuelve a escribir, los seguimientos automáticos pendientes ya no aplican.
    d.prepare(
      "UPDATE seguimientos SET estado = 'cancelado' WHERE conversacion_id = ? AND estado = 'pendiente' AND origen = 'automatico'"
    ).run(convId);
  } else if (rol === "agente" || rol === "humano") {
    d.prepare("UPDATE conversaciones SET ultimo_mensaje_agente = ?, actualizado = ? WHERE id = ?").run(t, t, convId);
  }
}

export function setBotActive(convId, active) {
  getDb().prepare("UPDATE conversaciones SET bot_activo = ?, actualizado = ? WHERE id = ?").run(active ? 1 : 0, now(), convId);
}

// ---------- Leads ----------

export function getLead(convId) {
  return getDb().prepare("SELECT * FROM leads WHERE conversacion_id = ?").get(convId);
}

const LEAD_FIELDS = ["nombre", "telefono", "email", "empresa", "necesidad", "presupuesto", "etapa", "puntaje", "motivo_perdida", "notas"];

export function upsertLead(convId, fields) {
  const d = getDb();
  const t = now();
  const clean = Object.fromEntries(
    Object.entries(fields).filter(([k, v]) => LEAD_FIELDS.includes(k) && v !== undefined && v !== null && v !== "")
  );
  const existing = getLead(convId);
  if (!existing) {
    const cols = Object.keys(clean);
    d.prepare(
      `INSERT INTO leads (conversacion_id, ${cols.concat(["creado", "actualizado"]).join(", ")})
       VALUES (?, ${cols.map(() => "?").join(", ")}${cols.length ? ", " : ""}?, ?)`
    ).run(convId, ...Object.values(clean), t, t);
    logEvent("lead_nuevo", convId, clean);
  } else if (Object.keys(clean).length) {
    if (clean.notas && existing.notas) clean.notas = `${existing.notas}\n${clean.notas}`;
    const sets = Object.keys(clean).map((k) => `${k} = ?`).join(", ");
    d.prepare(`UPDATE leads SET ${sets}, actualizado = ? WHERE conversacion_id = ?`).run(...Object.values(clean), t, convId);
  }
  if (clean.nombre) d.prepare("UPDATE conversaciones SET nombre = COALESCE(nombre, ?) WHERE id = ?").run(clean.nombre, convId);
  return getLead(convId);
}

// ---------- Eventos y uso ----------

export function logEvent(tipo, convId, datos = {}) {
  getDb()
    .prepare("INSERT INTO eventos (tipo, conversacion_id, datos, creado) VALUES (?, ?, ?, ?)")
    .run(tipo, convId, JSON.stringify(datos), now());
}

export function logUsage(convId, model, usage) {
  if (!usage) return;
  getDb()
    .prepare(
      "INSERT INTO uso_ia (conversacion_id, modelo, input_tokens, output_tokens, cache_read, cache_write, creado) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      convId,
      model,
      usage.input_tokens ?? 0,
      usage.output_tokens ?? 0,
      usage.cache_read_input_tokens ?? 0,
      usage.cache_creation_input_tokens ?? 0,
      now()
    );
}
