// Contexto del negocio actual (varios negocios en una sola instalación).
// Todo lo que corre dentro de conNegocio(n, fn) (incluidas sus promesas y timers) "sabe" para qué
// negocio trabaja: getDb() abre SU base, getNegocio() lee SU catálogo, los avisos van a SU dueño.
// Fuera de un contexto se trabaja con el agente principal (el tuyo), exactamente como antes.
// Este archivo no importa nada a propósito: lo usan config.js y db.js sin ciclos.
import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage();

/** Negocio con el que se está trabajando ahora (null = agente principal). */
export const negocioActual = () => als.getStore() || null;

/** Ejecuta fn dentro del contexto de un negocio. */
export const conNegocio = (n, fn) => als.run(n, fn);

/** Ejecuta fn como agente principal (aunque se llame desde dentro de un negocio). */
export const comoPrincipal = (fn) => als.exit(fn);
