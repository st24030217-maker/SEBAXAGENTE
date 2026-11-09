// Carga y valida config/prospeccion.yaml.
import fs from "node:fs";
import YAML from "yaml";
import { settings } from "../config.js";

let cache = null;

export function getProspeccion() {
  if (!cache) cache = loadProspeccion(settings.prospeccion.configPath);
  return cache;
}

export function reloadProspeccion() {
  cache = loadProspeccion(settings.prospeccion.configPath);
  return cache;
}

export function loadProspeccion(file) {
  const data = YAML.parse(fs.readFileSync(file, "utf8")) || {};
  if (!data.remitente?.nombre) throw new Error(`${file}: falta remitente.nombre`);
  if (!Array.isArray(data.ciudades) || !data.ciudades.length) throw new Error(`${file}: falta la lista de ciudades`);
  if (!Array.isArray(data.rubros) || !data.rubros.length) throw new Error(`${file}: falta la lista de rubros`);
  for (const c of data.ciudades) {
    if (!c.nombre || typeof c.lat !== "number" || typeof c.lon !== "number") {
      throw new Error(`${file}: cada ciudad necesita nombre, lat y lon numéricos (${JSON.stringify(c)})`);
    }
  }
  for (const r of data.rubros) {
    if (!r.nombre || !r.palabras) throw new Error(`${file}: cada rubro necesita nombre y palabras (${JSON.stringify(r)})`);
  }
  data.radio_metros = Math.min(5000, Number(data.radio_metros || 5000));
  data.envio = {
    limite_diario: 20,
    minutos_entre_correos: 4,
    zona_horaria: "America/Monterrey",
    dias: ["lunes", "martes", "miercoles", "jueves", "viernes"],
    hora_inicio: "09:00",
    hora_fin: "18:00",
    dias_para_seguimiento: 4,
    whatsapp_limite_diario: 12,
    whatsapp_minutos_min: 7,
    whatsapp_minutos_max: 16,
    ...(data.envio || {}),
  };
  data.automatico = {
    buscar: false,
    cada_horas: 3,
    maximo_por_revisar: 150,
    aprobar_solos_desde_puntaje: 0,
    ...(data.automatico || {}),
  };
  data.estilo ||= [];
  return data;
}
