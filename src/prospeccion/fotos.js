// Fotos de muestra para los bocetos (Unsplash, licencia libre: https://unsplash.com/license).
// Son de ejemplo: en la propuesta real van las fotos del negocio.
// portada: foto de la cabecera. platos: fotos para "Lo más pedido" (solo comida/bebida).
const U = (id, w) => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${w}&q=70`;

const F = {
  lavado: ["1607860108855-64acf2078ed9"],
  taller: ["1625047509248-ec889cbff17f"],
  llantera: ["1578844251758-2f71da64c96f"],
  refaccionaria: ["1487754180451-c456f719a1fc"],
  dentista: ["1629909613654-28e377c37b09"],
  veterinaria: ["1596272875729-ed2ff7d6d9c5"],
  laboratorio: ["1606206591513-adbfbdd7a177"],
  optica: ["1788347101988-bf40abcbb2c7"],
  farmacia: ["1576091358783-a212ec293ff3"],
  fisio: ["1649751361457-01d3a696c7e6"],
  psicologo: ["1714976694810-85add1a29c96"],
  nutriologo: ["1512621776951-a57141f2eefd"],
  consultorio: ["1758691462863-9e1b8a863140"],
  guarderia: ["1761403942462-04b8b97f1fe9"],
  abogado: ["1505664194779-8beaceb93744"],
  contador: ["1454165804606-c3d57bc86b40"],
  seguros: ["1609220136736-443140cffec6"],
  viajes: ["1507525428034-b723cf961d3e"],
  lavanderia: ["1604335398980-ededcadcc37d"],
  fotografia: ["1542038784456-1ea8e935640e"],
  eventos: ["1519225421980-715cb0215aed"],
  hotel: ["1611892440504-42a792e24d32"],
  imprenta: ["1503694978374-8a2fa686963a"],
  inmobiliaria: ["1580587771525-78b9dba3b914"],
  gimnasio: ["1534438327276-14e5300c3a48"],
  escuela: ["1509062522246-3755977927d7"],
  ferreteria: ["1631856954655-966f97d809de"],
  papeleria: ["1654931800100-2ecf6eee7c64"],
  joyeria: ["1543294001-f7cd5d7fb516"],
  zapateria: ["1633464129147-777bdcc97c1d"],
  muebleria: ["1600121848594-d8644e57abab"],
  celulares: ["1639776738932-956082f0b704"],
  mascotas: ["1733451677115-043604a22ec6"],
  floreria: ["1487070183336-b863922373d4"],
  boutique: ["1441984904996-e0b6ba687e04"],
  construccion: ["1587582423116-ec07293f0395"],
  barberia: ["1585747860715-2ba37e788b70"],
  unas: ["1632345031435-8727f6897d53"],
  spa: ["1600334089648-b0d9d3028eb2"],
  tatuajes: ["1769605767701-6e5a680ef685"],
  estetica: ["1580618672591-eb180b1a973f"],
  pizzeria: ["1513104890138-7c749659a591", "1604382354936-07c5d9983bd3", "1574071318508-1cdbab80d002", "1534308983496-4fabb1a015ee"],
  hamburguesas: ["1568901346375-23c9450c58cd", "1572802419224-296b0aeee0d9", "1571091718767-18b5b1457add", "1549611016-3a70d82b5040"],
  mariscos: ["1765100479761-2359e22fbe16", "1515443961218-a51367888e4b", "1674207166635-7b2f0a58fea1", "1731090389571-79158024b42a"],
  sushi: ["1553621042-f6e147245754", "1579871494447-9811cf80d66c", "1611143669185-af224c5e3252"],
  pollo: ["1780037384670-63862da64775", "1585703900468-13c7a978ad86", "1600555379765-f82335a7b1b0"],
  neveria: ["1567206563064-6f60f40a2b57", "1629385701021-fcd568a743e8", "1629385744299-74b9cf013f52"],
  bar: ["1572116469696-31de0f17cc34", "1470337458703-46ad1756a187", "1566417713940-fe7c737a9ef2"],
  jugos: ["1603569283847-aa295f0d016a", "1613478223719-2ab802602423", "1622597467821-df79dcb4f94d"],
  cafeteria: ["1507915135761-41a0a222c709", "1760175445000-0e01e193d1cd", "1564327367919-cb377ea6a88f"],
  pasteleria: ["1568254183919-78a4f43a2877", "1509440159596-0249088772ff", "1608198093002-ad4e005484ec"],
  taqueria: ["1599974579688-8dbdd335c77f", "1565299585323-38d6b0865b47", "1760322328049-91bb196d41d9", "1545093149-618ce3bcf49d"],
  loncheria: ["1700625916627-16ad4fb0553c", "1613514785940-daed07799d9b", "1582169296194-e4d644c48063"],
  restaurante: ["1414235077428-338989a2e8c0", "1625862692743-3f57873bb37c", "1579631542761-d7c4e913f8d4"],
};

export const FOTOS_IDS = F;

/** @returns {{portada: string|null, platos: string[]}} */
export function fotosDe(perfilId) {
  const ids = F[perfilId] || [];
  return { portada: ids[0] ? U(ids[0], 1400) : null, platos: ids.slice(1).map((id) => U(id, 720)) };
}

// Giros parecidos cuyas fotos también sirven (para tener más variedad entre negocios del mismo giro).
const PARIENTES = {
  cafeteria: ["pasteleria"], pasteleria: ["cafeteria"], restaurante: ["loncheria", "taqueria"], loncheria: ["restaurante"],
  taqueria: ["restaurante"], jugos: ["neveria"], neveria: ["jugos"], hamburguesas: ["restaurante"], pizzeria: ["restaurante"],
};

const numero = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

/**
 * Fotos de muestra para UN negocio: la portada cambia según el negocio (dos cafeterías no salen
 * con la misma foto) y "ambiente" trae 3 fotos para el mosaico de "El lugar".
 * @returns {{portada: string|null, platos: string[], ambiente: string[]}}
 */
export function fotosParaNegocio(perfilId, semilla) {
  const propias = F[perfilId] || [];
  if (!propias.length) return { portada: null, platos: [], ambiente: [] };
  // Todas las fotos del giro y de sus parientes; cada negocio arranca en un punto distinto de la lista.
  const pool = [...propias, ...(PARIENTES[perfilId] || []).flatMap((k) => F[k] || []).filter((id) => !propias.includes(id))];
  const n = Number.isInteger(Number(semilla)) ? Number(semilla) : numero(semilla);
  const k = n % pool.length;
  const todas = pool.slice(k).concat(pool.slice(0, k));
  return {
    portada: U(todas[0], 1400),
    platos: (F[perfilId] || []).slice(1).map((id) => U(id, 720)), // mismas que antes: van con los nombres del menú
    ambiente: todas.slice(1, 4).map((id) => U(id, 900)),
  };
}
