# Informe para Metatrón — OpenGravity Bot: bug de Tasks sin rondas, fabricación de lecturas y latencia de cierre

**Fecha:** 05-06/08/2026
**Repo:** `https://github.com/oliveramoa-source/opengravity-bot` (rama `main`)
**Último commit:** `343c5d5`
**Última revisión desplegada:** `opengravity-bot-00049-zqh` (Cloud Run, 100% del tráfico)

---

## Resumen ejecutivo

Esta sesión arrancó investigando un bug reportado el 04/08: las consultas de Google Tasks ("listame mis tareas pendientes") se quedaban sin rondas de herramientas antes de poder responder. Se cerró ese bug con causa raíz confirmada por código, pero en el camino de verificarlo en vivo aparecieron dos hallazgos no buscados — uno de ellos, un bug más serio que el original (el modelo fabricando datos de tareas que nunca consultó). Los tres quedaron resueltos y verificados con evidencia real (logs de producción), salvo una excepción explícita que se detalla abajo.

**Estado al cierre: no quedan bugs de prioridad alta ni media pendientes.**

---

## 1. Ítem 114 — Tasks se quedaba sin rondas antes de responder

### Causa raíz
El motor de conversación (`chatWithTools`, `src/index.js`) tiene un límite de `MAX_ROUNDS = 3` rondas de herramientas por pedido. La ronda que redacta la respuesta final competía por ese mismo cupo — no había una ronda reservada para el cierre. Además, `buscar_tareas` sin especificar una lista puntual solo miraba la lista **por defecto** de Google Tasks: si las tareas pedidas vivían en otra lista (ej. "pendientes San Francisco"), esa ronda volvía vacía.

El flujo real que se veía en los logs: ronda 1 `buscar_tareas` en la lista default (vacía) → ronda 2 `listar_listas_tareas` → ronda 3 `buscar_tareas` con la lista correcta (recién ahí trae los datos) → sin ronda 4 para redactar, el bot devolvía un mensaje genérico de error.

### Arreglo (dos partes, no redundantes)
1. **Búsqueda multi-lista:** `buscar_tareas` sin lista puntual ahora busca en **todas** las listas de Tasks en una sola llamada, en vez de fallar contra la lista por defecto y necesitar 2 rondas más para encontrar la correcta.
2. **Ronda de cierre reservada:** si se agotan las 3 rondas de herramientas, el bot pide una ronda extra dedicada solo a redactar la respuesta final (sin poder volver a llamar herramientas, así que no reabre riesgos de duplicados de bugs anteriores). Corrige el problema de fondo para cualquier flujo futuro de Gmail/Calendar que alguna vez necesite las 3 rondas completas de datos.

### Verificación en vivo
Confirmado con logs reales de Cloud Run: un pedido sin nombrar ninguna lista trajo tareas de dos listas distintas en una sola llamada y resolvió en 2 rondas totales, lejos del límite de 3. El bug reportado no vuelve a ocurrir para este flujo.

---

## 2. Hallazgo no buscado — el modelo fabricando resultados de búsqueda/lectura

Al forzar en vivo un escenario que sí necesitaba las 3 rondas completas (para verificar la ronda de cierre del punto 1), apareció un bug más serio: el modelo devolvió una tabla completa "Cruce con tus tareas pendientes" con títulos de tareas **reales**, sin haber llamado a `buscar_tareas` en esa ronda.

### Investigación de la causa (confirmada por código, no supuesta)
Antes de escribir cualquier fix se confirmó el mecanismo exacto: el bot persiste el historial de conversación en Firestore, pero **solo el texto final** de cada turno (nunca los resultados crudos de las herramientas). El modelo, al ver en ese historial una respuesta real suya de un turno anterior con títulos de tareas reales, los reusó de memoria conversacional en vez de volver a consultar Tasks. Es un caso distinto de "inventar de la nada": son datos reales, aunque potencialmente desactualizados.

### Fix — Firma 6 (mismo patrón que las Firmas anti-invención existentes)
Nueva función `looksLikeFakeReadResult`: bloquea al modelo presentando una tabla/lista de resultados de una herramienta de lectura (Tasks, Mail, Calendar) sin haberla llamado en esa ronda **y** sin que esos datos aparezcan en ningún turno anterior real de la conversación. Cruza el texto nuevo contra el historial antes de bloquear, para no tratar igual una invención pura que el reuso legítimo de datos reales ya vistos.

Validada con 6 casos de test unitario standalone antes de desplegar (incluido el caso exacto de fabricación visto en vivo).

### Estado de verificación
En las 3 pruebas reales que siguieron (con historial de conversación limpio), el modelo terminó llamando a la herramienta real las 3 veces — el mejor resultado posible, pero eso significa que la Firma 6 nunca tuvo la oportunidad de bloquear nada en producción. Se revisaron los logs de la última revisión desplegada buscando cualquier bloqueo: cero resultados, lo cual también confirma que **no generó falsos positivos** con el comportamiento correcto del bot. Queda validada por código + tests + ausencia de falsos positivos en producción, sin evidencia todavía del bloqueo disparando — se documenta como tal, no se fuerza artificialmente más.

---

## 3. Latencia alta en la ronda de cierre

Al verificar en vivo la ronda de cierre del punto 1, se midieron tiempos de 27.6 y 41.8 segundos para una sola llamada — cerca o por encima del límite general de 40 segundos de respuesta del bot, y en un caso volvió directamente sin contenido.

### Causa raíz
La ronda de cierre seguía mandando las 23 definiciones completas de herramientas del bot (~19KB, ~5000 tokens) aunque el modelo tiene explícitamente prohibido usarlas en esa ronda — peso muerto que igual procesaba, consumiendo presupuesto de la respuesta.

### Fix
La ronda de cierre ya no manda la lista de herramientas en absoluto. Además, si vuelve sin contenido, ahora reintenta una vez más antes de rendirse (sin agregar llamadas reales a Google).

### Verificación en vivo
`closingMs` bajó de 27.6-41.8s a un rango de 6.5-23.5s en las pruebas posteriores al fix. El mecanismo de reintento se vio funcionar: primer intento vacío → segundo intento con contenido real.

---

## Estado del despliegue

Todo commiteado y pusheado a `origin/main`, working tree limpio. Commits de la sesión: `27de8ef`, `39e2735`, `343c5d5`. Última revisión de Cloud Run: `opengravity-bot-00049-zqh`, sirviendo el 100% del tráfico.

---

## Pendientes explícitos para adelante

- **Sin urgencia:** confirmar algún día en logs reales que la Firma 6 bloquea una fabricación (no es un bug, solo falta la oportunidad de verlo en acción).
- **Pedido de UX de Mariano, todavía no encarado:** los mensajes de listas (Tasks/Calendar) muestran IDs internos que no aportan nada a la vista — candidato para la próxima sesión.
- Decidir el destino de `Metatron Sync` vs. `Metatron Cowork` antes de migrar handoffs a Drive (pendiente de sesiones anteriores, sin relación con este informe).
