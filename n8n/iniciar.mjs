// Inicia n8n local conectado al agente de ventas:   npm run n8n
// - Usa el Node 24 portátil de n8n/runtime (no toca el Node de tu equipo).
// - Guarda todo en n8n/data (flujos, credenciales, historial).
// - La primera vez importa y activa los flujos de n8n/workflows.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import YAML from "yaml";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, "..");
const appEnv = dotenv.parse(fs.existsSync(path.join(RAIZ, ".env")) ? fs.readFileSync(path.join(RAIZ, ".env")) : "");

const runtimeDir = fs.existsSync(path.join(AQUI, "runtime"))
  ? fs.readdirSync(path.join(AQUI, "runtime")).find((d) => d.startsWith("node-v24"))
  : null;
if (!runtimeDir) {
  console.error("❌ Falta el Node 24 portátil en n8n/runtime. Revisa n8n/LEEME.md, sección 'Instalación desde cero'.");
  process.exit(1);
}
const NODE_DIR = path.join(AQUI, "runtime", runtimeDir);
const NODE = path.join(NODE_DIR, process.platform === "win32" ? "node.exe" : "bin/node");
const N8N = path.join(AQUI, "node_modules", "n8n", "bin", "n8n");
if (!fs.existsSync(N8N)) {
  console.log("📦 Instalando n8n (solo la primera vez, tarda unos minutos)...");
  const npmCli = path.join(NODE_DIR, process.platform === "win32" ? "" : "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const r = spawnSync(NODE, [npmCli, "install", "--no-audit", "--no-fund"], {
    cwd: AQUI,
    stdio: "inherit",
    env: { ...process.env, PATH: `${path.dirname(NODE)}${path.delimiter}${process.env.PATH}` },
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

let zona = "America/Santiago";
try {
  zona = YAML.parse(fs.readFileSync(path.join(RAIZ, "config", "negocio.yaml"), "utf8")).negocio.zona_horaria || zona;
} catch {}

const DATA = path.join(AQUI, "data");
const RESPALDOS = path.join(AQUI, "respaldos");
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(RESPALDOS, { recursive: true });

const PUERTO = process.env.N8N_PORT || "5678";
const env = {
  ...process.env,
  PATH: `${path.dirname(NODE)}${path.delimiter}${process.env.PATH}`,
  N8N_USER_FOLDER: DATA,
  N8N_PORT: PUERTO,
  N8N_HOST: "localhost",
  N8N_EDITOR_BASE_URL: `http://localhost:${PUERTO}`,
  WEBHOOK_URL: `http://localhost:${PUERTO}/`,
  N8N_SECURE_COOKIE: "false",
  N8N_DIAGNOSTICS_ENABLED: "false",
  N8N_PERSONALIZATION_ENABLED: "false",
  N8N_VERSION_NOTIFICATIONS_ENABLED: "false",
  N8N_BLOCK_ENV_ACCESS_IN_NODE: "false",
  N8N_RESTRICT_FILE_ACCESS_TO: RESPALDOS,
  N8N_RESPALDOS: RESPALDOS,
  GENERIC_TIMEZONE: zona,
  TZ: zona,
  // Datos del agente que usan los flujos
  AGENTE_URL: `http://localhost:${appEnv.PORT || 3000}`,
  AGENTE_ADMIN_TOKEN: appEnv.ADMIN_TOKEN || "",
  OWNER_TELEGRAM_CHAT_ID: appEnv.OWNER_TELEGRAM_CHAT_ID || "",
};

const n8n = (args, opts = {}) => spawnSync(NODE, [N8N, ...args], { env, stdio: "inherit", ...opts });

// Primera vez (o si agregas flujos nuevos): importar y activar.
const marca = path.join(DATA, ".flujos-importados");
const flujos = fs.readdirSync(path.join(AQUI, "workflows")).filter((f) => f.endsWith(".json")).sort().join(",");
if (!fs.existsSync(marca) || fs.readFileSync(marca, "utf8") !== flujos || process.argv.includes("--reimportar")) {
  console.log("📥 Importando flujos de n8n/workflows ...");
  const r = n8n(["import:workflow", "--separate", `--input=${path.join(AQUI, "workflows")}`]);
  if (r.status !== 0) process.exit(r.status ?? 1);
  for (const f of fs.readdirSync(path.join(AQUI, "workflows")).filter((x) => x.endsWith(".json"))) {
    const wf = JSON.parse(fs.readFileSync(path.join(AQUI, "workflows", f), "utf8"));
    if (wf.active) n8n(["publish:workflow", `--id=${wf.id}`]);
  }
  fs.writeFileSync(marca, flujos);
}

if (!env.AGENTE_ADMIN_TOKEN) console.warn("⚠  Falta ADMIN_TOKEN en el .env del agente: los flujos no podrán leer datos.");
console.log(`\n🚀 Iniciando n8n en http://localhost:${PUERTO}  (zona horaria ${zona})\n`);
const proc = spawn(NODE, [N8N, "start"], { env, stdio: "inherit" });
proc.on("exit", (code) => process.exit(code ?? 0));
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => proc.kill(s));
