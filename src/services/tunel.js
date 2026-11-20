// Túnel gratis de Cloudflare (TUNEL=cloudflare en .env): da una dirección https pública a la PC
// para que los bocetos (/m/..., /muestras) abran desde cualquier celular.
//
// cloudflared corre como proceso aparte (no se cierra al reiniciar el agente), así la dirección
// *.trycloudflare.com se conserva entre reinicios del agente y los links ya enviados siguen
// abriendo. Solo cambia si cloudflared se cae (p. ej. al apagar la PC); entonces se abre otro.
// El panel no queda expuesto: lo que llega por el túnel trae cabeceras de proxy y siempre pide contraseña.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { settings, ROOT } from "../config.js";

const PID = path.join(ROOT, "data", "tunel.pid");
const URLF = path.join(ROOT, "data", "tunel.url");
const LOG = path.join(ROOT, "logs", "tunel.log");
const RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

const leer = (f) => {
  try {
    return fs.readFileSync(f, "utf8").trim();
  } catch {
    return "";
  }
};
const vivo = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
function matar(pid) {
  if (!vivo(pid)) return;
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" });
    else process.kill(pid);
  } catch {}
}
function binario() {
  const candidatos = [process.env.CLOUDFLARED_PATH, path.join(os.homedir(), ".local", "bin", "cloudflared.exe"), path.join(os.homedir(), ".local", "bin", "cloudflared")];
  return candidatos.find((c) => c && fs.existsSync(c)) || "cloudflared";
}

/**
 * @param {(nueva: string, antes: string, cambio: boolean) => void} onUrl
 *   cambio=false cuando se reutiliza la misma dirección de antes (el agente solo se reinició).
 */
export function startTunel(onUrl) {
  if ((process.env.TUNEL || "").toLowerCase() !== "cloudflare") return false;
  let lanzando = false;
  let fallos = 0;

  const usar = (url) => {
    const cambio = url !== leer(URLF);
    if (cambio) fs.writeFileSync(URLF, url);
    if (url === settings.publicUrl) return;
    const antes = settings.publicUrl;
    settings.publicUrl = url;
    console.log(`[tunel] dirección pública: ${url}${cambio ? " (nueva)" : " (la misma de antes)"}`);
    try {
      onUrl?.(url, antes, cambio);
    } catch (e) {
      console.error("[tunel]", e.message);
    }
  };

  const lanzar = () => {
    if (lanzando) return;
    lanzando = true;
    matar(Number(leer(PID)));
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    const fd = fs.openSync(LOG, "w");
    const hijo = spawn(binario(), ["tunnel", "--no-autoupdate", "--url", `http://localhost:${settings.port}`], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", fd, fd],
    });
    hijo.on("error", (e) => console.error("[tunel] no se pudo abrir cloudflared:", e.message));
    hijo.unref();
    fs.closeSync(fd);
    fs.writeFileSync(PID, String(hijo.pid || ""));
    let vueltas = 0;
    const buscar = setInterval(() => {
      const m = leer(LOG).match(RE);
      if (m || ++vueltas > 90) {
        clearInterval(buscar);
        lanzando = false;
        if (m) usar(m[0]);
        else console.error("[tunel] cloudflared no dio dirección; reintento en 5 min");
      }
    }, 1000);
  };

  // Si el cloudflared de antes sigue vivo, se reutiliza su dirección (los links enviados siguen sirviendo).
  const previa = leer(URLF);
  if (vivo(Number(leer(PID))) && RE.test(previa)) usar(previa);
  else lanzar();

  // Revisión cada 5 min: si la dirección dejó de responder dos veces seguidas, se abre un túnel nuevo.
  setInterval(async () => {
    if (lanzando) return;
    const url = leer(URLF);
    const ok = RE.test(url) && vivo(Number(leer(PID))) && (await fetch(`${url}/health`, { signal: AbortSignal.timeout(20_000) }).then((r) => r.ok).catch(() => false));
    fallos = ok ? 0 : fallos + 1;
    if (fallos >= 2) {
      fallos = 0;
      console.warn("[tunel] la dirección pública dejó de responder; abro un túnel nuevo");
      lanzar();
    }
  }, 5 * 60_000).unref();
  return true;
}
