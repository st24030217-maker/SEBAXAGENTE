// Videos personalizados por prospecto: el envío usa el video del negocio si ya está listo.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

process.env.DB_PATH = ":memory:";
const { ROOT } = await import("../src/config.js");
const { videoDeProspecto, borrarVideoDeProspecto } = await import("../src/prospeccion/videos.js");

test("usa el video del prospecto solo si existe, y se borra después de mandarlo", () => {
  const id = 999999999;
  const ruta = path.join(ROOT, "data", "videos", `${id}.mp4`);
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  assert.equal(videoDeProspecto(id), null);
  fs.writeFileSync(ruta, Buffer.from("video de prueba"));
  try {
    assert.equal(videoDeProspecto(id), ruta);
    process.env.VIDEOS_PERSONALIZADOS = "false";
    assert.equal(videoDeProspecto(id), null, "apagado con VIDEOS_PERSONALIZADOS=false");
    delete process.env.VIDEOS_PERSONALIZADOS;
    borrarVideoDeProspecto(id);
    assert.equal(fs.existsSync(ruta), false);
  } finally {
    fs.rmSync(ruta, { force: true });
  }
});
