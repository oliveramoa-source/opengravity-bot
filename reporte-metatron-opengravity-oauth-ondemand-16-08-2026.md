# Informe para Metatrón — OpenGravity Bot: reautorización OAuth on-demand (16/08/2026)

**Ítem:** cierre de la instrucción "Reautorización OAuth on-demand" (Metatrón v1.2, contra Núcleo v4.52).
**Estado: CERRADO, con evidencia real de punta a punta.**

## 1. Bug reportado

El aviso automático diario (9:01) mandó el link "Reautorizar" por Telegram. Mariano lo abrió más tarde y la página devolvió "Este link de reautorización venció o ya se usó". Al pedirle al Bot por audio un link nuevo, el Bot contestó que el proceso "lo gestiona el propio sistema de forma automática" y que no podía generar ni proporcionar uno manualmente.

## 2. Diagnóstico (hecho antes de tocar código, con logs reales)

La causa real **no era solo el TTL corto** del `state` (10 min), como se había hipotetizado inicialmente. Causa dominante confirmada por logs de Cloud Run:

- `pendingOAuthState` vivía en **memoria del proceso Node**, no en almacenamiento persistente.
- El servicio Cloud Run tiene `maxScale=1` **sin `minScale` configurado** (default 0) → escala a cero por inactividad.
- Secuencia real del 16/08 (UTC): `12:00:05` el aviso automático generó el link y avisó por Telegram → `12:00:45` servidor listo, cero tráfico después → `14:48:46` llega el clic real, pero los logs muestran **"Starting new instance"**: una instancia nueva, no la que generó el link. Gap de ~2h48m sin ningún request en el medio.
- Resultado: la instancia que atendió el clic tenía memoria en blanco, y rechazó el `state` como "vencido o ya usado" — sin importar que el `state` en sí siguiera siendo válido.

El TTL corto (10 min) sí había vencido también para esa fecha (causa secundaria confirmada), pero estirarlo solo (propuesta original, 30-60 min) **no hubiera resuelto el problema de fondo**: con `minScale=0` no hay garantía de que la instancia siga viva ese tiempo.

Causas descartadas con evidencia: marcado de uso prematuro del `state` (no ocurre — se invalida recién tras validar), reintentos que generaran links duplicados (un solo link generado ese día), regresión de código sobre el fix del ítem 97 (el código coincidía exactamente con lo ya cerrado el 04/08).

## 3. Fix implementado

1. **`pendingOAuthState` migrado de memoria a Firestore** (`oauth_state/pending`), TTL 30 min validado contra el timestamp guardado. Cualquier instancia que atienda el callback lo puede leer, sin depender de cuál generó el link. Un `.set()` sin merge invalida automáticamente cualquier link anterior sin usar.
2. **Herramienta nueva `regenerar_link_reautorizacion`**: permite pedir un link nuevo en lenguaje natural ("dame un link nuevo", "el link venció, mandame otro", etc.), sin depender de que haya un `invalid_grant` real detectado — el pedido explícito de Mariano alcanza.
3. **System prompt actualizado a v5.11**: autoriza explícitamente al modelo a llamar la herramienta ante ese tipo de pedido, y deja explícito que nunca debe responder que "el proceso es automático" — la negativa original era la Firma 5 (anti-narrativa OAuth falsa, ítem 113) funcionando correctamente, pero sin ninguna herramienta real detrás del pedido de Mariano.
4. Blindaje HTML del mensaje nuevo confirmado (mismo patrón que el aviso automático desde el ítem 97/112, sin datos dinámicos sin escapar fuera del propio link de Google).

## 4. Verificación en vivo — los 4 criterios de la instrucción original, todos con evidencia real

1. ✅ Causa raíz identificada en logs y corregida (sección 2).
2. ✅ Pedido on-demand probado en vivo: audio real de Mariano ("Mándame el link nuevo de reautorización", 16:21) → el Bot llamó la herramienta y mandó el link nuevo por Telegram, sin la respuesta de negativa.
3. ✅ Ciclo OAuth real completado: clic en el link → pantalla de confirmación → "✅ Reautorización completa" por Telegram (16:22) → confirmado además del lado de infraestructura: **Secret Manager, versión 4 de `google-oauth-refresh-token`, creada `2026-08-16T19:22:04Z`** — timestamp real coincidente con la confirmación por chat, no autoreporte.
4. ✅ System prompt v5.11 desplegado y sirviendo el 100% del tráfico, revisión `opengravity-bot-00053-rts`.

## 5. Restricciones respetadas

- Proyecto GCP se mantiene en "Testing", sin trámite de verificación CASA ni intento de pasar a "Production".
- El aviso automático diario (9:01) no se tocó más allá de lo necesario para compartir el mecanismo de Firestore con el pedido on-demand.
- Ninguna credencial pasó por el chat en texto plano.
- Ante el hallazgo inesperado (causa real distinta de la hipótesis inicial de solo TTL), se paró y se reportó antes de implementar, en vez de forzar el fix originalmente descripto — confirmado por Mariano antes de tocar producción.

## 6. Commit y deploy

- Commit `fa83700` ("fix: reautorizacion OAuth on-demand + persistir pendingOAuthState en Firestore"), pusheado a `origin/main` (`cfb3c48..fa83700`).
- Deploy: revisión `opengravity-bot-00053-rts`, 100% del tráfico.
- Handoff actualizado en `HANDOFF.md` (repo) y `C:\Users\olive\.claude\handoffs\opengravity-bot.md` (centralizado).

**No quedan bugs de prioridad alta ni media pendientes en el Bot.** Backlog secundario sin cambios: limpiar IDs internos en respuestas de listas (Tasks/Calendar), y decidir destino de `Metatron Sync` vs `Metatron Cowork`.
