# Reglas de seguridad — OpenGravity Bot

## Logs de Cloud Run: excluir `httpRequest` por default

Toda consulta de logs de Cloud Run sobre este servicio excluye `httpRequest` del resultado por
default (ej. agregar `NOT httpRequest:*` o el filtro equivalente en `gcloud logging read`, o
descartar ese campo explícitamente si se usa la consola).

**Motivo:** Telegraf arma la URL del webhook con el token embebido en el path
(`/telegraf/<TELEGRAM_BOT_TOKEN>`), y el campo `httpRequest.requestUrl` lo expone en texto
plano en cualquier consulta de logs que lo incluya (incidente real: exposición del token en la
sesión del 29/08/2026, resuelta con rotación).

Si en un caso puntual hace falta inspeccionar `httpRequest` para diagnosticar algo específico de
red, pedirlo explícitamente y enmascarar el token en la salida antes de mostrarlo.

## Comandos `describe`/`export` de gcloud: revisar antes de ejecutar por si traen secrets en claro

Cualquier comando que exporte o describa configuración (`gcloud ... describe`, `gcloud ... export`,
y equivalentes — servicios de Cloud Run, jobs de Cloud Scheduler, etc.) se revisa antes de
ejecutarse para evaluar si la salida puede traer un secreto en texto plano (headers custom,
env vars con `:latest` ya resueltas, tokens embebidos en URLs o payloads), y si hace falta,
se filtra o enmascara el campo correspondiente antes de correrlo. Mismo criterio ya aplicado a
los logs con `httpRequest` de la regla anterior.

**Motivo:** incidente real del 29/08/2026 — un `gcloud scheduler jobs describe` sobre el job
`opengravity-bot-daily-brief` expuso el valor viejo de `CRON_SECRET_TOKEN` en texto plano en la
salida de esa sesión (severidad baja, ese secreto no da acceso a Gmail/Calendar/Tasks, pero
confirma que el mismo patrón de exposición no se limita a los logs de Cloud Run).

## `getWebhookInfo` y endpoints de Telegram que devuelven la URL del webhook: nunca directo

Nunca llamar directo a `getWebhookInfo` (ni a ningún otro endpoint de la API de Telegram cuya
respuesta incluya la URL del webhook) para un chequeo de salud, ni siquiera uno rápido. Usar
siempre `scripts/diag-webhook.js`, que ya enmascara el token antes de mostrar el resultado.

**Motivo:** incidente real del 29/08/2026 — la respuesta de `getWebhookInfo` trae el campo `url`
con el token del bot embebido en el path (`/telegraf/<TOKEN>`, mismo patrón ya documentado en la
regla de `httpRequest` de arriba), y llamarlo directo lo imprimió en texto plano en la salida de
esa sesión. Forzó una segunda rotación del `TELEGRAM_BOT_TOKEN` en el mismo día.

## Lectura de `.env`: bloqueada a nivel de permisos, no solo por instrucción

La lectura de `.env`/`.env.*` de este repo (y de cualquier otro) está bloqueada por un hook
`PreToolUse` en `~/.claude/settings.json` (global, no en el `.claude/settings.json` de este repo
— una sesión puede entrar acá por `cd` con otra carpeta como raíz) que rechaza `Read`, `Grep`,
`Bash` y `PowerShell` apuntando a esos archivos, sin importar el flag usado. Script del hook:
`~/.claude/hooks/env-guard-hook.js`. Para confirmar si una variable existe sin ver su valor, usar
`node scripts/lib/env-vars.js NOMBRE_VARIABLE` (nunca imprime valores). Ver incidentes del
29/08/2026 (dos exposiciones reales de `.env` en texto plano en una misma sesión, la causa raíz
de por qué esto pasó a ser un bloqueo técnico).
