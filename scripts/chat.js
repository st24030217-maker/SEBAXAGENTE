// Chatea con el agente desde la terminal, sin configurar ningún canal:
//   npm run chat
// Escribe "salir" para terminar o "nuevo" para empezar como otro cliente.
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { handleIncoming } from "../src/agent/agent.js";
import { getNegocio } from "../src/config.js";
import { getDb } from "../src/db.js";

const negocio = getNegocio();
getDb();
let sesion = `terminal${Date.now()}`;
const rl = readline.createInterface({ input, output });

console.log(`\n💬 Conversando con ${negocio.agente?.nombre || "el agente"} de ${negocio.negocio.nombre}`);
console.log('   Escribe "salir" para terminar, "nuevo" para cambiar de cliente.\n');

for (;;) {
  const texto = (await rl.question("Tú: ")).trim();
  if (!texto) continue;
  if (texto.toLowerCase() === "salir") break;
  if (texto.toLowerCase() === "nuevo") {
    sesion = `terminal${Date.now()}`;
    console.log("\n— Nueva conversación —\n");
    continue;
  }
  const t0 = Date.now();
  const { respuesta } = await handleIncoming({ canal: "web", externoId: sesion, texto });
  console.log(`\n${negocio.agente?.nombre || "Agente"}: ${respuesta ?? "(agente en pausa: atiende un humano)"}`);
  console.log(`   (${((Date.now() - t0) / 1000).toFixed(1)} s)\n`);
}
rl.close();
process.exit(0);
