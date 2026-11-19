// Rutas del panel para varios negocios:
//  - rutasNegociosPrincipal: en TU panel (/admin), das de alta y administras a tus negocios cliente.
//  - rutasPanelNegocio: en el panel de cada negocio (/n/<slug>/admin), su WhatsApp y su configuración.
import { settings, getNegocio } from "../config.js";
import { conNegocio, negocioActual } from "../contexto.js";
import { getDb } from "../db.js";
import { listarNegocios, getNegocioCliente, crearNegocio, actualizarNegocio, leerYaml, guardarYaml, publico } from "../negocios.js";
import { estadoWaNegocio, codigoWaNegocio, desconectarWaNegocio, avisarDuenoNegocio, pausarOReanudarWa } from "../channels/wa-negocio.js";

const enlacePanel = (n) => `${settings.publicUrl}/n/${n.slug}/admin#clave=${encodeURIComponent(n.meta.token)}`;

/** Números rápidos de un negocio para la lista (se calculan dentro de su propia base). */
function resumenDe(n) {
  return conNegocio(n, () => {
    const d = getDb();
    const hace30 = new Date(Date.now() - 30 * 86400_000).toISOString();
    const one = (sql, ...p) => d.prepare(sql).get(...p);
    let config = null;
    try {
      config = getNegocio();
    } catch {}
    return {
      ...publico(n),
      whatsapp: estadoWaNegocio(n).estado,
      productos: config?.catalogo?.length ?? null,
      configValida: !!config,
      conversaciones30: one("SELECT COUNT(*) n FROM conversaciones WHERE creado >= ?", hace30).n,
      citasProximas: one("SELECT COUNT(*) n FROM citas WHERE estado = 'confirmada' AND inicio > ?", new Date().toISOString()).n,
      ventas30: one("SELECT COALESCE(SUM(total),0) monto FROM pedidos WHERE creado >= ? AND estado IN ('pagado','enviado','entregado')", hace30).monto,
      moneda: config?.negocio?.moneda || "MXN",
      ultimaActividad: one("SELECT MAX(actualizado) t FROM conversaciones").t,
    };
  });
}

export function rutasNegociosPrincipal(r, wrap) {
  r.get("/negocios", wrap((_req, res) => res.json(listarNegocios().map(resumenDe))));

  r.post("/negocios", wrap((req, res) => {
    const n = crearNegocio(req.body || {});
    res.json({ negocio: resumenDe(n), enlace: enlacePanel(n), clave: n.meta.token });
  }));

  r.patch("/negocios/:slug", wrap((req, res) => {
    const n = getNegocioCliente(req.params.slug);
    if (!n) return res.status(404).json({ error: "No existe ese negocio" });
    const { activo, dueno, nombre, nuevaClave } = req.body || {};
    const antes = n.meta.activo !== false;
    actualizarNegocio(n, { activo, dueno, nombre, nuevaClave });
    if (antes !== (n.meta.activo !== false)) pausarOReanudarWa(n);
    res.json({ negocio: resumenDe(n), ...(nuevaClave ? { enlace: enlacePanel(n), clave: n.meta.token } : {}) });
  }));

  // Enlace de acceso (con la clave) para mandárselo al dueño por WhatsApp.
  r.get("/negocios/:slug/enlace", wrap((req, res) => {
    const n = getNegocioCliente(req.params.slug);
    if (!n) return res.status(404).json({ error: "No existe ese negocio" });
    res.json({ enlace: enlacePanel(n), clave: n.meta.token });
  }));
}

export function rutasPanelNegocio(r, wrap) {
  const n = () => negocioActual();

  r.get("/config", wrap((_req, res) => {
    const t = n();
    let config = null;
    let error = null;
    try {
      config = getNegocio();
    } catch (e) {
      error = e.message;
    }
    res.json({
      esNegocio: true,
      slug: t.slug,
      negocio: config?.negocio?.nombre || t.meta.nombre,
      errorConfig: error,
      productos: config?.catalogo?.length ?? 0,
      moneda: config?.negocio?.moneda || "MXN",
      dueno: t.meta.dueno || null,
      pagos: t.meta.pagos?.proveedor || "transferencia",
      mercadopagoConectado: !!t.meta.pagos?.mercadopago_token,
      whatsapp: estadoWaNegocio(t).estado,
      chat: `${settings.publicUrl}/n/${t.slug}/chat`,
      widget: `<script src="${settings.publicUrl}/widget.js" data-negocio="${t.slug}" defer></script>`,
    });
  }));

  // WhatsApp del negocio: abrir esta sección enciende la conexión para mostrar el QR.
  r.get("/whatsapp", wrap((_req, res) => res.json(estadoWaNegocio(n(), { arrancar: true }))));
  r.post("/whatsapp/codigo", wrap(async (req, res) => res.json(await codigoWaNegocio(n(), req.body?.numero))));
  r.post("/whatsapp/desconectar", wrap(async (_req, res) => {
    await desconectarWaNegocio(n());
    res.json({ ok: true });
  }));
  r.post("/whatsapp/aviso-prueba", wrap(async (_req, res) => {
    const t = n();
    if (!t.meta.dueno) throw new Error("Primero escribe tu WhatsApp personal en Ajustes para recibir los avisos.");
    const ok = await avisarDuenoNegocio(t, `*${t.meta.nombre} · Aviso de prueba*\n\nAsí te van a llegar los avisos de tu agente: clientes nuevos, pedidos, citas y cuando alguien pida hablar contigo.\n\nPanel: ${settings.publicUrl}/n/${t.slug}/admin`);
    if (!ok) return res.status(409).json({ error: "No se pudo: revisa que el WhatsApp del negocio esté conectado y que tu número personal sea distinto al del chip." });
    res.json({ ok: true, numero: t.meta.dueno });
  }));

  // Lo que sabe el agente (catálogo, horario, políticas...). Se valida antes de guardar.
  r.get("/config-yaml", wrap((_req, res) => res.json({ yaml: leerYaml(n()) })));
  r.put("/config-yaml", wrap((req, res) => {
    const config = guardarYaml(n(), req.body?.yaml);
    res.json({ ok: true, productos: config.catalogo.length, negocio: config.negocio.nombre });
  }));

  // El dueño cambia su WhatsApp para avisos y cómo cobra (transferencia o su Mercado Pago).
  r.post("/ajustes", wrap((req, res) => {
    const { dueno, pagos } = req.body || {};
    const t = actualizarNegocio(n(), { ...(dueno !== undefined ? { dueno } : {}), ...(pagos !== undefined ? { pagos } : {}) });
    res.json({ ok: true, dueno: t.meta.dueno, pagos: t.meta.pagos?.proveedor });
  }));
}
