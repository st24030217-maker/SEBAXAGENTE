# AGENTE SEBAX: agente de ventas automático

Un vendedor con IA (Claude) que atiende a tus clientes las 24 horas por **web, WhatsApp, Instagram, Facebook y Telegram**. Se encarga de:

- **Asesorar y recomendar** productos de tu catálogo según lo que necesita cada cliente.
- **Cotizar** con precios oficiales, descuentos con tope y costo de envío.
- **Cerrar ventas**: crea el pedido y envía el **link de pago** (Mercado Pago, Stripe o transferencia).
- **Confirmar pagos** automáticamente y avisar al cliente.
- **Agendar citas** según tu horario real, sin choques, con **recordatorio** automático.
- **Registrar cada cliente en un CRM**: datos, necesidad, etapa del embudo y probabilidad de compra.
- **Hacer seguimiento** a quienes dejan de responder (solo dentro de tu horario de atención).
- **Derivar a una persona** cuando hace falta, con aviso inmediato para ti.
- **Panel de administración** con métricas, conversaciones, leads, pedidos, citas y costos de IA.

---

## 1. Puesta en marcha (5 minutos)

Requisito: **Node.js 22.13 o superior** (ya lo tienes instalado).

```bash
npm install
copy .env.example .env      # en Mac/Linux: cp .env.example .env
```

Abre `.env` y completa al menos:

| Variable | Qué poner |
|---|---|
| `ANTHROPIC_API_KEY` | Tu clave de https://console.anthropic.com |
| `ADMIN_TOKEN` | Una contraseña para entrar al panel |

```bash
npm start
```

- Chat de prueba: http://localhost:3000
- Panel: http://localhost:3000/admin (entras con tu `ADMIN_TOKEN`)
- Chat por terminal, sin navegador: `npm run chat`

## 2. Carga la información de tu negocio

Todo lo que el agente sabe está en **[config/negocio.yaml](config/negocio.yaml)**. Los datos que trae ahora son de ejemplo, así que reemplázalos con los tuyos:

- `negocio`: nombre, rubro, contacto, moneda y zona horaria.
- `agente`: nombre, personalidad y objetivo del vendedor.
- `catalogo`: productos con `id`, precio, stock y descripción.
- `horario` y `citas`: cuándo atiendes y qué tipos de cita ofreces.
- `politicas`, `envio`, `faq`: envíos, devoluciones, garantía y preguntas frecuentes.
- `descuentos.maximo_porcentaje`: el tope de descuento. **El servidor lo hace cumplir**, aunque el cliente insista.
- `seguimientos`: cada cuántas horas insistir y en qué etapas.
- `reglas_extra`: cualquier regla propia.

Después de editarlo, reinicia el servidor o usa **Ajustes → Recargar** en el panel.

## 3. Conectar los canales

Los canales que dejes sin configurar quedan desactivados. Para WhatsApp, Meta y los pagos necesitas una **URL pública** (ver la sección 6) en `PUBLIC_URL`.

### Chat en tu página web
Pega esta línea antes de `</body>` en tu sitio:
```html
<script src="https://TU-SERVIDOR/widget.js" data-color="#4f46e5" defer></script>
```

### Telegram (el más fácil para probar)
1. En Telegram, habla con **@BotFather**, escribe `/newbot` y copia el token.
2. Ponlo en `TELEGRAM_BOT_TOKEN`. Con `TELEGRAM_MODE=polling` funciona sin URL pública.

### WhatsApp Business (Meta Cloud API)
1. Crea una app en https://developers.facebook.com y agrégale el producto **WhatsApp**.
2. Copia el token y el *Phone number ID* en `WHATSAPP_TOKEN` y `WHATSAPP_PHONE_NUMBER_ID`.
3. En *Configuración → Webhook*:
   - URL: `https://TU-SERVIDOR/webhooks/whatsapp`
   - Token de verificación: el mismo valor de `WHATSAPP_VERIFY_TOKEN`
   - Suscríbete al campo **messages**.
4. Pon el *App secret* en `META_APP_SECRET`, que sirve para validar que los mensajes vienen de Meta.
5. **Seguimientos después de 24 h:** WhatsApp solo permite escribir fuera de esa ventana con una plantilla aprobada. Crea una plantilla con un parámetro `{{1}}` en el cuerpo y pon su nombre en `WHATSAPP_FOLLOWUP_TEMPLATE`.

### Instagram y Facebook Messenger
1. En la misma app de Meta, agrega **Messenger** (y **Instagram**), y conecta tu página y tu cuenta de Instagram profesional.
2. Genera el token de la página y ponlo en `META_PAGE_TOKEN`.
3. Webhook: `https://TU-SERVIDOR/webhooks/meta` con `META_VERIFY_TOKEN`. Suscríbete a **messages** en la página y en Instagram.

> Meta no permite mensajes automáticos fuera de la ventana de 24 h en Messenger o Instagram. En esos casos el seguimiento queda como "fallido" en el panel, y tú puedes escribirle a mano desde ahí.

## 4. Pagos

| `PAYMENT_PROVIDER` | Configuración | Confirmación automática |
|---|---|---|
| `manual` | Datos bancarios en `pagos.instrucciones_transferencia` | No: marcas el pedido como pagado en el panel |
| `mercadopago` | `MERCADOPAGO_ACCESS_TOKEN` | Sí (webhook `/webhooks/mercadopago`, se configura solo) |
| `stripe` | `STRIPE_SECRET_KEY` y `STRIPE_WEBHOOK_SECRET` | Sí: en Stripe crea un webhook a `https://TU-SERVIDOR/webhooks/stripe` con el evento `checkout.session.completed` |

Cuando un pago se confirma, el pedido pasa a **pagado**, el lead queda **ganado**, te llega un aviso y el cliente recibe la confirmación. Si cambias el estado a *enviado* o *entregado* en el panel, el cliente también recibe un aviso.

## 5. Avisos para ti

- **Telegram:** escríbele a tu bot, obtén tu *chat id* (por ejemplo con @userinfobot) y ponlo en `OWNER_TELEGRAM_CHAT_ID`.
- **Webhook** (Slack, Make, Zapier, n8n, Google Sheets…): pon la URL en `OWNER_WEBHOOK_URL`. Recibe un JSON `{tipo, texto, datos, fecha}`.

Hay aviso para: nuevo lead, cotización, pedido, pago, cita, derivación a humano y errores.

## 6. Publicarlo en internet

Cualquier servicio que ejecute Node o Docker sirve (Railway, Render, Fly.io, un VPS…):

```bash
docker build -t agente-sebax .
docker run -d -p 3000:3000 --env-file .env -v agente-data:/app/data agente-sebax
```

- Pon la URL final en `PUBLIC_URL` y usa esa URL en los webhooks.
- **Importante:** monta un volumen persistente en `/app/data`, porque ahí está la base de datos.
- Para probar webhooks desde tu PC sin publicar nada, puedes usar un túnel como `ngrok http 3000` o `cloudflared`.

## 7. Uso diario del panel (/admin)

- **Resumen:** ventas, conversión, embudo, canales y costo estimado de IA.
- **Conversaciones:** lees todos los chats. Puedes **responder tú mismo** (el agente se pausa) y **reactivarlo** cuando quieras.
- **Leads:** el CRM, con filtro por etapa y **exportación a CSV** (se abre en Excel).
- **Pedidos:** cambias el estado y el cliente recibe el aviso.
- **Citas / Seguimientos:** revisas, cancelas o marcas como realizadas.

## 8. Costos y ajustes de la IA

| Variable | Por defecto | Para qué sirve |
|---|---|---|
| `AGENTE_MODELO` | `claude-opus-5-5` | El modelo más capaz. Con `claude-sonnet-5-5` cuesta la mitad y con `claude-haiku-5-5` mucho menos, a cambio de vender con menos criterio. |
| `AGENTE_ESFUERZO` | `low` | `low` responde rápido y barato, que es lo ideal para chat. `medium` o `high` piensan más. |
| `AGENTE_FALLBACK` | `true` | Si Claude rechaza un mensaje por sus filtros de seguridad, se reintenta solo en otro modelo. |

Las instrucciones y el catálogo se guardan en **caché**, así que los mensajes siguientes de cada conversación salen bastante más baratos. Las conversaciones muy largas se resumen solas. En **Resumen** ves el costo estimado.

## 9. Seguridad incluida

- Los precios, descuentos, stock y horarios **los valida el servidor**. Aunque un cliente intente manipular al agente, no puede conseguir otro precio.
- Las firmas de los webhooks de Meta y Stripe se verifican. Los pagos de Mercado Pago se confirman consultando directamente su API.
- Hay límite de mensajes por minuto por cliente (anti-spam) y el panel está protegido con token.
- El agente nunca pide datos de tarjeta: los pagos se hacen solo en el link.

## 10. Estructura del proyecto

```
config/negocio.yaml      ← información de tu negocio (lo único que necesitas editar)
src/server.js            ← servidor y webhooks de pago
src/agent/               ← cerebro: instrucciones (prompt.js), herramientas (tools.js), ciclo (agent.js)
src/channels/            ← web, whatsapp, meta (IG/FB), telegram
src/services/            ← pagos, agenda, avisos, pedidos, automatizaciones
src/admin/routes.js      ← API del panel
public/                  ← widget.js, panel admin.html, página de demo
tests/                   ← pruebas (npm test)
data/agente.db           ← base de datos SQLite (se crea sola)
```

## Limitaciones actuales

- El **stock** se lee del YAML y no se descuenta automáticamente con cada venta. Actualízalo al reponer o vender.
- El agente entiende **texto**. Si llegan audios o imágenes, le pide amablemente al cliente que escriba.
- La agenda es interna; todavía no se sincroniza con Google Calendar.

## 11. Publicarlo en la nube (Render)

El proyecto trae `render.yaml`, así que Render crea todo solo:

1. Entra a https://dashboard.render.com → **New** → **Blueprint** y elige este repositorio.
2. Render te pide las claves (nunca van en el repo, porque es público): `ADMIN_TOKEN` (contraseña larga para el panel), `GEMINI_API_KEY`, `DENUE_TOKEN`, `WA_NUMERO` y, opcional, `ANTHROPIC_API_KEY`.
3. Se crea un servicio **Starter** (siempre prendido) con un **disco de 1 GB** en `/app/data`, donde viven la base de clientes y la sesión de WhatsApp.
4. Abre `https://TU-SERVICIO.onrender.com/admin` y entra con tu `ADMIN_TOKEN`.

**Pasar tus datos de la PC a la nube:** en el panel de la PC → **Más → Ajustes → Descargar respaldo**; en el panel de la nube → **Restaurar respaldo** con ese archivo.

**WhatsApp:** solo puede haber UN agente conectado al chip. Antes de vincularlo en la nube, apaga el de la PC (`npm run autoarranque:quitar` y cierra el proceso) y en el celular del chip borra el dispositivo vinculado anterior.

Cada vez que subas cambios a GitHub, Render los publica solo.
