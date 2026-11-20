// Red de seguridad:  npm test
// 1) Todos los archivos del agente compilan (un error de sintaxis tumbaría el agente al reiniciar,
//    aunque ninguna otra prueba importe ese archivo).
// 2) La propuesta (boceto) de TODOS los tipos de negocio se arma bien: sin errores, sin datos vacíos,
//    con su JavaScript válido y con los botones que llevan a WhatsApp.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";

process.env.DB_PATH = ":memory:";
process.env.ANTHROPIC_API_KEY = "";
process.env.GEMINI_API_KEY = "";

const archivos = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? archivos(p) : p.endsWith(".js") ? [p] : [];
  });

test("todos los archivos del agente compilan", () => {
  const rotos = archivos("src")
    .map((f) => [f, spawnSync(process.execPath, ["--check", f], { encoding: "utf8" })])
    .filter(([, r]) => r.status !== 0)
    .map(([f, r]) => `${f}: ${(r.stderr.match(/SyntaxError.*$/m) || [r.stderr])[0]}`);
  assert.deepEqual(rotos, []);
});

test("la propuesta de cada tipo de negocio se arma completa y funciona", async () => {
  const { openDb } = await import("../src/db.js");
  openDb(":memory:");
  const { renderMuestra } = await import("../src/prospeccion/boceto.js");
  const { perfilesGaleria } = await import("../src/prospeccion/perfiles.js");
  const perfiles = perfilesGaleria();
  assert.ok(perfiles.length > 40, "hay perfiles para muchos giros");
  for (const d of perfiles) {
    const h = renderMuestra(d.id);
    assert.ok(h, `${d.id}: se genera`);
    const js = h.slice(h.lastIndexOf("<script>") + 8, h.lastIndexOf("</script>"));
    assert.doesNotThrow(() => new vm.Script(js), `${d.id}: su JavaScript es válido`);
    const html = h.replace(/<script>[\s\S]*<\/script>/, "");
    assert.doesNotMatch(html, /undefined|NaN|\[object /, `${d.id}: sin datos vacíos`);
    assert.match(html, /class="dock-cta" href="https:\/\/wa\.me\/52\d{10}\?text=/, `${d.id}: botón fijo a WhatsApp`);
    assert.match(html, /id="s-cierre"[\s\S]*Quiero arrancar/, `${d.id}: cierre con "Quiero arrancar"`);
    // Cada botón que salta a otra pantalla apunta a una pantalla que existe.
    for (const [, id] of html.matchAll(/data-ir="([^"]+)"/g)) assert.match(html, new RegExp(`id="${id}"`), `${d.id}: existe ${id}`);
    assert.ok((html.match(/<section class="pant/g) || []).length >= 8, `${d.id}: trae todas sus pantallas`);
  }
});
