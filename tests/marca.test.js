// Marca real en los bocetos: logo y fotos de la página del negocio, y fotos de muestra distintas por negocio.
import { test } from "node:test";
import assert from "node:assert/strict";
const { marcaDeHtml, medidas, marcaDe } = await import("../src/prospeccion/marca.js");
const { fotosParaNegocio } = await import("../src/prospeccion/fotos.js");

test("saca el logo y las fotos propias, sin íconos ni fotos de otros sitios", () => {
  const html = `<link rel="apple-touch-icon" href="/ic-180x180.png">
<img class="logo" src="/wp-content/uploads/milogo-150x150.png" alt="Logo">
<img src="/wp-content/uploads/local.jpg"><img src="/wp-content/uploads/foto-150x150.jpg">
<img src="https://images.pexels.com/photos/1/x.jpeg"><img src="/favicon.png"><img data-src="/fotos/cafe.webp">`;
  const m = marcaDeHtml(html, "https://www.minegocio.mx/");
  assert.equal(m.logo, "https://www.minegocio.mx/wp-content/uploads/milogo.png");
  assert.deepEqual(m.fotos, ["https://www.minegocio.mx/wp-content/uploads/local.jpg", "https://www.minegocio.mx/fotos/cafe.webp"]);
});

test("sin logo en la página usa el ícono grande", () => {
  const m = marcaDeHtml('<link rel="apple-touch-icon" href="/apple.png">', "https://a.mx/");
  assert.equal(m.logo, "https://a.mx/apple.png");
});

test("lee las medidas de PNG y JPEG", () => {
  const png = Buffer.alloc(32); png.write("\x89PNG", 0, "latin1"); png.writeUInt32BE(1080, 16); png.writeUInt32BE(1920, 20);
  assert.deepEqual(medidas(png), { w: 1080, h: 1920 });
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xf4, 0x02, 0x80, 0, 0, 0, 0, 0]);
  assert.deepEqual(medidas(jpg), { w: 640, h: 500 });
});

test("marcaDe tolera JSON roto o vacío", () => {
  assert.equal(marcaDe({ marca: "no es json" }), null);
  assert.equal(marcaDe({ marca: '{"logo":null,"fotos":[]}' }), null);
  assert.equal(marcaDe({ marca: '{"logo":"x.png","fotos":[]}' }).logo, "x.png");
});

test("dos cafeterías distintas no salen con la misma portada", () => {
  const a = fotosParaNegocio("cafeteria", 3131), b = fotosParaNegocio("cafeteria", 3134);
  assert.notEqual(a.portada, b.portada);
  assert.equal(a.ambiente.length, 3);
  assert.ok(!a.ambiente.includes(a.portada.replace("w=1400", "w=900")));
});
