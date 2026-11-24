// La firma de los webhooks de Meta: sin secreto configurado se rechaza (antes se aceptaba todo).
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.META_APP_SECRET = "";
const { settings } = await import("../src/config.js");
const { verifyMetaSignature } = await import("../src/channels/metaSignature.js");
const req = (firma, cuerpo = '{"a":1}') => ({ rawBody: Buffer.from(cuerpo), get: (h) => (h === "x-hub-signature-256" ? firma : undefined) });

test("sin META_APP_SECRET se rechaza, salvo META_SIN_FIRMA=1", () => {
  settings.meta.appSecret = "";
  delete process.env.META_SIN_FIRMA;
  assert.equal(verifyMetaSignature(req("")), false);
  process.env.META_SIN_FIRMA = "1";
  assert.equal(verifyMetaSignature(req("")), true);
  delete process.env.META_SIN_FIRMA;
});

test("con secreto: acepta la firma correcta y rechaza la falsa", () => {
  settings.meta.appSecret = "secreto-de-prueba";
  const buena = "sha256=" + crypto.createHmac("sha256", "secreto-de-prueba").update('{"a":1}').digest("hex");
  assert.equal(verifyMetaSignature(req(buena)), true);
  const falsa = buena.slice(0, -1) + (buena.endsWith("0") ? "1" : "0");
  assert.equal(verifyMetaSignature(req(falsa)), false);
  assert.equal(verifyMetaSignature(req("sha256=abc")), false);
});
