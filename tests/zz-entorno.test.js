// Las pruebas nunca deben mandar correos ni avisos reales (aunque .env tenga la contraseña de Gmail).
import { test } from "node:test";
import assert from "node:assert/strict";
const { settings } = await import("../src/config.js");
test("en pruebas no hay correo ni avisos reales", () => {
  assert.equal(settings.smtp.pass, "");
  assert.equal(settings.owner.webhookUrl, "");
});
