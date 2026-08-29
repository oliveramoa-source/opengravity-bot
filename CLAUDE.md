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
