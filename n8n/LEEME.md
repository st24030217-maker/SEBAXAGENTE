# Automatizaciones con n8n

n8n corre en tu computador, conectado al agente de ventas. Viene con 5 flujos listos.

## Cómo encenderlo

Abre dos terminales en la carpeta del proyecto:

```bash
npm start        # terminal 1: el agente de ventas (http://localhost:3000)
npm run n8n      # terminal 2: n8n (http://localhost:5678)
```

La primera vez que abras http://localhost:5678, n8n te pedirá crear una cuenta de dueño. Es solo local, en tu computador.

## Los flujos incluidos

| Flujo | Cuándo corre | Qué hace | ¿Necesita configurar algo? |
|---|---|---|---|
| **1. Eventos en tiempo real** | Cada vez que pasa algo en el agente | Recibe leads nuevos, cotizaciones, pedidos, pagos, citas, derivaciones y errores. Los urgentes van a Telegram o Gmail. | El historial funciona solo. Para recibir avisos, activa Telegram o Gmail. |
| **2. Reporte diario de ventas** | Todos los días a las 20:00 | Arma un resumen del día: ventas, pedidos, cotizaciones, conversión y costo de IA. | Activa Telegram o Gmail para recibirlo. |
| **3. Recordatorio de pago pendiente** | Cada hora, de lunes a sábado entre 10:00 y 18:00 | Les escribe al cliente que no ha pagado su pedido después de 24 h, una sola vez, con su link de pago. | Nada: funciona solo. |
| **4. Leads estancados** | De lunes a viernes a las 9:00 | Lista los clientes cotizados o en negociación sin movimiento hace 3 días o más, ordenados por probabilidad de compra. | Activa Telegram o Gmail. |
| **5. Respaldo diario de leads** | Todos los días a las 23:30 | Guarda los leads en CSV (se abre en Excel) en `n8n/respaldos/`. | Nada: funciona solo. |

El agente ya está conectado: en el `.env`, `OWNER_WEBHOOK_URL` apunta a `http://localhost:5678/webhook/agente-eventos`.

## Activar los avisos por Telegram o Gmail

Los nodos de Telegram y Gmail vienen **desactivados**, porque necesitan tus cuentas.

**Telegram:**
1. En n8n, abre el flujo, haz doble clic en **Avisar por Telegram** y crea una credencial con el token de tu bot (lo obtienes de @BotFather).
2. Pon tu chat id en `OWNER_TELEGRAM_CHAT_ID` dentro del `.env` del agente y reinicia n8n.
3. Clic derecho en el nodo → **Activate**, y luego guarda el flujo.

**Gmail:**
1. Haz doble clic en **Avisar por Gmail**, conecta tu cuenta de Google y cambia el destinatario.
2. Clic derecho → **Activate**, y luego guarda el flujo.

## Crear tus propias automatizaciones

Desde n8n puedes usar la API del agente con una petición HTTP:
- URL: `{{ $env.AGENTE_URL }}/admin/api/...`
- Cabecera: `x-admin-token` = `{{ $env.AGENTE_ADMIN_TOKEN }}`

| Método y ruta | Para qué |
|---|---|
| `GET /admin/api/resumen?dias=N` | Métricas |
| `GET /admin/api/leads` · `GET /admin/api/leads.csv` | CRM |
| `GET /admin/api/pedidos` · `POST /admin/api/pedidos/:id/estado` | Pedidos (`{"estado":"pagado"}`) |
| `GET /admin/api/citas` | Citas |
| `GET /admin/api/conversaciones/:id` | Una conversación completa |
| `POST /admin/api/conversaciones/:id/mensaje` | Escribirle a un cliente (`{"texto":"...","origen":"automatizacion"}`) |

Ideas para seguir: guardar cada lead en Google Sheets, crear las citas en Google Calendar, mandar los pedidos pagados a tu sistema de facturación o a la bodega, o una encuesta de satisfacción después de la entrega.

## Detalles técnicos

- n8n necesita Node 24. Usa una copia portátil guardada en `n8n/runtime/`, así que **no cambia el Node de tu equipo**.
- Todo lo de n8n (flujos, credenciales, historial) se guarda en `n8n/data/`.
- Si modificas los archivos de `n8n/workflows/`, ejecuta `npm run n8n:reimportar`. Ojo: esto reemplaza los cambios que hayas hecho en esos flujos desde la interfaz de n8n.

### Instalación desde cero (en otro computador)

1. Descarga el **zip de Node 24 para Windows x64** desde https://nodejs.org/dist/latest-v24.x/ y descomprímelo dentro de `n8n/runtime/`. Debe quedar como `n8n/runtime/node-v24.x.x-win-x64/`.
2. Ejecuta `npm run n8n`. La primera vez instala n8n solo.
