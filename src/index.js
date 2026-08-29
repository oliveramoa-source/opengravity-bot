#!/usr/bin/env node

// IMPORTANTE: dotenv debe cargar ANTES que cualquier otra cosa
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { Telegraf } = require('telegraf');
const axios = require('axios');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const { google } = require('googleapis');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

// Escapa el texto dinámico que se interpola dentro de mensajes con parse_mode 'HTML' (ítem 112):
// a diferencia de Markdown, HTML no tiene el problema de que un `_` de más rompa el parseo, pero
// sí rompe si el texto dinámico (ids, títulos, resultados de IA) trae `&`, `<` o `>` literales —
// Telegram los interpretaría como el inicio de una entidad HTML. Nunca aplicar esto a los tags que
// nosotros mismos escribimos (`<b>`, `<a href=...>`), solo al contenido variable.
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ─────────────────────────────────────────
// FIREBASE ADMIN
// ─────────────────────────────────────────
const admin = require('firebase-admin');

// Soporta dos modos:
// 1. FIREBASE_SERVICE_ACCOUNT_B64: JSON completo en base64 (recomendado, evita problemas con \n en la clave)
// 2. Variables individuales: FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
  serviceAccount = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8'));
} else {
  serviceAccount = {
    type: 'service_account',
    project_id: process.env.FIREBASE_PROJECT_ID,
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  };
}

const certFn = admin.cert || (admin.credential && admin.credential.cert.bind(admin.credential));
admin.initializeApp({ credential: certFn(serviceAccount) });

// Compatibilidad Firestore: modular API (v10+) con fallback legacy
let db;
try {
  db = require('firebase-admin/firestore').getFirestore();
} catch (e) {
  db = admin.firestore();
}

// ─────────────────────────────────────────
// VALIDACIÓN DE TOKEN
// ─────────────────────────────────────────
if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN no configurado');
  process.exit(1);
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// ─────────────────────────────────────────
// ALLOWLIST (C1) — regla dura, primera línea de todo
// ─────────────────────────────────────────
// Registrado ANTES de cualquier otro bot.start/command/action/on: en Telegraf los middlewares
// corren en orden de registro para cada update, así que este bot.use() corta cualquier update
// de un user_id distinto ANTES de que llegue a cualquier otro handler — sin responder, sin
// loguear el contenido, sin procesar nada. Sin esto, ningún gate de confirmación downstream
// (Gmail, Calendar) tiene sentido: una confirmación vale lo que valga la certeza de quién la dio.
if (!process.env.TELEGRAM_ALLOWED_USER_ID) {
  console.error('ERROR: TELEGRAM_ALLOWED_USER_ID no configurado');
  process.exit(1);
}
bot.use(async (ctx, next) => {
  if (String(ctx.from?.id) !== String(process.env.TELEGRAM_ALLOWED_USER_ID)) return;
  return next();
});

// ─────────────────────────────────────────
// GOOGLE OAUTH2 — Gmail / Calendar / Tasks (ítem 88, v5.1: proyecto en modo "Testing" a
// propósito, nunca "Production" — evita pagar la verificación CASA Tier 2 que exige el scope
// restringido gmail.modify. Consecuencia aceptada: el refresh token vence cada 7 días; ver
// handleOAuthExpiry() más abajo para la detección + aviso proactivo)
// ─────────────────────────────────────────
// ítem 146 (29/08/2026): se agrega drive.readonly, no drive/drive.file. Mínimo privilegio real:
// hoy no hay ningún código que escriba en Drive (derivar_tarea_project sigue sin implementar la
// escritura), y lo único planificado para el corto plazo es que el carril "Projects" pueda LEER
// archivos de contexto de cada Project — si el día de mañana hace falta escribir/compartir (H2/H3
// según el .md base), ese es motivo para pedir drive.file en una sesión aparte, no para adelantarlo
// ahora sin un uso real detrás. Proyecto en modo "Testing" con un solo usuario (Mariano): agregar
// un scope de solo lectura no dispara verificación de Google ni tiene costo, pero sí exige que
// Mariano vuelva a pasar por la pantalla de consentimiento la próxima vez que use el bot.
const GOOGLE_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/drive.readonly',
];

// Ruta pública que recibe el redirect de Google al completar el consent screen (ítem 97 fix): sin
// esto el link de reautorización de Telegram llegaba a la pantalla de Google y no volvía a ningún
// lado — el cliente OAuth de "escritorio" original no soporta redirect https propio, por eso este
// flujo requiere un cliente OAuth tipo "Aplicación web" con esta URL registrada como redirect autorizado.
const OAUTH_CALLBACK_PATH = '/oauth/callback';
const OAUTH_REDIRECT_URI = process.env.WEBHOOK_URL ? `${process.env.WEBHOOK_URL}${OAUTH_CALLBACK_PATH}` : undefined;

const googleOAuthClient = new google.auth.OAuth2(
  process.env.GOOGLE_OAUTH_CLIENT_ID,
  process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  OAUTH_REDIRECT_URI
);
if (process.env.GOOGLE_OAUTH_REFRESH_TOKEN) {
  googleOAuthClient.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });
}

// Estado de un solo uso para el link de reautorización en curso: evita que un GET arbitrario a
// OAUTH_CALLBACK_PATH (la ruta es pública, no pasa por la allowlist de Telegram) con un `code`
// cualquiera pueda pisar el refresh token guardado — solo se acepta el code si viene acompañado
// del `state` que generamos nosotros al mandar el link, y solo una vez.
//
// Vive en Firestore, NO en memoria del proceso (bug real visto el 16/08/2026: con
// autoscaling.knative.dev/maxScale=1 y minScale=0 por default, Cloud Run apaga la única
// instancia por inactividad; el GET a OAUTH_CALLBACK_PATH que llega después cae en una
// instancia nueva con memoria en blanco, y el link se rechazaba como "vencido o ya usado"
// aunque el state en sí siguiera siendo válido). Guardar en Firestore hace que cualquier
// instancia que atienda el callback pueda validarlo, sin importar cuál generó el link.
const OAUTH_STATE_DOC = () => db.collection('oauth_state').doc('pending');
const OAUTH_STATE_TTL_MS = 30 * 60 * 1000; // 30 min: ventana razonable para un link mandado por Telegram

async function buildReauthUrl() {
  const value = crypto.randomBytes(16).toString('hex');
  const createdAt = Date.now();
  // .set() (no merge) pisa cualquier state anterior sin usar — invalidación explícita, un solo
  // link vigente a la vez, así no hay ambigüedad sobre cuál es el que sirve.
  await OAUTH_STATE_DOC().set({ value, createdAt, expiresAt: createdAt + OAUTH_STATE_TTL_MS });
  return googleOAuthClient.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GOOGLE_OAUTH_SCOPES,
    state: value,
  });
}

const GCP_PROJECT_ID = 'opengravity-bot-717d4';
const secretManagerClient = new SecretManagerServiceClient();

// Persiste el refresh_token nuevo en Secret Manager (misma lógica que scripts/oauth-setup.js,
// vía API en vez de gcloud CLI porque Cloud Run no tiene el binario de gcloud disponible) — sin
// esto, el próximo cold start del contenedor volvería a arrancar con el token vencido.
async function persistRefreshToken(refreshToken) {
  await secretManagerClient.addSecretVersion({
    parent: `projects/${GCP_PROJECT_ID}/secrets/google-oauth-refresh-token`,
    payload: { data: Buffer.from(refreshToken, 'utf8') },
  });
}

// Completa el intercambio code -> tokens iniciado por buildReauthUrl(), actualiza las
// credenciales en memoria para que el bot vuelva a operar sin esperar un redeploy, persiste el
// refresh_token nuevo, y avisa por Telegram (éxito o error) — nunca falla en silencio.
async function completeOAuthCallback(code) {
  try {
    const { tokens } = await googleOAuthClient.getToken(code);
    if (!tokens.refresh_token) {
      await bot.telegram.sendMessage(
        process.env.TELEGRAM_ALLOWED_USER_ID,
        '⚠️ La reautorización no devolvió un refresh token nuevo (puede pasar si ya habías autorizado antes sin forzar consentimiento). Revocá el acceso en https://myaccount.google.com/permissions y pedime el link de nuevo.'
      );
      return;
    }
    googleOAuthClient.setCredentials(tokens);
    await persistRefreshToken(tokens.refresh_token);
    googleOAuthExpired = false;
    await bot.telegram.sendMessage(process.env.TELEGRAM_ALLOWED_USER_ID, '✅ Reautorización completa. Gmail/Calendar/Tasks vuelven a andar normal.');
    await logAccion({
      accion: 'oauth_reautorizacion_completada',
      destinatario_o_archivo: 'google-oauth-refresh-token',
      confirmada: true,
      resultado: 'refresh_token renovado y persistido en Secret Manager',
    });
  } catch (error) {
    console.error('Error completando la reautorización OAuth:', error.message);
    await bot.telegram.sendMessage(process.env.TELEGRAM_ALLOWED_USER_ID, `⚠️ Error completando la reautorización: ${error.message}`);
  }
}

const gmailClient = google.gmail({ version: 'v1', auth: googleOAuthClient });
const calendarClient = google.calendar({ version: 'v3', auth: googleOAuthClient });
const tasksClient = google.tasks({ version: 'v1', auth: googleOAuthClient });

// true mientras el token esté marcado como vencido — evita seguir reintentando llamadas que
// sabemos que van a fallar hasta que Mariano reautorice.
let googleOAuthExpired = false;

function isOAuthExpiryError(error) {
  const code = error.response?.data?.error;
  const message = error.response?.data?.error_description || error.message || '';
  // invalid_grant es específico de token/refresh_token vencido o revocado — distinto de un 429
  // (rate limit), un 5xx (caída del servicio) o un error de red, que no deben tratarse igual.
  return code === 'invalid_grant' || /invalid_grant/i.test(message);
}

// Arma y manda el link de reautorización por Telegram (HTML, blindado — ni el encabezado ni el
// texto fijo llevan datos dinámicos que necesiten escapeHtml()). Compartido entre el aviso
// automático de vencimiento y el pedido on-demand (ítem 3.1) — mismo mecanismo de Firestore,
// mismo formato, para que no haya dos caminos distintos que puedan desalinearse.
async function sendReauthLink(userId, { automatico }) {
  const reauthUrl = await buildReauthUrl();
  const minutos = Math.round(OAUTH_STATE_TTL_MS / 60000);
  const encabezado = automatico
    ? '⚠️ <b>El token de Gmail/Calendar/Tasks venció.</b>\n\nEs esperable (modo Testing, ciclo de 7 días) — no es un error del Bot.'
    : '🔄 <b>Nuevo link de reautorización de Gmail/Calendar/Tasks.</b>\n\nInvalida cualquier link anterior que no hayas usado.';
  await bot.telegram.sendMessage(
    userId,
    `${encabezado}\n\n` +
    `Reautorizá acá (un clic, después el Bot vuelve a andar normal):\n<a href="${reauthUrl}">Reautorizar</a>\n\n` +
    `Vale por ${minutos} minutos.`,
    { parse_mode: 'HTML' }
  );
}

// Detección + aviso proactivo (ítem 88): nunca falla en silencio, nunca reintenta ni simula éxito.
async function handleOAuthExpiry(userId, error) {
  googleOAuthExpired = true;
  const detail = error.response?.data?.error_description || error.message;
  try {
    await sendReauthLink(userId, { automatico: true });
  } catch (sendError) {
    console.error('Error avisando vencimiento de OAuth por Telegram:', sendError.message);
  }
  await logAccion({
    accion: 'oauth_vencimiento_detectado',
    destinatario_o_archivo: 'google-oauth-refresh-token',
    confirmada: false,
    resultado: `detectado: ${detail}`,
  });
}

// Wrapper único para toda llamada a Gmail/Calendar/Tasks: separa "vencido, hay que reautorizar"
// de cualquier otro error (red, cuota, request inválida), y nunca reintenta cuando ya sabemos
// que el token está vencido — solo avisa que la reautorización está pendiente.
async function callGoogleAPI(userId, fn) {
  if (googleOAuthExpired) {
    return { ok: false, expired: true };
  }
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (error) {
    if (isOAuthExpiryError(error)) {
      await handleOAuthExpiry(userId, error);
      return { ok: false, expired: true };
    }
    console.error('Error llamando a Google API:', error.response?.data || error.message);
    return { ok: false, expired: false, error: error.response?.data?.error?.message || error.message };
  }
}

// ─────────────────────────────────────────
// CONFIGURACIÓN DEL BOT (guardada en Firebase)
// ─────────────────────────────────────────
async function getConfig(userId) {
  const doc = await db.collection('config').doc(String(userId)).get();
  if (!doc.exists) {
    return { provider: 'openrouter', model: 'z-ai/glm-5.2:free' };
  }
  return doc.data();
}

async function saveConfig(userId, config) {
  await db.collection('config').doc(String(userId)).set(config, { merge: true });
}

// ─────────────────────────────────────────
// REGISTRO DE ACCIONES — log_acciones (C6), append-only
// ─────────────────────────────────────────
// Nunca se hace update() ni delete() sobre un registro ya escrito, solo add() — es auditoría.
async function logAccion({ accion, destinatario_o_archivo, confirmada, resultado }) {
  try {
    await db.collection('log_acciones').add({
      timestamp: new Date().toISOString(),
      accion,
      destinatario_o_archivo,
      confirmada: !!confirmada,
      resultado,
    });
  } catch (error) {
    console.error('Error escribiendo en log_acciones:', error.message);
  }
}

async function getConfiguracionBot() {
  const doc = await db.collection('configuracion_bot').doc('default').get();
  if (!doc.exists) return { hora_aviso_diario: '09:00', timezone: 'America/Argentina/Buenos_Aires' };
  return doc.data();
}

// ─────────────────────────────────────────
// MEMORIA EN FIREBASE
// ─────────────────────────────────────────
async function getHistory(userId) {
  const doc = await db.collection('memory').doc(String(userId)).get();
  if (!doc.exists) return [];
  return doc.data().messages || [];
}

async function saveMessage(userId, role, content) {
  const ref = db.collection('memory').doc(String(userId));
  const doc = await ref.get();
  let messages = doc.exists ? doc.data().messages || [] : [];
  messages.push({ role, content, timestamp: new Date().toISOString() });
  if (messages.length > 30) messages = messages.slice(-30);
  await ref.set({ messages, updatedAt: new Date().toISOString() });
}

async function clearHistory(userId) {
  await db.collection('memory').doc(String(userId)).delete();
}

// ─────────────────────────────────────────
// IDEAS LAB
// ─────────────────────────────────────────
async function saveIdea(userId, idea) {
  const ref = db.collection('ideas').doc(String(userId));
  const doc = await ref.get();
  let ideas = doc.exists ? doc.data().ideas || [] : [];
  const newIdea = {
    id: Date.now(),
    text: idea,
    date: new Date().toISOString(),
    status: 'borrador',
  };
  ideas.push(newIdea);
  await ref.set({ ideas });
  return newIdea.id;
}

async function getIdeas(userId) {
  const doc = await db.collection('ideas').doc(String(userId)).get();
  if (!doc.exists) return [];
  return doc.data().ideas || [];
}

// ─────────────────────────────────────────
// GMAIL — redactar/enviar y papelera, siempre con gate de confirmación (C2/C3)
// ─────────────────────────────────────────
// RFC 2822 exige headers ASCII puros — un Subject con tildes/ñ sin codificar se manda como bytes
// UTF-8 crudos dentro del header, y cada cliente de mail los interpreta con un charset distinto
// (bug real visto en vivo 29/07/2026: "envío" llegó a la bandeja de entrada como "envÃƒÂ­o"). El
// body no tiene este problema porque el Content-Type ya declara charset=utf-8 explícito. La forma
// correcta es un "encoded word" RFC 2047.
function encodeMimeHeader(text) {
  if (/^[\x00-\x7F]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

function buildRawEmail({ to, subject, body }) {
  const message = [`To: ${to}`, `Subject: ${encodeMimeHeader(subject)}`, 'Content-Type: text/plain; charset=utf-8', '', body].join('\n');
  return Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function gmailSend(userId, { to, subject, body }) {
  const result = await callGoogleAPI(userId, () =>
    gmailClient.users.messages.send({ userId: 'me', requestBody: { raw: buildRawEmail({ to, subject, body }) } })
  );
  await logAccion({
    accion: 'gmail_enviar',
    destinatario_o_archivo: to,
    confirmada: true,
    resultado: result.ok ? `enviado, id ${result.data.data.id}` : (result.expired ? 'token vencido' : `error: ${result.error}`),
  });
  return result;
}

async function gmailTrash(userId, messageId) {
  const result = await callGoogleAPI(userId, () => gmailClient.users.messages.trash({ userId: 'me', id: messageId }));
  await logAccion({
    accion: 'gmail_papelera',
    destinatario_o_archivo: messageId,
    confirmada: true,
    resultado: result.ok ? 'movido a papelera' : (result.expired ? 'token vencido' : `error: ${result.error}`),
  });
  return result;
}

// ─────────────────────────────────────────
// CALENDAR — libre sin invitados, gate de confirmación con invitados (C2/C3)
// ─────────────────────────────────────────
function buildReminders(reminderMinutes) {
  if (!reminderMinutes) return undefined;
  return { useDefault: false, overrides: [{ method: 'popup', minutes: reminderMinutes }] };
}

async function calendarCreateEvent(userId, { summary, description, start, end, attendees, reminderMinutes }) {
  const result = await callGoogleAPI(userId, () =>
    calendarClient.events.insert({
      calendarId: 'primary',
      sendUpdates: attendees && attendees.length ? 'all' : 'none',
      requestBody: {
        summary,
        description,
        start: { dateTime: start, timeZone: 'America/Argentina/Buenos_Aires' },
        end: { dateTime: end, timeZone: 'America/Argentina/Buenos_Aires' },
        attendees: (attendees || []).map((email) => ({ email })),
        reminders: buildReminders(reminderMinutes),
      },
    })
  );
  await logAccion({
    accion: 'calendar_crear_evento',
    destinatario_o_archivo: summary,
    confirmada: !!(attendees && attendees.length),
    resultado: result.ok ? `creado, id ${result.data.data.id}` : (result.expired ? 'token vencido' : `error: ${result.error}`),
  });
  return result;
}

// Edita un evento existente (patch, no reemplaza campos no enviados) — mismo gate que crear:
// libre si no toca invitados, confirmación si agrega/notifica invitados.
async function calendarUpdateEvent(userId, { eventId, summary, description, start, end, attendees, reminderMinutes }) {
  const requestBody = {};
  if (summary !== undefined) requestBody.summary = summary;
  if (description !== undefined) requestBody.description = description;
  if (start !== undefined) requestBody.start = { dateTime: start, timeZone: 'America/Argentina/Buenos_Aires' };
  if (end !== undefined) requestBody.end = { dateTime: end, timeZone: 'America/Argentina/Buenos_Aires' };
  if (attendees !== undefined) requestBody.attendees = attendees.map((email) => ({ email }));
  if (reminderMinutes !== undefined) requestBody.reminders = buildReminders(reminderMinutes);
  const result = await callGoogleAPI(userId, () =>
    calendarClient.events.patch({ calendarId: 'primary', eventId, sendUpdates: attendees && attendees.length ? 'all' : 'none', requestBody })
  );
  await logAccion({
    accion: 'calendar_editar_evento',
    destinatario_o_archivo: eventId,
    confirmada: !!(attendees && attendees.length),
    resultado: result.ok ? 'editado' : (result.expired ? 'token vencido' : `error: ${result.error}`),
  });
  return result;
}

// Calendar no tiene "papelera" nativa vía API — events.delete es el equivalente más cercano
// (queda unos días recuperable desde la papelera de Calendar en la UI web).
async function calendarDeleteEvent(userId, eventId, hasAttendees) {
  const result = await callGoogleAPI(userId, () =>
    calendarClient.events.delete({ calendarId: 'primary', eventId, sendUpdates: hasAttendees ? 'all' : 'none' })
  );
  await logAccion({
    accion: 'calendar_borrar_evento',
    destinatario_o_archivo: eventId,
    confirmada: true,
    resultado: result.ok ? 'borrado' : (result.expired ? 'token vencido' : `error: ${result.error}`),
  });
  return result;
}

// Busca eventos por texto y/o rango de fechas para resolver el eventId sin pedírselo a Mariano
// (pedido suyo 28/07/2026: tener que buscar el ID a mano en Google Calendar para editar/borrar es
// engorroso — el Bot tiene que poder encontrar el evento por título/horario y confirmar con él
// cuál es antes de tocarlo).
async function calendarSearchEvents(userId, { query, timeMin, timeMax }) {
  const now = new Date();
  const effectiveMin = timeMin || now.toISOString();
  const effectiveMax = timeMax || new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const result = await callGoogleAPI(userId, () =>
    calendarClient.events.list({
      calendarId: 'primary',
      q: query || undefined,
      timeMin: effectiveMin,
      timeMax: effectiveMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 15,
    })
  );
  return result;
}

// ─────────────────────────────────────────
// GOOGLE TASKS — listas, crear/marcar/descompletar sin gate (checklist personal, error barato de
// corregir); tasklists.delete y tasks.delete SÍ gatean (destructivo y sin papelera — ver comentario
// de tasksDeleteList/tasksDelete más abajo). Scope 'tasks' (no 'tasks.readonly') ya autorizado.
// ─────────────────────────────────────────
async function tasksGetDefaultListId(userId) {
  const result = await callGoogleAPI(userId, () => tasksClient.tasklists.list({ maxResults: 1 }));
  if (!result.ok) return null;
  return result.data.data.items?.[0]?.id || null;
}

// Lista TODAS las tasklists (antes solo se pedía la primera con maxResults:1) — necesario para que
// crear_tarea pueda elegir destino y para poder identificar qué lista borrar.
async function tasksListLists(userId) {
  return callGoogleAPI(userId, () => tasksClient.tasklists.list({ maxResults: 100 }));
}

// Freno anti-duplicados a nivel código (mismo patrón que tasksCreate) — bug real visto en vivo
// (01/08/2026): al reformular un pedido tras quedarse sin rondas, el modelo volvió a llamar esta
// herramienta en vez de reusar la lista ya creada, generando dos listas con el mismo título que
// hubo que desambiguar y borrar a mano. Se chequea el título contra las listas existentes antes de
// insertar — si ya existe, se devuelve la existente en vez de crear una nueva.
async function tasksCreateList(userId, title) {
  const existingResult = await tasksListLists(userId);
  if (existingResult.ok) {
    const normalizedTitle = (title || '').trim().toLowerCase();
    const dup = (existingResult.data.data.items || []).find((l) =>
      (l.title || '').trim().toLowerCase() === normalizedTitle
    );
    if (dup) {
      await logAccion({
        accion: 'tasks_crear_lista',
        destinatario_o_archivo: title,
        confirmada: false,
        resultado: `omitida, ya existía id ${dup.id}`,
      });
      return { ok: true, alreadyExisted: true, data: { data: dup } };
    }
  }
  const result = await callGoogleAPI(userId, () => tasksClient.tasklists.insert({ requestBody: { title } }));
  await logAccion({
    accion: 'tasks_crear_lista',
    destinatario_o_archivo: title,
    confirmada: false,
    resultado: result.ok ? `creada, id ${result.data.data.id}` : (result.expired ? 'token vencido' : `error: ${result.error}`),
  });
  return result;
}

// Renombra una lista (tasklists.patch) — sin gate, es un cambio de nombre, no borra nada. Bug real
// visto en vivo (31/07/2026): no existía ESTA herramienta y el modelo, sin ninguna forma real de
// cumplir el pedido, inventó en texto que ya lo había hecho — se cierra dándole la herramienta real.
async function tasksRenameList(userId, tasklistId, title) {
  const result = await callGoogleAPI(userId, () => tasksClient.tasklists.patch({ tasklist: tasklistId, requestBody: { title } }));
  await logAccion({
    accion: 'tasks_renombrar_lista',
    destinatario_o_archivo: `${tasklistId} -> ${title}`,
    confirmada: false,
    resultado: result.ok ? 'renombrada' : (result.expired ? 'token vencido' : `error: ${result.error}`),
  });
  return result;
}

// tasklists.delete borra la lista Y todas sus tareas, sin papelera de recuperación — a diferencia
// de Calendar (papelera web) o Gmail (Papelera), acá Google no da ninguna red de seguridad nativa.
// Por eso gatea siempre, sin excepción (ver ACTION_LABELS/tasks_delete_list).
async function tasksDeleteList(userId, tasklistId) {
  const result = await callGoogleAPI(userId, () => tasksClient.tasklists.delete({ tasklist: tasklistId }));
  await logAccion({
    accion: 'tasks_borrar_lista',
    destinatario_o_archivo: tasklistId,
    confirmada: true,
    resultado: result.ok ? 'lista borrada' : (result.expired ? 'token vencido' : `error: ${result.error}`),
  });
  return result;
}

// parentTaskId (query param de la API, no va en el body) crea la tarea directo como subtarea de
// otra — un solo nivel de anidamiento, que es todo lo que la API de Tasks soporta.
//
// Freno anti-duplicados a nivel código (no de prompt — ver Lección Gordon): bug real visto en vivo
// (31/07/2026) donde un pedido de "revisá y completá lo que faltó" hizo que el modelo, confiando
// en su propia memoria de la conversación en vez del estado real de Tasks, volviera a crear ítems
// que ya existían. En vez de depender de que el modelo razone bien (no es confiable, ya se vio
// varias veces esta sesión), acá se chequea el título contra lo que YA existe en esa lista (mismo
// padre si es subtarea) antes de insertar — si ya existe, no se duplica, se devuelve el existente.
// Esto vuelve seguro que el modelo simplemente reintente crear todo el lote pedido sin pensar en
// qué falta: lo que ya está, se saltea solo.
async function tasksCreate(userId, { title, notes, due, tasklistId, parentTaskId }) {
  const listId = tasklistId || await tasksGetDefaultListId(userId);
  if (!listId) return { ok: false, expired: googleOAuthExpired };
  const existingResult = await callGoogleAPI(userId, () =>
    tasksClient.tasks.list({ tasklist: listId, showCompleted: true, showHidden: true, maxResults: 100 })
  );
  if (existingResult.ok) {
    const normalizedTitle = (title || '').trim().toLowerCase();
    const dup = (existingResult.data.data.items || []).find((t) =>
      (t.title || '').trim().toLowerCase() === normalizedTitle &&
      (t.parent || null) === (parentTaskId || null)
    );
    if (dup) {
      await logAccion({
        accion: 'tasks_crear',
        destinatario_o_archivo: title,
        confirmada: false,
        resultado: `omitida, ya existía id ${dup.id}`,
      });
      return { ok: true, alreadyExisted: true, data: { data: dup } };
    }
  }
  const result = await callGoogleAPI(userId, () =>
    tasksClient.tasks.insert({
      tasklist: listId,
      ...(parentTaskId ? { parent: parentTaskId } : {}),
      requestBody: { title, notes, due },
    })
  );
  await logAccion({
    accion: 'tasks_crear',
    destinatario_o_archivo: title,
    confirmada: false,
    resultado: result.ok ? `creada, id ${result.data.data.id}` : (result.expired ? 'token vencido' : `error: ${result.error}`),
  });
  return result;
}

// Edita título/notas/fecha de una tarea existente (patch, no reemplaza campos no enviados) — no
// existía ninguna forma de corregir esos campos salvo borrar y crear de nuevo. Sin gate: es una
// checklist personal, corregir es gratis (mismo criterio que el resto de Tasks).
async function tasksUpdate(userId, taskId, { title, notes, due, tasklistId }) {
  const listId = tasklistId || await tasksGetDefaultListId(userId);
  if (!listId) return { ok: false, expired: googleOAuthExpired };
  const requestBody = {};
  if (title !== undefined) requestBody.title = title;
  if (notes !== undefined) requestBody.notes = notes;
  if (due !== undefined) requestBody.due = due;
  const result = await callGoogleAPI(userId, () =>
    tasksClient.tasks.patch({ tasklist: listId, task: taskId, requestBody })
  );
  await logAccion({
    accion: 'tasks_editar',
    destinatario_o_archivo: taskId,
    confirmada: false,
    resultado: result.ok ? 'editada' : (result.expired ? 'token vencido' : `error: ${result.error}`),
  });
  return result;
}

// tasks.move reasigna el padre de una tarea (parentTaskId ausente/null la sube a tarea principal) —
// así se arma o se deshace una subtarea. Sin gate: reversible, no borra nada.
async function tasksMove(userId, taskId, { tasklistId, parentTaskId }) {
  const listId = tasklistId || await tasksGetDefaultListId(userId);
  if (!listId) return { ok: false, expired: googleOAuthExpired };
  const result = await callGoogleAPI(userId, () =>
    tasksClient.tasks.move({ tasklist: listId, task: taskId, ...(parentTaskId ? { parent: parentTaskId } : {}) })
  );
  await logAccion({
    accion: 'tasks_mover',
    destinatario_o_archivo: taskId,
    confirmada: false,
    resultado: result.ok ? (parentTaskId ? `subtarea de ${parentTaskId}` : 'promovida a tarea principal') : (result.expired ? 'token vencido' : `error: ${result.error}`),
  });
  return result;
}

async function tasksComplete(userId, taskId, tasklistId) {
  const listId = tasklistId || await tasksGetDefaultListId(userId);
  if (!listId) return { ok: false, expired: googleOAuthExpired };
  const result = await callGoogleAPI(userId, () =>
    tasksClient.tasks.patch({ tasklist: listId, task: taskId, requestBody: { status: 'completed' } })
  );
  await logAccion({
    accion: 'tasks_marcar',
    destinatario_o_archivo: taskId,
    confirmada: false,
    resultado: result.ok ? 'marcada completa' : (result.expired ? 'token vencido' : `error: ${result.error}`),
  });
  return result;
}

// Descompletar: toggle inverso de tasksComplete — reversible, mismo criterio (sin gate).
async function tasksUncomplete(userId, taskId, tasklistId) {
  const listId = tasklistId || await tasksGetDefaultListId(userId);
  if (!listId) return { ok: false, expired: googleOAuthExpired };
  const result = await callGoogleAPI(userId, () =>
    tasksClient.tasks.patch({ tasklist: listId, task: taskId, requestBody: { status: 'needsAction' } })
  );
  await logAccion({
    accion: 'tasks_descompletar',
    destinatario_o_archivo: taskId,
    confirmada: false,
    resultado: result.ok ? 'descompletada' : (result.expired ? 'token vencido' : `error: ${result.error}`),
  });
  return result;
}

// tasks.delete borra el ítem para siempre, sin papelera — mismo criterio que tasksDeleteList: gatea siempre.
async function tasksDelete(userId, taskId, tasklistId) {
  const listId = tasklistId || await tasksGetDefaultListId(userId);
  if (!listId) return { ok: false, expired: googleOAuthExpired };
  const result = await callGoogleAPI(userId, () => tasksClient.tasks.delete({ tasklist: listId, task: taskId }));
  await logAccion({
    accion: 'tasks_borrar',
    destinatario_o_archivo: taskId,
    confirmada: true,
    resultado: result.ok ? 'borrada' : (result.expired ? 'token vencido' : `error: ${result.error}`),
  });
  return result;
}

// Lista tareas por texto para resolver el taskId sin pedírselo a Mariano (mismo problema real
// detectado 28/07/2026 en Calendar, agravado acá: no existía NINGUNA forma de listar tareas
// existentes). Acepta tasklistId opcional para buscar en una lista puntual, y showCompleted
// opcional porque por default la API oculta completadas — necesario para poder encontrar una
// tarea ya completada y descompletarla.
//
// Ítem 114 (05/08/2026): si NO se pasa tasklistId, antes buscaba solo en la lista por defecto —
// si las tareas pedidas vivían en otra lista (visto en vivo: "pendientes San Francisco"), esa
// ronda volvía vacía y el modelo necesitaba 2 rondas más (listar_listas_tareas + reintentar con
// tasklistId puntual) para encontrarlas, agotando el presupuesto de MAX_ROUNDS antes de poder
// responder (ver chatWithTools). Ahora, sin tasklistId, busca en TODAS las listas en una sola
// llamada — cada item lleva su propio tasklistId para que marcar/editar/borrar sepan a qué lista
// pertenece sin tener que volver a preguntar.
async function tasksSearch(userId, { query, tasklistId, showCompleted }) {
  const q = query ? query.toLowerCase() : null;
  if (tasklistId) {
    const result = await callGoogleAPI(userId, () =>
      tasksClient.tasks.list({ tasklist: tasklistId, showCompleted: !!showCompleted, showHidden: !!showCompleted, maxResults: 50 })
    );
    if (!result.ok) return result;
    let items = (result.data.data.items || []).map((t) => ({ ...t, tasklistId }));
    if (q) items = items.filter((t) => (t.title || '').toLowerCase().includes(q));
    return { ok: true, data: { data: { items } } };
  }
  const listsResult = await tasksListLists(userId);
  if (!listsResult.ok) return listsResult;
  const lists = listsResult.data.data.items || [];
  if (!lists.length) return { ok: true, data: { data: { items: [] } } };
  const perList = await Promise.all(lists.map(async (l) => {
    const result = await callGoogleAPI(userId, () =>
      tasksClient.tasks.list({ tasklist: l.id, showCompleted: !!showCompleted, showHidden: !!showCompleted, maxResults: 50 })
    );
    if (!result.ok) return [];
    let items = (result.data.data.items || []).map((t) => ({ ...t, tasklistId: l.id, tasklistTitle: l.title }));
    if (q) items = items.filter((t) => (t.title || '').toLowerCase().includes(q));
    return items;
  }));
  return { ok: true, data: { data: { items: perList.flat() } } };
}

// ─────────────────────────────────────────
// GATE DE CONFIRMACIÓN (C10) — ciclo iterativo de borrador (Fase 1, pedido de Mariano 28/07/2026)
// ─────────────────────────────────────────
// Estado pendiente en memoria (mismo patrón que pendingIdeas más abajo): efímero, no necesita
// Firestore — si el proceso reinicia entre la propuesta y la confirmación, se pierde y hay que
// volver a pedirla, comportamiento aceptable para un gate de confirmación.
// pendingConfirmationsByUser indexa por userId (además del id) para que handleUserText pueda
// saber, ante cualquier mensaje de texto libre, si Mariano le está respondiendo a un borrador
// pendiente — así "dale"/"confirmalo"/una corrección en lenguaje natural resuelven el borrador
// sin depender de que toque un botón.
const pendingConfirmations = new Map();
const pendingConfirmationsByUser = new Map();
let confirmationSeq = 0;

// Etiqueta, letra atajo y sinónimos por tipo de acción (pedido de Mariano 29/07/2026): además del
// botón y de confirmaciones genéricas ("dale", "sí"), cada kind tiene su propia palabra/letra —
// tipear "editar", "cambiar" o solo "D" confirma un borrador de calendar_update igual que tocar el
// botón. La letra de cada acción se eligió para no colisionar nunca con la "C" de Cancelar (por eso
// "creAr"/A y "eDitar"/D en vez de la inicial de la palabra).
const ACTION_LABELS = {
  email_send: { display: 'Enviar', letter: 'E', synonyms: ['enviar', 'envia', 'envía', 'mandalo', 'mandala', 'mandá', 'manda'] },
  email_trash: { display: 'Borrar', letter: 'B', synonyms: ['borrar', 'eliminar', 'mover'] },
  calendar_event: { display: 'creAr', letter: 'A', synonyms: ['crear', 'creá', 'crea'] },
  calendar_update: { display: 'eDitar', letter: 'D', synonyms: ['editar', 'cambiar', 'cambiá', 'cambia', 'modificar'] },
  calendar_delete: { display: 'Borrar', letter: 'B', synonyms: ['borrar', 'eliminar'] },
  tasks_delete_item: { display: 'Borrar', letter: 'B', synonyms: ['borrar', 'eliminar'] },
  tasks_delete_list: { display: 'Borrar', letter: 'B', synonyms: ['borrar', 'eliminar'] },
};
const DEFAULT_ACTION_LABEL = { display: 'Confirmar', letter: 'F', synonyms: [] };

// Registra una acción pendiente y manda los botones de confirmación con la vista previa compacta.
async function askConfirmation(ctx, { kind, preview, payload }) {
  const id = String(++confirmationSeq);
  const userId = ctx.from.id;
  const action = ACTION_LABELS[kind] || DEFAULT_ACTION_LABEL;
  // Un solo borrador pendiente por usuario a la vez: uno nuevo reemplaza al anterior en silencio
  // (evita ambigüedad de a qué acción responde un "dale" suelto si hubiera dos abiertos).
  const previousId = pendingConfirmationsByUser.get(userId);
  if (previousId) pendingConfirmations.delete(previousId);
  // Bug real encontrado en la prueba de H1 (27/07/2026): dejar que el modelo siga generando texto
  // después de esto lo llevó a inventar "✅ Listo, confirmado y ejecutado" ANTES de que Mariano
  // tocara ningún botón — contradice directamente la regla de "nunca declarar éxito sin poder
  // verificarlo". No se soluciona pidiéndole más disciplina al modelo (no es confiable), se corta
  // en el código: chatWithTools revisa esta bandera y no deja que el modelo agregue nada más.
  if (ctx) ctx.__awaitingConfirmation = true;
  const sentMsg = await ctx.reply(
    `${preview}\n\n<i>Tipeá <b>${action.letter}</b> para ${escapeHtml(action.display.toLowerCase())}, <b>C</b> para cancelar, o escribí una corrección.</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: `✅ ${action.display}`, callback_data: `confirm_${id}` },
          { text: '❌ Cancelar', callback_data: `cancel_${id}` },
        ]],
      },
    }
  );
  // Guardamos chatId/messageId (pedido de Mariano 29/07/2026): al confirmar/cancelar, en vez de
  // borrar el borrador y reemplazarlo por un mensaje genérico, se edita ESTE mismo mensaje para
  // sacar los botones y sumar el resultado — el borrador queda de registro visible. Necesario para
  // el camino de confirmación por texto libre (ahí el ctx de la respuesta es un mensaje nuevo, sin
  // referencia directa al mensaje del borrador salvo por estos IDs guardados).
  pendingConfirmations.set(id, { kind, payload, userId, preview, action, chatId: ctx.chat.id, messageId: sentMsg.message_id });
  pendingConfirmationsByUser.set(userId, id);
}

// Edita en el lugar el mensaje original del borrador (preview + resultado, sin botones) en vez de
// mandar un mensaje nuevo — así el borrador queda como registro visible de lo que se hizo.
// Devuelve false si no se pudo editar (mensaje muy viejo, etc.), para que el llamador tenga un
// fallback de mandar un mensaje nuevo en vez de dejar a Mariano sin respuesta.
async function finalizeDraftMessage(ctx, pending, resultLine) {
  if (!pending.chatId || !pending.messageId) return false;
  try {
    await ctx.telegram.editMessageText(
      pending.chatId, pending.messageId, undefined,
      `${pending.preview}\n\n${resultLine}`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
    );
    return true;
  } catch (error) {
    console.error('No pude editar el mensaje del borrador original:', error.message);
    return false;
  }
}

// Borra un borrador pendiente de ambos índices a la vez — hay que mantenerlos sincronizados
// siempre (confirmar, cancelar, o reemplazo por uno nuevo).
function clearPendingConfirmation(id) {
  const pending = pendingConfirmations.get(id);
  if (pending && pendingConfirmationsByUser.get(pending.userId) === id) {
    pendingConfirmationsByUser.delete(pending.userId);
  }
  pendingConfirmations.delete(id);
}

// Ejecuta la acción real de un borrador ya confirmado — compartido entre el botón ✅ y la
// confirmación en lenguaje natural ("dale", "confirmalo", etc.) para no duplicar la lógica.
async function runPendingAction({ kind, payload, userId }) {
  let result;
  if (kind === 'email_send') result = await gmailSend(userId, payload);
  else if (kind === 'email_trash') {
    const results = [];
    for (const msgId of payload.messageIds) results.push(await gmailTrash(userId, msgId));
    const expired = results.some((r) => r.expired);
    const failed = results.filter((r) => !r.ok && !r.expired);
    result = { ok: !expired && failed.length === 0, expired, error: failed.map((r) => r.error).join('; ') };
  }
  else if (kind === 'calendar_event') result = await calendarCreateEvent(userId, payload);
  else if (kind === 'calendar_update') result = await calendarUpdateEvent(userId, payload);
  else if (kind === 'calendar_delete') result = await calendarDeleteEvent(userId, payload.eventId, payload.hasAttendees);
  else if (kind === 'tasks_delete_item') result = await tasksDelete(userId, payload.taskId, payload.tasklistId);
  else if (kind === 'tasks_delete_list') result = await tasksDeleteList(userId, payload.tasklistId);
  else return { ok: false, error: 'Tipo de confirmación no reconocido.' };
  return result;
}

function formatConfirmationOutcome(result) {
  if (result.expired) return '⚠️ No pude ejecutarlo: el token de Gmail/Calendar venció. Ya te mandé el link de reautorización.';
  if (!result.ok) return `❌ Falló: ${escapeHtml(result.error)}`;
  return '✅ Listo, confirmado y ejecutado.';
}

bot.action(/^confirm_(\d+)$/, async (ctx) => {
  const id = ctx.match[1];
  const pending = pendingConfirmations.get(id);
  await ctx.answerCbQuery();
  if (!pending) return ctx.editMessageText('Esta confirmación ya expiró.');
  clearPendingConfirmation(id);
  const result = await runPendingAction(pending);
  // Pedido de Mariano (29/07/2026): el borrador queda de registro visible, solo se sacan los
  // botones y se suma el resultado — no se reemplaza todo por un mensaje genérico.
  return ctx.editMessageText(`${pending.preview}\n\n${formatConfirmationOutcome(result)}`, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [] },
  });
});

bot.action(/^cancel_(\d+)$/, async (ctx) => {
  const id = ctx.match[1];
  const pending = pendingConfirmations.get(id);
  clearPendingConfirmation(id);
  await ctx.answerCbQuery();
  const previewPrefix = pending ? `${pending.preview}\n\n` : '';
  return ctx.editMessageText(`${previewPrefix}❌ Cancelado, no se hizo nada.`, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [] },
  });
});

// Clasifica una respuesta de texto libre cuando hay un borrador pendiente: confirmar/cancelar en
// lenguaje natural, letra atajo, sinónimo específico de la acción (ver ACTION_LABELS), o corrección.
// Match de mensaje COMPLETO (no substring) para no confundir un "sí" perdido en medio de una
// corrección larga ("sí, pero cambiale el título") con una confirmación real.
function classifyDraftReply(text, action) {
  const t = text.trim().toLowerCase().replace(/[.!¡¿?]+$/, '');
  const act = action || DEFAULT_ACTION_LABEL;
  if (t === act.letter.toLowerCase() || act.synonyms.includes(t)) return 'confirm';
  if (t === 'c') return 'cancel';
  if (/^(dale|ok|okay|listo|confirmo|confirmado|hacelo|s[ií])$/.test(t)) return 'confirm';
  if (/^(no|cancel[aá]|cancelalo|cancelala|dejalo|dejalo as[ií]|olvidalo|olvidate)$/.test(t)) return 'cancel';
  return 'revise';
}

// ─────────────────────────────────────────
// SYSTEM PROMPT
// ─────────────────────────────────────────
// H1 (v5.1): la fuente de comportamiento pasa a ser el archivo de prompt versionado, leído una
// sola vez al arrancar — no se reescribe a mano en el código, así queda auditable el cambio entre
// versiones (ver changelog dentro del propio archivo).
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'OPENGRAVITY_BOT_v5_0_H1_SYSTEM_PROMPT.md'), 'utf8');

// ─────────────────────────────────────────
// FECHA Y HORA (cálculo directo, sin IA ni web)
// ─────────────────────────────────────────
const TIME_KEYWORDS = ['qué hora es', 'que hora es', 'hora actual', 'hora en argentina', 'qué día es', 'que dia es', 'fecha de hoy', 'fecha actual'];
// Si la pregunta menciona otro día relativo a hoy, no sirve el atajo directo (que solo calcula
// "ahora") — bug real detectado 28/07/2026: "¿qué día es mañana?" contiene la keyword "qué día es"
// como substring y el atajo respondía con la fecha de HOY, ignorando "mañana". En estos casos se
// deja caer a la IA, que ya recibe la fecha real de hoy en el system prompt (buildSystemPromptFull).
const RELATIVE_DAY_WORDS = ['mañana', 'manana', 'ayer', 'anteayer'];

function isTimeQuery(text) {
  const t = text.toLowerCase();
  if (RELATIVE_DAY_WORDS.some(w => t.includes(w))) return false;
  return TIME_KEYWORDS.some(k => t.includes(k));
}

// Detecta preguntas tipo "¿con qué proveedor/modelo estás funcionando?" — se responde leyendo Firestore directo, sin llamar a la IA
function isConfigQuery(text) {
  const t = text.toLowerCase();
  return /\bcon\s+qu[eé]\s+(proveedor|modelo|ia)\b/.test(t) ||
    /\bqu[eé]\s+(proveedor|modelo|ia)\b.*\b(est[aá]s?|and[aá]s?|usa[sn]?|funcionando)\b/.test(t);
}

function getArgentinaDateTime() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  return formatter.format(now);
}

// Ventana "hoy" (00:00–23:59:59) en hora Argentina, independiente de la TZ del contenedor
// (Cloud Run no tiene TZ seteada — corre en UTC). Argentina usa UTC-3 fijo, sin horario de
// verano, desde 2009, así que el offset -03:00 es seguro de hardcodear. Usado por
// buildDailyBrief() para no mostrar eventos de ayer/mañana según la hora del día en que corre el cron.
function getArgentinaTodayBounds() {
  const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
  return {
    inicio: new Date(`${hoy}T00:00:00-03:00`),
    fin: new Date(`${hoy}T23:59:59-03:00`),
  };
}

// ─────────────────────────────────────────
// WEB: BÚSQUEDA + LECTURA DE URLS (Firecrawl)
// ─────────────────────────────────────────
async function scrapeUrl(url) {
  if (!process.env.FIRECRAWL_API_KEY) return null;
  try {
    const response = await axios.post(
      'https://api.firecrawl.dev/v1/scrape',
      { url, formats: ['markdown'] },
      {
        headers: { Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 20000,
      }
    );
    const md = response.data?.data?.markdown || response.data?.markdown || '';
    if (!md) return null;
    return `📄 *Contenido de ${url}:*\n\n${md.slice(0, 2000)}`;
  } catch (error) {
    console.error('Error scraping URL:', error.message);
    throw new Error('FIRECRAWL_UNAVAILABLE');
  }
}

// Quita verbos/frases de instrucción ("buscá", "investigá", "dame un resumen de") para dejar la query limpia
function cleanQuery(text) {
  const cleaned = text
    .replace(/\b(busc\w*|investig\w*|consult\w*|dame\s+(un\s+)?resumen\s+(breve\s+)?(de|sobre)?|quiero\s+saber)\b/gi, '')
    .replace(/^\s*[:\-–]\s*/, '')
    .replace(/^\d+\s*[\).-]?\s*/, '')
    .replace(/^["']|["']$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  // Si la limpieza dejó muy poco texto, usar el original (sin tocar) en vez de mandar basura
  return cleaned.length >= 3 ? cleaned : text.trim();
}

// Lista de países/jurisdicciones que, si aparecen en la query, evitan que forcemos "Argentina"
const OTHER_COUNTRIES = ['california', 'costa rica', 'méxico', 'mexico', 'españa', 'espana', 'chile',
  'uruguay', 'brasil', 'colombia', 'perú', 'peru', 'estados unidos', 'eeuu', 'usa', 'venezuela'];

// Este bot es para un abogado argentino: si la query no especifica otro país, anclamos a Argentina
// para evitar que la búsqueda traiga resultados de otras jurisdicciones (bug real observado: "reforma laboral" sin anclar trajo resultados de California y Costa Rica)
function anchorToArgentina(query) {
  const q = query.toLowerCase();
  if (q.includes('argentina') || OTHER_COUNTRIES.some(c => q.includes(c))) return query;
  return `${query} Argentina`;
}

async function searchWeb(query) {
  if (!process.env.TAVILY_API_KEY) return null;
  const cleanedQuery = anchorToArgentina(cleanQuery(query));
  if (cleanedQuery.length < 2) {
    console.log('Tavily: query descartada por ser muy corta:', JSON.stringify(query));
    return null;
  }
  try {
    const response = await axios.post(
      'https://api.tavily.com/search',
      {
        api_key: process.env.TAVILY_API_KEY,
        query: cleanedQuery,
        search_depth: 'basic',
        include_answer: true,
        max_results: 4,
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    const { answer, results } = response.data || {};
    if (!answer && !(results && results.length)) {
      console.log('Tavily: sin resultados para', cleanedQuery);
      return null;
    }
    let out = '';
    if (answer) out += `Respuesta directa: ${answer}\n\n`;
    if (results && results.length) {
      out += results
        .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${(r.content || '').slice(0, 400)}`)
        .join('\n\n');
    }
    return out.trim();
  } catch (error) {
    console.error('Error Tavily search:', JSON.stringify(query), '->', cleanedQuery, '|', error.response?.data || error.message);
    throw new Error('TAVILY_UNAVAILABLE');
  }
}

// ─────────────────────────────────────────
// HERRAMIENTAS (function calling) — el modelo decide cuándo y qué buscar
// ─────────────────────────────────────────
const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'buscar_web',
      description:
        'Busca información actualizada en internet (precios, cotizaciones, noticias, legislación vigente, jurisprudencia, commodities, mercados, etc.). ' +
        'Vos decidís el alcance geográfico según el tema: para derecho/laboral/impositivo/judicial de Mariano (abogado argentino), sumá "Argentina" a la query salvo que se pida otro país explícitamente. ' +
        'Para commodities, mercados internacionales, tecnología global o productos para vender en el mundo, NO restrinjas a Argentina — buscá con alcance internacional. ' +
        'Podés llamar esta herramienta varias veces si hay varios temas distintos en un mismo mensaje, pero con 1-2 búsquedas por tema alcanza — no sigas buscando indefinidamente, respondé en cuanto tengas información suficiente.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'La consulta de búsqueda específica y acotada, en español o en el idioma más natural para el tema.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'leer_url',
      description: 'Lee y extrae el contenido de una URL específica mencionada por el usuario.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'La URL completa a leer.' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hora_actual',
      description: 'Devuelve la fecha y hora exacta actual en Argentina. Usala siempre que te pregunten la hora o fecha — nunca la inventes.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'redactar_enviar_mail',
      description: 'Redacta un mail y lo presenta a Mariano como borrador con botones (✅ Confirmar / ❌ Cancelar) antes de enviarlo — NUNCA se envía directo, siempre pasa por este gate. Mariano también puede responder en lenguaje natural: confirmar ("dale", "enviá"), cancelar ("no", "cancelá"), o pedir una corrección en texto libre, en cuyo caso vas a recibir un mensaje pidiéndote que vuelvas a llamar esta misma herramienta con el borrador corregido. Si falta el destinatario, el asunto o el cuerpo, preguntá antes de llamar esta herramienta.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Email del destinatario.' },
          subject: { type: 'string', description: 'Asunto del mail.' },
          body: {
            type: 'string',
            description:
              'Cuerpo del mail en texto plano. OJO con pedidos dictados por voz: la transcripción pone punto final después de cada pausa al hablar ("El cuerpo. Quiero que diga. Buenas tardes. Espero que estés bien..."), así que el cuerpo casi siempre son VARIAS oraciones seguidas, no solo la primera después de "que diga"/"que sea". Tomá TODO el texto desde ahí hasta el final del pedido (o hasta que empiece a describir otro campo, como el asunto) — un cuerpo de una sola oración corta es la excepción, no la regla; si tenés dudas de dónde termina, incluí de más antes que cortar de menos.',
          },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'leer_mails_recientes',
      description: 'Lista los mails más recientes de la bandeja de entrada (id, remitente, asunto, primeras líneas) para que Mariano pueda pedir después que se mueva alguno a la papelera por su id. Nunca guardes el cuerpo completo en memoria, solo el resumen.',
      parameters: {
        type: 'object',
        properties: { cantidad: { type: 'number', description: 'Cuántos mails traer, default 5, máximo 10.' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mover_mail_papelera',
      description: 'Mueve uno o varios mails a la papelera (recuperable ~30 días) — SIEMPRE con confirmación previa por botones (una sola confirmación por lote si son varios, no una por una), nunca borrado directo. Necesita los ids exactos (usá leer_mails_recientes primero si no los tenés).',
      parameters: {
        type: 'object',
        properties: {
          messageIds: { type: 'array', items: { type: 'string' }, description: 'IDs exactos de los mails a mover a la papelera (uno o varios).' },
        },
        required: ['messageIds'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'crear_evento_calendar',
      description: 'Crea un evento en el Calendar de Mariano. Si NO tiene invitados, se ejecuta directo sin pedir nada. Si TIENE invitados (o se están agregando/notificando invitados existentes), se pide confirmación por botones antes de ejecutar — es el mismo gate que un mail, porque pasa a ser una comunicación a terceros. Google Calendar NO permite asignar un color/etiqueta personalizado vía esta herramienta — si te lo piden, avisá la limitación, no lo inventes como hecho.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Título del evento.' },
          description: { type: 'string', description: 'Descripción opcional.' },
          start: { type: 'string', description: 'Fecha/hora de inicio, formato ISO 8601 con zona horaria de Argentina (ej. 2026-07-28T10:00:00-03:00).' },
          end: { type: 'string', description: 'Fecha/hora de fin, mismo formato.' },
          attendees: { type: 'array', items: { type: 'string' }, description: 'Emails de invitados. Vacío o ausente si el evento es solo para Mariano.' },
          reminderMinutes: { type: 'number', description: 'Minutos antes del evento para la notificación/alarma, opcional (ej. 15).' },
        },
        required: ['summary', 'start', 'end'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buscar_eventos_calendar',
      description: 'Busca eventos existentes por título/texto y/o rango de fechas para conseguir su eventId. SIEMPRE llamá esta herramienta antes de editar_evento_calendar o borrar_evento_calendar cuando no tengas ya el eventId de la conversación — NUNCA le pidas el ID a Mariano, él identifica el evento por título/horario, vos lo buscás acá. Si hay un solo resultado, mostraselo y pedile que confirme que es ese antes de tocarlo. Si hay varios, mostrale la lista (título + horario) y preguntale cuál es.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Texto a buscar en título/descripción del evento (ej. "Padel Vairo"). Opcional si vas a filtrar solo por fecha.' },
          timeMin: { type: 'string', description: 'Desde cuándo buscar, ISO 8601 con zona de Argentina. Default: ahora.' },
          timeMax: { type: 'string', description: 'Hasta cuándo buscar, ISO 8601 con zona de Argentina. Default: 30 días desde ahora.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'editar_evento_calendar',
      description: 'Edita un evento existente (título, horario, descripción, recordatorio, invitados) — necesita el eventId. Si no lo tenés, llamá primero a buscar_eventos_calendar (por título y/o fecha) y confirmá con Mariano cuál es antes de editarlo — NUNCA le pidas el ID a él. Mismo gate que crear: libre si no toca invitados, confirmación por botones si agrega/notifica invitados. Usá esta herramienta para corregir un evento ya creado — NUNCA borres y recrees un evento a mano para "editarlo", eso no es una acción real.',
      parameters: {
        type: 'object',
        properties: {
          eventId: { type: 'string', description: 'ID exacto del evento a editar (obtenido de buscar_eventos_calendar o de una respuesta anterior).' },
          summary: { type: 'string' },
          description: { type: 'string' },
          start: { type: 'string', description: 'ISO 8601 con zona horaria de Argentina, solo si cambia.' },
          end: { type: 'string', description: 'ISO 8601 con zona horaria de Argentina, solo si cambia.' },
          attendees: { type: 'array', items: { type: 'string' }, description: 'Lista completa de invitados si cambia.' },
          reminderMinutes: { type: 'number', description: 'Minutos antes del evento para la notificación/alarma.' },
        },
        required: ['eventId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'borrar_evento_calendar',
      description: 'Borra un evento del Calendar (papelera de Calendar, recuperable) — SIEMPRE con confirmación previa por botones. Necesita el eventId: si no lo tenés, llamá primero a buscar_eventos_calendar (por título y/o fecha) y confirmá con Mariano cuál es antes de borrarlo — NUNCA le pidas el ID a él.',
      parameters: {
        type: 'object',
        properties: {
          eventId: { type: 'string', description: 'ID exacto del evento a borrar (obtenido de buscar_eventos_calendar o de una respuesta anterior).' },
          tieneInvitados: { type: 'boolean', description: 'Si el evento tiene invitados (afecta si se les notifica el borrado).' },
        },
        required: ['eventId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listar_listas_tareas',
      description: 'Lista todas las listas (tasklists) de Google Tasks existentes (id, título) — usalo cuando Mariano mencione una lista por nombre (para conseguir su tasklistId), cuando quiera ver qué listas tiene, o antes de crear_tarea/borrar_lista_tareas si no tenés ya el tasklistId. Si Mariano no menciona ninguna lista puntual, no hace falta llamar esto: crear_tarea sin tasklistId usa la lista por defecto.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'crear_lista_tareas',
      description: 'Crea una lista (tasklist) nueva en Google Tasks — sin confirmación, crear una lista vacía no tiene riesgo.',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string', description: 'Nombre de la lista nueva.' } },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'editar_lista_tareas',
      description: 'Renombra una lista (tasklist) existente de Google Tasks — sin confirmación, cambiar un nombre no tiene riesgo. Necesita el tasklistId: si no lo tenés, llamá primero a listar_listas_tareas y confirmá con Mariano cuál es antes de renombrarla — NUNCA le pidas el ID a él.',
      parameters: {
        type: 'object',
        properties: {
          tasklistId: { type: 'string', description: 'ID exacto de la lista a renombrar (obtenido de listar_listas_tareas).' },
          title: { type: 'string', description: 'Nuevo nombre de la lista.' },
        },
        required: ['tasklistId', 'title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'borrar_lista_tareas',
      description: 'Borra una lista (tasklist) completa de Google Tasks, junto con TODAS sus tareas — SIEMPRE con confirmación previa por botones, porque a diferencia de Calendar/Gmail no hay papelera de recuperación. Necesita el tasklistId: si no lo tenés, llamá primero a listar_listas_tareas y confirmá con Mariano cuál es antes de borrarla — NUNCA le pidas el ID a él.',
      parameters: {
        type: 'object',
        properties: {
          tasklistId: { type: 'string', description: 'ID exacto de la lista a borrar (obtenido de listar_listas_tareas).' },
          nombreLista: { type: 'string', description: 'Nombre de la lista, para mostrarlo en la confirmación.' },
        },
        required: ['tasklistId', 'nombreLista'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'crear_tarea',
      description: 'Crea un ítem en Google Tasks — sin confirmación, es una checklist personal. El campo due solo guarda fecha, nunca hora: si la instrucción menciona una hora específica, además llamá a crear_evento_calendar para esa hora (Tasks no tiene concepto de recordatorio propio, es limitación real de la API de Google). Si Mariano menciona una lista puntual por nombre, usá tasklistId (conseguilo con listar_listas_tareas primero); si no menciona ninguna, omitilo y va a la lista por defecto. Si el pedido es una SUBtarea de otra tarea ya existente ("agregale un paso a X", "como parte de Y"), usá parentTaskId con el id de la tarea padre (conseguilo con buscar_tareas si no lo tenés). Si Mariano pide "revisá/completá lo que faltó" de un lote que le pediste antes, es SEGURO volver a llamar esta herramienta para TODOS los ítems del lote original tal como los tengas en el historial, uno por uno — la herramienta detecta sola si un título ya existe en esa lista (mismo padre) y no lo duplica, así que no hace falta adivinar cuáles faltan.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Título de la tarea.' },
          notes: { type: 'string', description: 'Notas opcionales.' },
          due: { type: 'string', description: 'Fecha límite en formato ISO 8601 (solo fecha, ej. 2026-07-30T00:00:00.000Z), opcional.' },
          tasklistId: { type: 'string', description: 'ID de la lista destino, opcional (default: la lista por defecto de Mariano). Conseguilo con listar_listas_tareas si Mariano nombró una lista puntual.' },
          parentTaskId: { type: 'string', description: 'ID de la tarea padre, opcional — si se da, esta tarea se crea como subtarea de esa. Un solo nivel de anidamiento (límite de la API).' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'editar_tarea',
      description: 'Edita título, notas y/o fecha límite de una tarea de Tasks existente — sin confirmación, es una checklist personal. NUNCA uses esto para marcarla completa/pendiente (eso es marcar_tarea_completa/descompletar_tarea) ni para cambiarla de lista o hacerla subtarea (eso es mover_tarea). Necesita el taskId: si no lo tenés, llamá primero a buscar_tareas y confirmá con Mariano cuál es — NUNCA le pidas el ID a él.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'ID exacto de la tarea a editar (obtenido de buscar_tareas).' },
          tasklistId: { type: 'string', description: 'ID de la lista donde está la tarea, opcional (default: la lista por defecto). Si buscar_tareas devolvió un tasklistId, pasalo acá.' },
          title: { type: 'string', description: 'Nuevo título, opcional (omitir si no cambia).' },
          notes: { type: 'string', description: 'Nuevas notas, opcional (omitir si no cambia).' },
          due: { type: 'string', description: 'Nueva fecha límite ISO 8601 (solo fecha), opcional (omitir si no cambia).' },
        },
        required: ['taskId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mover_tarea',
      description: 'Convierte una tarea en subtarea de otra, o la vuelve a subir a tarea principal (sacándola de su padre actual) — sin confirmación, reversible. Necesita el taskId: si no lo tenés, llamá primero a buscar_tareas — NUNCA le pidas el ID a Mariano.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'ID exacto de la tarea a mover (obtenido de buscar_tareas).' },
          tasklistId: { type: 'string', description: 'ID de la lista donde está la tarea, opcional (default: la lista por defecto).' },
          parentTaskId: { type: 'string', description: 'ID de la nueva tarea padre. Omitilo (no lo mandes) si el pedido es sacarla de su padre y volverla tarea principal.' },
        },
        required: ['taskId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buscar_tareas',
      description: 'Lista las tareas de Google Tasks (id, título), opcionalmente filtradas por texto del título. SIEMPRE llamá esta herramienta antes de marcar_tarea_completa, descompletar_tarea o borrar_tarea cuando no tengas ya el taskId de la conversación — NUNCA le pidas el ID a Mariano, él te dice el título/tema de la tarea y vos la buscás acá. Si hay una sola coincidencia, confirmá con él que es esa antes de actuar. Si hay varias, mostrale la lista para que elija. Por default solo trae tareas pendientes: para encontrar una tarea YA completada (ej. para descompletarla), llamá de nuevo con incluirCompletadas:true. Si NO pasás tasklistId, busca en TODAS las listas de una sola vez (no hace falta llamar primero a listar_listas_tareas para encontrar en qué lista está algo) — pasá tasklistId solo si ya sabés que Mariano se refiere a una lista puntual.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Texto a buscar en el título de la tarea. Vacío para listar todas.' },
          tasklistId: { type: 'string', description: 'ID de una lista puntual para acotar la búsqueda a esa lista sola, opcional (default: busca en todas las listas).' },
          incluirCompletadas: { type: 'boolean', description: 'true para incluir tareas ya completadas en el resultado (por default se ocultan).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'marcar_tarea_completa',
      description: 'Marca un ítem de Google Tasks como completado — sin confirmación. Necesita el taskId: si no lo tenés, llamá primero a buscar_tareas y confirmá con Mariano cuál es antes de marcarla — NUNCA le pidas el ID a él.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'ID exacto de la tarea a marcar completa (obtenido de buscar_tareas o de una respuesta anterior).' },
          tasklistId: { type: 'string', description: 'ID de la lista donde está la tarea, opcional (default: la lista por defecto). Si buscar_tareas devolvió un tasklistId, pasalo acá.' },
        },
        required: ['taskId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'descompletar_tarea',
      description: 'Vuelve a marcar como pendiente una tarea de Google Tasks ya completada (toggle inverso a marcar_tarea_completa) — sin confirmación, es reversible. Necesita el taskId: si no lo tenés, llamá primero a buscar_tareas con incluirCompletadas:true (las completadas no aparecen por default) y confirmá con Mariano cuál es — NUNCA le pidas el ID a él.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'ID exacto de la tarea a descompletar (obtenido de buscar_tareas con incluirCompletadas:true).' },
          tasklistId: { type: 'string', description: 'ID de la lista donde está la tarea, opcional (default: la lista por defecto). Si buscar_tareas devolvió un tasklistId, pasalo acá.' },
        },
        required: ['taskId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'borrar_tarea',
      description: 'Borra un ítem de Google Tasks para siempre — SIEMPRE con confirmación previa por botones, porque a diferencia de Calendar no hay papelera de recuperación. Necesita el taskId: si no lo tenés, llamá primero a buscar_tareas y confirmá con Mariano cuál es antes de borrarla — NUNCA le pidas el ID a él.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'ID exacto de la tarea a borrar (obtenido de buscar_tareas).' },
          tasklistId: { type: 'string', description: 'ID de la lista donde está la tarea, opcional (default: la lista por defecto). Si buscar_tareas devolvió un tasklistId, pasalo acá.' },
          tituloTarea: { type: 'string', description: 'Título de la tarea, para mostrarlo en la confirmación.' },
        },
        required: ['taskId', 'tituloTarea'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'derivar_tarea_hermes',
      description: 'Deriva un pedido al carril de Hermes (buzón tareas_hermes) cuando necesita la PC local (filesystem, scripts) o razonamiento multi-paso pesado sin urgencia de nube — nunca para lo que vos podés resolver solo con Gmail/Calendar/Tasks. NUNCA llames esta herramienta sin tener criterio_exito y entregable ya confirmados con Mariano en el chat — si falta ese cierre, preguntá primero en vez de derivar con datos vagos.',
      parameters: {
        type: 'object',
        properties: {
          titulo: { type: 'string' },
          instruccion: { type: 'string', description: 'Imperativa y autocontenida — Hermes no ve el chat original.' },
          contexto: { type: 'string', description: 'Solo datos: rutas, nombres, valores.' },
          criterio_exito: { type: 'string' },
          entregable_tipo: { type: 'string', enum: ['archivo', 'texto', 'accion'] },
          entregable_destino: { type: 'string' },
          proyecto: { type: 'string', description: 'ej. general, dr_civil, broker.' },
          prioridad: { type: 'number', description: '1 urgente, 2 normal, 3 cuando puedas.' },
        },
        required: ['titulo', 'instruccion', 'criterio_exito', 'entregable_tipo', 'entregable_destino'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'regenerar_link_reautorizacion',
      description:
        'Genera y manda por Telegram un link nuevo para reautorizar el acceso de Google (Gmail/Calendar/Tasks), invalidando cualquier link anterior sin usar. ' +
        'Usala cuando Mariano lo pida en lenguaje natural — variantes tipo "dame un link nuevo para reautorizar", "el link venció, mandame otro", "necesito reautorizar Gmail", "quiero renovar el acceso de Google" — ' +
        'sin importar si el token está realmente vencido en este momento: el pedido explícito de Mariano ya es motivo suficiente (puede ser preventivo, o porque el estado quedó inconsistente). ' +
        'NUNCA respondas que el proceso "es automático" o que "no se puede generar manualmente" — para eso existe esta herramienta, siempre llamala ante este tipo de pedido en vez de explicarle a Mariano por qué no se puede.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'agregar_regla_bot',
      description:
        'Guarda una regla personal nueva que Mariano pide en lenguaje natural (ej. "agregame esta regla: nunca me sugieras reuniones después de las 20hs") para que se respete en TODAS las conversaciones futuras, no solo en esta. ' +
        'Inferí vos la categoría más razonable según el contenido de la regla si Mariano no la especifica explícitamente. Después de llamar esta herramienta, confirmale a Mariano qué quedó guardado y en qué categoría, para que pueda corregirte si interpretaste mal.',
      parameters: {
        type: 'object',
        properties: {
          texto: { type: 'string', description: 'La regla tal cual la dijo Mariano (o una versión levemente prolijada, sin cambiar el sentido).' },
          categoria: {
            type: 'string',
            enum: ['estilo', 'comportamiento', 'dato_fijo'],
            description: '"estilo" = cómo hablás/formateás (ej. tono, longitud). "comportamiento" = qué hacés o evitás hacer (ej. horarios, confirmaciones). "dato_fijo" = un dato que hay que recordar siempre (ej. una dirección, una preferencia fija).',
          },
        },
        required: ['texto', 'categoria'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listar_reglas_bot',
      description: 'Devuelve todas las reglas personales activas de Mariano, agrupadas por categoría, para que las pueda auditar por Telegram sin tocar Firestore a mano. Usala cuando pregunte algo como "¿qué reglas tengo guardadas?" o "listame mis reglas".',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'desactivar_regla_bot',
      description:
        'Desactiva una regla personal (no la borra, queda en Firestore con activa:false). Recibe el id exacto de la regla (si ya lo tenés de una llamada anterior a esta misma herramienta o a listar_reglas_bot) o una descripción/fragmento de texto en lenguaje natural. ' +
        'Si pasás una descripción y hay una sola coincidencia entre las reglas activas, la herramienta te la va a mostrar para que se la confirmes a Mariano ANTES de desactivarla — recién cuando confirme, volvé a llamar esta misma herramienta con el id exacto que te devolvió. ' +
        'Si hay varias coincidencias, te va a mostrar la lista para que Mariano elija cuál — mismo criterio que ya usás para editar/borrar eventos de Calendar o tareas de Tasks: nunca le pidas un id interno a él, buscalo y confirmalo vos.',
      parameters: {
        type: 'object',
        properties: {
          id_o_descripcion: { type: 'string', description: 'El id exacto de la regla (de una respuesta anterior), o una descripción/fragmento del texto de la regla que Mariano quiere desactivar.' },
        },
        required: ['id_o_descripcion'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'estado_cadena_modelos',
      description: 'Chequea en vivo (ping real contra OpenRouter, reusa el mismo mecanismo del job de las 9hs) el estado de los 4 modelos de la cadena de fallback y devuelve un checklist OK/caído de cada uno, más cuál es el modelo activo ahora mismo según el orden real de fallback. Usala cuando Mariano pregunte algo como "¿cómo están los modelos?", "estado de la cadena", "¿algún modelo está caído?" — es diagnóstico, no sirve para cambiar de modelo (eso es /config).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'derivar_tarea_project',
      description: 'Deriva un pedido al carril de un Project específico (Dr. Civil, Bróker, etc.) cuando necesita el contexto o los archivos de ese Project — ej. un dictamen jurídico, una propuesta de negocio.',
      parameters: {
        type: 'object',
        properties: {
          proyecto: { type: 'string', description: 'Nombre del Project, ej. "Dr. Civil", "Bróker".' },
          titulo: { type: 'string' },
        },
        required: ['proyecto', 'titulo'],
      },
    },
  },
];

const TOOL_HANDLERS = {
  buscar_web: async ({ query }) => {
    try {
      return (await searchWeb(query)) || 'Sin resultados relevantes para esta búsqueda.';
    } catch (error) {
      return 'No pude acceder a la búsqueda web en este momento.';
    }
  },
  leer_url: async ({ url }) => {
    try {
      return (await scrapeUrl(url)) || 'No se pudo leer el contenido de esa URL.';
    } catch (error) {
      return 'No pude leer esa URL en este momento.';
    }
  },
  hora_actual: async () => `Hora actual en Argentina: ${getArgentinaDateTime()}`,

  redactar_enviar_mail: async ({ to, subject, body }, ctx) => {
    if (googleOAuthExpired) return 'El token de Gmail está vencido, pendiente de reautorización. No se puede redactar/enviar hasta que Mariano reautorice.';
    // Bug real encontrado en vivo (29/07/2026): la transcripción de audio (Whisper) a veces come el
    // "@gmail" de una dirección dictada ("oliveramoa@gmail.com" -> "oliveramoa.com") — armar un
    // borrador de envío con una dirección así de rota es peor que no armarlo: hay que frenar ANTES
    // del gate, no después, y pedirle a Mariano que confirme la dirección exacta en texto.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((to || '').trim())) {
      return `La dirección "${to}" no tiene formato de email válido (le falta el @dominio, común cuando viene de audio). Preguntale a Mariano cuál es la dirección exacta antes de armar el borrador — no llames de nuevo a esta herramienta hasta tenerla.`;
    }
    const primeraLinea = body.split('\n').find((l) => l.trim()) || '';
    await askConfirmation(ctx, {
      kind: 'email_send',
      payload: { to, subject, body },
      preview: `📧 <b>¿Envío este mail?</b>\n\nPara: ${escapeHtml(to)}\nAsunto: ${escapeHtml(subject)}\n\n"${escapeHtml(primeraLinea.slice(0, 200))}"`,
    });
    return 'Le mostré la propuesta a Mariano con botones de confirmación — no se envió todavía.';
  },

  leer_mails_recientes: async ({ cantidad }, ctx) => {
    if (googleOAuthExpired) return 'El token de Gmail está vencido, pendiente de reautorización.';
    const max = Math.min(cantidad || 5, 10);
    const listResult = await callGoogleAPI(ctx.from.id, () => gmailClient.users.messages.list({ userId: 'me', maxResults: max }));
    if (!listResult.ok) return listResult.expired ? 'Token vencido, pendiente de reautorización.' : `Error: ${listResult.error}`;
    const ids = (listResult.data.data.messages || []).map((m) => m.id);
    const detalles = [];
    for (const id of ids) {
      const msgResult = await callGoogleAPI(ctx.from.id, () =>
        gmailClient.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'Subject'] })
      );
      if (!msgResult.ok) continue;
      const headers = msgResult.data.data.payload?.headers || [];
      const from = headers.find((h) => h.name === 'From')?.value || '(sin remitente)';
      const subject = headers.find((h) => h.name === 'Subject')?.value || '(sin asunto)';
      detalles.push(`id: ${id}\nDe: ${from}\nAsunto: ${subject}\n${(msgResult.data.data.snippet || '').slice(0, 150)}`);
    }
    return detalles.length ? detalles.join('\n\n') : 'No hay mails recientes.';
  },

  mover_mail_papelera: async ({ messageIds }, ctx) => {
    if (googleOAuthExpired) return 'El token de Gmail está vencido, pendiente de reautorización.';
    const ids = messageIds || [];
    if (!ids.length) return 'Falta al menos un messageId.';
    // Pedido de Mariano en la verificación de H1 (28/07/2026): con solo el id, los mails de la
    // confirmación son imposibles de reconocer a simple vista — se trae asunto/remitente de cada
    // uno para que la confirmación (la real, con botones) sea legible.
    const listado = [];
    for (const id of ids) {
      const msgResult = await callGoogleAPI(ctx.from.id, () =>
        gmailClient.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'Subject'] })
      );
      if (!msgResult.ok) { listado.push(`• ${escapeHtml(id)} (no pude leer el detalle)`); continue; }
      const headers = msgResult.data.data.payload?.headers || [];
      const from = headers.find((h) => h.name === 'From')?.value || '(sin remitente)';
      const subject = headers.find((h) => h.name === 'Subject')?.value || '(sin asunto)';
      listado.push(`• ${escapeHtml(subject)} — ${escapeHtml(from)}\n  (id: ${escapeHtml(id)})`);
    }
    await askConfirmation(ctx, {
      kind: 'email_trash',
      payload: { messageIds: ids },
      preview: `🗑️ <b>¿Muevo ${ids.length === 1 ? 'este mail' : `estos ${ids.length} mails`} a la papelera?</b>\n\n${listado.join('\n')}\n\n(Queda recuperable ~30 días)`,
    });
    return 'Le mostré la confirmación a Mariano — no se movió nada todavía.';
  },

  crear_evento_calendar: async ({ summary, description, start, end, attendees, reminderMinutes }, ctx) => {
    if (googleOAuthExpired) return 'El token de Calendar está vencido, pendiente de reautorización.';
    if (attendees && attendees.length) {
      await askConfirmation(ctx, {
        kind: 'calendar_event',
        payload: { summary, description, start, end, attendees, reminderMinutes },
        preview: `📅 <b>¿Creo este evento con invitados?</b>\n\n${escapeHtml(summary)}\n${escapeHtml(start)} → ${escapeHtml(end)}\nInvitados: ${escapeHtml(attendees.join(', '))}${reminderMinutes ? `\nRecordatorio: ${reminderMinutes} min antes` : ''}`,
      });
      return 'Tiene invitados, le mostré la confirmación a Mariano antes de crearlo.';
    }
    const result = await calendarCreateEvent(ctx.from.id, { summary, description, start, end, attendees: [], reminderMinutes });
    if (result.expired) return 'Token vencido, pendiente de reautorización.';
    if (!result.ok) return `Error creando el evento: ${result.error}`;
    return `Evento creado: ${summary} (${start} → ${end}), id ${result.data.data.id}.${reminderMinutes ? ` Recordatorio: ${reminderMinutes} min antes.` : ''}`;
  },

  buscar_eventos_calendar: async ({ query, timeMin, timeMax }, ctx) => {
    if (googleOAuthExpired) return 'El token de Calendar está vencido, pendiente de reautorización.';
    const result = await calendarSearchEvents(ctx.from.id, { query, timeMin, timeMax });
    if (result.expired) return 'Token vencido, pendiente de reautorización.';
    if (!result.ok) return `Error buscando eventos: ${result.error}`;
    const items = result.data.data.items || [];
    if (!items.length) return 'No encontré eventos que coincidan con esa búsqueda en el rango de fechas.';
    const listado = items.map((ev) => {
      const start = ev.start?.dateTime || ev.start?.date;
      const end = ev.end?.dateTime || ev.end?.date;
      const invitados = (ev.attendees || []).map((a) => a.email).join(', ');
      return `id: ${ev.id}\nTítulo: ${ev.summary || '(sin título)'}\n${start} → ${end}${invitados ? `\nInvitados: ${invitados}` : ''}`;
    });
    return listado.join('\n\n');
  },

  editar_evento_calendar: async ({ eventId, summary, description, start, end, attendees, reminderMinutes }, ctx) => {
    if (googleOAuthExpired) return 'El token de Calendar está vencido, pendiente de reautorización.';
    if (attendees && attendees.length) {
      await askConfirmation(ctx, {
        kind: 'calendar_update',
        payload: { eventId, summary, description, start, end, attendees, reminderMinutes },
        preview: `📅 <b>¿Edito este evento con invitados?</b>\n\nID: ${escapeHtml(eventId)}${summary ? `\nTítulo: ${escapeHtml(summary)}` : ''}${start ? `\n${escapeHtml(start)} → ${escapeHtml(end)}` : ''}\nInvitados: ${escapeHtml(attendees.join(', '))}`,
      });
      return 'Tiene invitados, le mostré la confirmación a Mariano antes de editarlo.';
    }
    const result = await calendarUpdateEvent(ctx.from.id, { eventId, summary, description, start, end, attendees, reminderMinutes });
    if (result.expired) return 'Token vencido, pendiente de reautorización.';
    if (!result.ok) return `Error editando el evento: ${result.error}`;
    return `Evento editado (id ${eventId}).`;
  },

  borrar_evento_calendar: async ({ eventId, tieneInvitados }, ctx) => {
    if (googleOAuthExpired) return 'El token de Calendar está vencido, pendiente de reautorización.';
    await askConfirmation(ctx, {
      kind: 'calendar_delete',
      payload: { eventId, hasAttendees: !!tieneInvitados },
      preview: `🗑️ <b>¿Borro este evento?</b>\n\nID: ${escapeHtml(eventId)}${tieneInvitados ? '\n⚠️ Tiene invitados, se les va a notificar el borrado.' : ''}`,
    });
    return 'Le mostré la confirmación a Mariano — no se borró todavía.';
  },

  listar_listas_tareas: async (_args, ctx) => {
    if (googleOAuthExpired) return 'El token de Tasks está vencido, pendiente de reautorización.';
    const result = await tasksListLists(ctx.from.id);
    if (result.expired) return 'Token vencido, pendiente de reautorización.';
    if (!result.ok) return `Error listando las listas: ${result.error}`;
    const items = result.data.data.items || [];
    if (!items.length) return 'No encontré ninguna lista de Tasks.';
    return items.map((l) => `id: ${l.id}\nTítulo: ${l.title}`).join('\n\n');
  },

  crear_lista_tareas: async ({ title }, ctx) => {
    if (googleOAuthExpired) return 'El token de Tasks está vencido, pendiente de reautorización.';
    const result = await tasksCreateList(ctx.from.id, title);
    if (result.expired) return 'Token vencido, pendiente de reautorización.';
    if (!result.ok) return `Error creando la lista: ${result.error}`;
    if (result.alreadyExisted) return `Ya existía una lista con el título "${title}" (id ${result.data.data.id}) — no se creó de nuevo, se usa la existente.`;
    return `Lista creada: "${title}", id ${result.data.data.id}.`;
  },

  editar_lista_tareas: async ({ tasklistId, title }, ctx) => {
    if (googleOAuthExpired) return 'El token de Tasks está vencido, pendiente de reautorización.';
    const result = await tasksRenameList(ctx.from.id, tasklistId, title);
    if (result.expired) return 'Token vencido, pendiente de reautorización.';
    if (!result.ok) return `Error renombrando la lista: ${result.error}`;
    return `Lista renombrada a "${title}".`;
  },

  borrar_lista_tareas: async ({ tasklistId, nombreLista }, ctx) => {
    if (googleOAuthExpired) return 'El token de Tasks está vencido, pendiente de reautorización.';
    await askConfirmation(ctx, {
      kind: 'tasks_delete_list',
      payload: { tasklistId },
      preview: `🗑️ <b>¿Borro la lista "${escapeHtml(nombreLista)}" y TODAS sus tareas?</b>\n\nID: ${escapeHtml(tasklistId)}\n⚠️ No hay papelera, es definitivo.`,
    });
    return 'Le mostré la confirmación a Mariano — no se borró todavía.';
  },

  crear_tarea: async ({ title, notes, due, tasklistId, parentTaskId }, ctx) => {
    if (googleOAuthExpired) return 'El token de Tasks está vencido, pendiente de reautorización.';
    const result = await tasksCreate(ctx.from.id, { title, notes, due, tasklistId, parentTaskId });
    if (result.expired) return 'Token vencido, pendiente de reautorización.';
    if (!result.ok) return `Error creando la tarea: ${result.error}`;
    if (result.alreadyExisted) return `Ya existía una tarea con el título "${title}" en esa lista (id ${result.data.data.id}) — no se creó de nuevo, se saltea sola.`;
    return `Tarea creada: "${title}"${due ? ` (vence ${due.slice(0, 10)})` : ''}${parentTaskId ? ` como subtarea de ${parentTaskId}` : ''}. Recordá: due no guarda hora, si hace falta hora exacta hay que crear también un evento de Calendar.`;
  },

  editar_tarea: async ({ taskId, tasklistId, title, notes, due }, ctx) => {
    if (googleOAuthExpired) return 'El token de Tasks está vencido, pendiente de reautorización.';
    const result = await tasksUpdate(ctx.from.id, taskId, { title, notes, due, tasklistId });
    if (result.expired) return 'Token vencido, pendiente de reautorización.';
    if (!result.ok) return `Error editando la tarea: ${result.error}`;
    return 'Tarea editada.';
  },

  mover_tarea: async ({ taskId, tasklistId, parentTaskId }, ctx) => {
    if (googleOAuthExpired) return 'El token de Tasks está vencido, pendiente de reautorización.';
    const result = await tasksMove(ctx.from.id, taskId, { tasklistId, parentTaskId });
    if (result.expired) return 'Token vencido, pendiente de reautorización.';
    if (!result.ok) return `Error moviendo la tarea: ${result.error}`;
    return parentTaskId ? `Tarea convertida en subtarea de ${parentTaskId}.` : 'Tarea promovida a tarea principal.';
  },

  buscar_tareas: async ({ query, tasklistId, incluirCompletadas }, ctx) => {
    if (googleOAuthExpired) return 'El token de Tasks está vencido, pendiente de reautorización.';
    const result = await tasksSearch(ctx.from.id, { query, tasklistId, showCompleted: !!incluirCompletadas });
    if (result.expired) return 'Token vencido, pendiente de reautorización.';
    if (!result.ok) return `Error buscando tareas: ${result.error}`;
    const items = result.data.data.items || [];
    if (!items.length) return 'No encontré tareas que coincidan con esa búsqueda.';
    return items.map((t) => `id: ${t.id}\ntasklistId: ${t.tasklistId}${t.tasklistTitle ? ` (${t.tasklistTitle})` : ''}\nTítulo: ${t.title}${t.status === 'completed' ? ' (completada)' : ''}${t.parent ? `\nSubtarea de: ${t.parent}` : ''}`).join('\n\n');
  },

  marcar_tarea_completa: async ({ taskId, tasklistId }, ctx) => {
    if (googleOAuthExpired) return 'El token de Tasks está vencido, pendiente de reautorización.';
    const result = await tasksComplete(ctx.from.id, taskId, tasklistId);
    if (result.expired) return 'Token vencido, pendiente de reautorización.';
    if (!result.ok) return `Error marcando la tarea: ${result.error}`;
    return 'Tarea marcada como completa.';
  },

  descompletar_tarea: async ({ taskId, tasklistId }, ctx) => {
    if (googleOAuthExpired) return 'El token de Tasks está vencido, pendiente de reautorización.';
    const result = await tasksUncomplete(ctx.from.id, taskId, tasklistId);
    if (result.expired) return 'Token vencido, pendiente de reautorización.';
    if (!result.ok) return `Error descompletando la tarea: ${result.error}`;
    return 'Tarea vuelta a marcar como pendiente.';
  },

  borrar_tarea: async ({ taskId, tasklistId, tituloTarea }, ctx) => {
    if (googleOAuthExpired) return 'El token de Tasks está vencido, pendiente de reautorización.';
    await askConfirmation(ctx, {
      kind: 'tasks_delete_item',
      payload: { taskId, tasklistId },
      preview: `🗑️ <b>¿Borro esta tarea?</b>\n\n"${escapeHtml(tituloTarea)}"\nID: ${escapeHtml(taskId)}\n⚠️ No hay papelera, es definitivo.`,
    });
    return 'Le mostré la confirmación a Mariano — no se borró todavía.';
  },

  // ítem 151 (29/08/2026) — reglas personales persistentes, colección Firestore `bot_rules`.
  agregar_regla_bot: async ({ texto, categoria }) => {
    const categoriaValida = ['estilo', 'comportamiento', 'dato_fijo'].includes(categoria) ? categoria : 'comportamiento';
    const doc = { texto, categoria: categoriaValida, fecha_creacion: new Date().toISOString(), activa: true };
    const ref = await db.collection('bot_rules').add(doc);
    await logAccion({ accion: 'agregar_regla_bot', destinatario_o_archivo: ref.id, confirmada: true, resultado: `regla creada (${categoriaValida}): "${texto}"` });
    return `Regla guardada en la categoría "${categoriaValida}": "${texto}" (id ${ref.id}). Va a aplicar desde el próximo mensaje. Confirmale a Mariano qué quedó guardado y en qué categoría, para que te corrija si hizo falta otra.`;
  },

  listar_reglas_bot: async () => {
    const snap = await db.collection('bot_rules').where('activa', '==', true).get();
    if (snap.empty) return 'No hay ninguna regla personal activa guardada todavía.';
    const porCategoria = {};
    snap.forEach((doc) => {
      const d = doc.data();
      (porCategoria[d.categoria] ||= []).push(`- [id: ${doc.id}] ${d.texto}`);
    });
    return Object.entries(porCategoria)
      .map(([categoria, items]) => `[${categoria}]\n${items.join('\n')}`)
      .join('\n\n');
  },

  desactivar_regla_bot: async ({ id_o_descripcion }) => {
    const snap = await db.collection('bot_rules').where('activa', '==', true).get();
    if (snap.empty) return 'No hay ninguna regla activa para desactivar.';

    const idBuscado = (id_o_descripcion || '').trim();
    const porId = snap.docs.find((d) => d.id === idBuscado);
    if (porId) {
      await porId.ref.set({ activa: false }, { merge: true });
      await logAccion({ accion: 'desactivar_regla_bot', destinatario_o_archivo: porId.id, confirmada: true, resultado: `desactivada: "${porId.data().texto}"` });
      return `Regla desactivada: "${porId.data().texto}". Sigue guardada en Firestore con activa:false, no se borró.`;
    }

    const q = idBuscado.toLowerCase();
    const matches = snap.docs.filter((d) => {
      const t = d.data().texto.toLowerCase();
      return t.includes(q) || q.includes(t);
    });
    if (!matches.length) {
      return `No encontré ninguna regla activa que coincida con "${id_o_descripcion}". Llamá a listar_reglas_bot para ver el texto exacto de las reglas activas y volvé a intentar.`;
    }
    if (matches.length > 1) {
      return `Encontré varias reglas activas que podrían coincidir — mostrale esta lista a Mariano para que elija cuál, y volvé a llamar esta misma herramienta con el id exacto de la que confirme:\n${matches.map((d) => `- id: ${d.id} — "${d.data().texto}"`).join('\n')}`;
    }
    const [match] = matches;
    return `Encontré esta regla activa que coincide: id: ${match.id} — "${match.data().texto}". Confirmale a Mariano que es esta antes de desactivarla — volvé a llamar esta misma herramienta con ese id exacto una vez que confirme.`;
  },

  // ítem 152 (29/08/2026) — reusa pingAllCatalogModels() ya existente (job de las 9hs), no
  // duplica la lógica de ping. "Modelo activo ahora" replica el mismo orden real de callAI():
  // primero el modelo configurado (config.model, lo que se intenta primero de verdad), después
  // la cadena fija de fallback tal cual está hardcodeada ahí — no es un dato que pingAllCatalogModels()
  // devuelva por sí solo, se infiere cruzando ambas cosas.
  estado_cadena_modelos: async (_args, ctx) => {
    const config = await getConfig(ctx.from.id);
    const pings = await pingAllCatalogModels();
    const byModel = Object.fromEntries(pings.map((p) => [p.model, p]));
    const ordenFallback = [
      config?.model || MODELS_BY_PROVIDER.openrouter.default,
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'minimax/minimax-m3:free',
      'openrouter/free',
    ];
    const cadenaSinRepetir = [...new Set(ordenFallback)];
    const activo = cadenaSinRepetir.find((m) => byModel[m]?.ok);
    const lineas = pings.map((p, i) => `${i + 1}. ${p.model} — ${p.ok ? '✅ OK' : `❌ caído${p.detail ? `: ${p.detail}` : ''}`}`);
    return `Estado de la cadena de modelos:\n${lineas.join('\n')}\nModelo activo ahora: ${activo || 'ninguno — los 4 modelos están caídos en este momento.'}`;
  },

  // El carril "Project" (buzón Drive por carpeta) tiene desde el ítem 146 (29/08/2026) el scope
  // drive.readonly autorizado (GOOGLE_OAUTH_SCOPES), pero eso solo es el permiso — todavía no hay
  // ningún cliente de Drive API ni lógica de lectura/escritura de archivos conectada en este código
  // (eso sigue siendo H2/H3 según el .md base). Se deja el tool para que el modelo reconozca el
  // pedido y avise la limitación real en vez de fingir que lo hizo (Lección Gordon).
  derivar_tarea_project: async ({ proyecto, titulo }) => {
    return `No puedo derivar todavía al carril de Project ("${proyecto}: ${titulo}") — el scope de Google Drive ya está autorizado, pero la integración real (leer/escribir en el buzón de Drive de los Projects) todavía no está implementada en el código, queda para un hito posterior (H2/H3). Es una limitación real, no un error.`;
  },

  derivar_tarea_hermes: async ({ titulo, instruccion, contexto, criterio_exito, entregable_tipo, entregable_destino, proyecto, prioridad }) => {
    if (!criterio_exito || !entregable_destino) {
      return 'Falta criterio_exito y/o entregable confirmados con Mariano — preguntale antes de derivar, no se creó la tarea.';
    }
    const doc = {
      esquema: 1,
      estado: 'pendiente',
      titulo,
      instruccion,
      contexto: contexto || '',
      criterio_exito,
      entregable: { tipo: entregable_tipo || 'texto', destino: entregable_destino },
      proyecto: proyecto || 'general',
      prioridad: prioridad || 2,
      creada: new Date().toISOString(),
      creada_por: 'bot',
      actualizada: new Date().toISOString(),
      intentos: 0,
      resultado: null,
    };
    const ref = await db.collection('tareas_hermes').add(doc);
    await logAccion({ accion: 'derivar_tarea_hermes', destinatario_o_archivo: ref.id, confirmada: true, resultado: `creada: ${titulo}` });
    return `Tarea derivada a Hermes (id ${ref.id}): "${titulo}".`;
  },

  regenerar_link_reautorizacion: async (_args, ctx) => {
    const userId = ctx?.chat?.id || process.env.TELEGRAM_ALLOWED_USER_ID;
    await sendReauthLink(userId, { automatico: false });
    await logAccion({
      accion: 'oauth_reautorizacion_pedida_on_demand',
      destinatario_o_archivo: 'google-oauth-refresh-token',
      confirmada: true,
      resultado: 'link nuevo generado y enviado a pedido explícito',
    });
    return 'Listo, ya mandé el link de reautorización nuevo por Telegram (invalidó cualquier link anterior sin usar). No hace falta que se lo repitas en tu respuesta, el link ya fue enviado como mensaje aparte.';
  },
};

async function executeToolCall(toolCall, ctx) {
  const fn = TOOL_HANDLERS[toolCall.function.name];
  if (!fn) return 'Herramienta no reconocida.';
  try {
    const args = JSON.parse(toolCall.function.arguments || '{}');
    return await fn(args, ctx);
  } catch (error) {
    console.error(`Error ejecutando ${toolCall.function.name}:`, error.message);
    return `Error al ejecutar la herramienta: ${error.message}`;
  }
}

// ─────────────────────────────────────────
// CALL AI
// ─────────────────────────────────────────

// Limpia los mensajes: solo { role, content } — Groq rechaza campos extra como timestamp
function cleanMessages(messages) {
  return messages.map(m => ({ role: m.role, content: m.content }));
}

// Llama al endpoint OpenAI-compatible con soporte de tool-calling, resolviendo hasta 2 rondas de herramientas
// Sentinel devuelto cuando una herramienta gateada (Gmail/Calendar con invitados) ya mandó su
// propia UI de confirmación — distinto de null (que en callAIWithTimeout significa "timeout").
const GATED_NO_REPLY = '__GATED_NO_REPLY__';

// Heurísticas determinísticas (no dependen del modelo) para detectar que el modelo narró en
// texto libre algo que debía ser una llamada real a herramienta — ver comentario de uso más abajo.
//
// Firma 1: botones inventados. Los botones reales de askConfirmation viven en el reply_markup de
// Telegram, JAMÁS como glifos dentro del texto del mensaje (los preview de askConfirmation usan
// 📧/🗑️/📅, nunca ✅/❌ — confirmado grep sobre el código). Bug real visto en vivo (29/07/2026,
// captura de Mariano): el modelo escribió "✅ Mover a papelera  ❌ Cancelar" como texto plano no
// clickeable en vez de llamar a mover_mail_papelera. La versión anterior de esta firma exigía
// además la palabra "confirm" en el texto — ese caso real no la tenía ("pulsá el botón
// correspondiente"), así que no se detectó. Ahora alcanza con que aparezcan los dos glifos juntos.
function looksLikeFakeActionConfirmation(text) {
  if (!text) return false;
  return text.includes('✅') && text.includes('❌');
}

// Firma 2: acción gateada declarada como YA HECHA sin haber pasado por el gate real. Por
// construcción de chatWithTools: si askConfirmation se llamó de verdad en esta misma conversación,
// la función corta con GATED_NO_REPLY antes de llegar nunca a esta rama de texto final sin
// tool_calls (ver el corte más abajo). redactar_enviar_mail, mover_mail_papelera y
// borrar_evento_calendar SIEMPRE gatean, sin excepción — no existe un camino legítimo en el que el
// texto final declare enviado/movido/borrado sin que el gate real haya disparado antes. Si llegamos
// acá con esa declaración, es inventado. Deliberadamente NO incluye crear/editar/completar (esas sí
// tienen caminos legítimos sin gate cuando no hay invitados).
function looksLikeFakeCompletedGatedAction(text) {
  if (!text) return false;
  const completedPhrase = /\b(ya\s+(lo\s+|la\s+)?(borr[eé]|elimin[eé]|mov[ií]|envi[eé])|borrad[oa]|eliminad[oa]|movid[oa]\s+a\s+la\s+papelera|enviad[oa])\b/i;
  const actionNoun = /\b(mail|correo|evento|papelera)\b/i;
  return completedPhrase.test(text) && actionNoun.test(text);
}

// Firma 3: acción de Tasks LIBRE (sin gate) declarada como YA HECHA sin que la herramienta
// correspondiente se haya llamado de verdad en este intercambio. Bug real visto en vivo
// (31/07/2026): pedido de crear 4 tareas en lote agotó las 3 rondas creando solo 3 — Mariano
// reformuló el pedido, y en ese reintento el modelo, en vez de volver a llamar crear_tarea,
// contestó "✅ Tareas creadas..." con título de lista e id reales (vistos en el historial de la
// conversación) pero CERO tool_calls en esa ronda — invención completa, no una simple confusión de
// texto. La Firma 2 no lo agarra porque deliberadamente excluye crear/editar/marcar (tienen camino
// legítimo sin gate) — acá el criterio no es el texto solo, es cruzarlo con qué herramientas se
// llamaron de verdad en TODO el intercambio (no solo la última ronda).
const TASKS_FREE_ACTION_TOOLS = ['crear_tarea', 'crear_lista_tareas', 'editar_tarea', 'editar_lista_tareas', 'marcar_tarea_completa', 'descompletar_tarea', 'mover_tarea'];
function looksLikeFakeCompletedTasksAction(text, calledTools) {
  if (!text) return false;
  // Permisivo a propósito: "Subtarea comer perro creada" tiene el título METIDO entre "subtarea" y
  // "creada" (no son palabras adyacentes) — la versión anterior de este regex exigía adyacencia y
  // no detectaba esta frase real. Ver Firma 4 para el chequeo fino por título exacto.
  const completedPhrase = /\b(tarea|subtarea|lista)\b[^.!?\n]{0,60}\b(creada|creadas|editada|editadas|marcada|descompletada|movida|convertida|renombrada|renombradas)\b/i;
  if (!completedPhrase.test(text)) return false;
  return !TASKS_FREE_ACTION_TOOLS.some((t) => calledTools.has(t));
}

// Firma 4: incluso con AL MENOS una llamada real a crear_tarea/editar_tarea en el intercambio, el
// texto final puede colar OTRO título como "creado" que nunca pasó por la herramienta — bug real
// visto en vivo (31/07/2026): en un pedido de 2 subtareas, se llamó crear_tarea solo para
// "ventiladores tres" (resultó "ya existía"), y el texto final declaró TAMBIÉN "comer perro
// creada" sin ninguna llamada para ese título — la Firma 3 no lo agarra porque calledTools SÍ tiene
// crear_tarea (por la otra llamada). Acá el chequeo es por título, no por si la herramienta se usó.
function stripAccents(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function looksLikeFakeCreatedTaskTitle(text, actionedTitles) {
  if (!text) return false;
  const claimRegex = /\b(?:sub)?tarea\s+"?([^".!?\n]{2,60}?)"?\s+(?:fue\s+)?(?:creada|creado|editada|editado)\b/gi;
  let match;
  while ((match = claimRegex.exec(text)) !== null) {
    const claimed = stripAccents(match[1].trim().toLowerCase());
    if (!claimed) continue;
    const found = [...actionedTitles].some((t) => {
      const real = stripAccents(t.trim().toLowerCase());
      return real === claimed || real.includes(claimed) || claimed.includes(real);
    });
    if (!found) return true;
  }
  return false;
}

// Firma 5 (ítem 113, 05/08/2026): narrativa de vencimiento OAuth inventada. Evidencia real: una
// captura de Mariano mostró al Bot mandando "Token de Google Calendar venció (modo Testing)...
// https://auth.opengravity.bot/google-calendar-reauth?user=mariano" — ese dominio y esa función NO
// existen en ningún lugar del código (confirmado por grep en todo el repo). La ÚNICA función real
// que avisa un vencimiento es handleOAuthExpiry(): siempre manda el mismo texto fijo con la URL real
// de accounts.google.com (nunca menciona un evento puntual por título), y solo se dispara cuando
// googleOAuthExpired ya pasó a true. Si el texto final narra un vencimiento/reautorización de Google
// mientras el estado real dice que NO está vencido, es invención del modelo — se bloquea igual que
// las Firmas 2-4, no una "confirmación con botones falsos" sino su equivalente para un aviso de error.
function looksLikeFakeOAuthExpiryNarrative(text) {
  if (!text || googleOAuthExpired) return false; // si de verdad está vencido, la narrativa puede ser legítima
  const expiryPhrase = /\b(token|acceso)\b[^.!?\n]{0,60}\b(venci[oó]|expir[oó])\b/i;
  const reauthMention = /reautoriz|re-?autoriz/i;
  return expiryPhrase.test(text) && reauthMention.test(text);
}

// Filtro defensivo contra el canal "analysis" (razonamiento oculto) de gpt-oss filtrándose al
// content final — bug documentado upstream, no nuestro (ver handoff 30/07/2026). Visto una vez en
// vivo: la respuesta arrancó con ". We can say that editing drafts is not within current
// capabilities... So respond accordingly." antes del texto en español real. Deliberadamente
// conservador para no arriesgar cortar contenido legítimo: solo actúa sobre señales muy
// específicas del glitch (tokens de control literales del formato "harmony", o el patrón exacto
// de arrancar con un punto suelto seguido de una frase en inglés) — cualquier otra cosa la deja
// intacta, aunque eso signifique no atrapar variantes que todavía no vimos.
function stripLeakedReasoningPreamble(text) {
  if (!text) return text;
  let cleaned = text;
  // Tokens de control del formato harmony que a veces sobreviven al parseo del proveedor.
  cleaned = cleaned.replace(/<\|(?:start|end|channel|message|return|call)\|>[a-z]*/gi, '').trim();
  // Patrón exacto visto en vivo: arranca con un punto suelto + una oración en inglés de
  // meta-razonamiento, antes del texto en español real.
  const leakMatch = cleaned.match(/^\.\s*([A-Z][^.!?]*[.!?]\s*)+/);
  if (leakMatch) {
    const preamble = leakMatch[0];
    const rest = cleaned.slice(preamble.length).trim();
    const spanishSignal = /[áéíóúñ¿¡]/;
    const englishMarker = /\b(we can|we should|we must|so respond|respond accordingly|current capabilities|the user|i (?:should|must|will))\b/i;
    if (rest && !spanishSignal.test(preamble) && englishMarker.test(preamble)) {
      cleaned = rest;
    }
  }
  return cleaned;
}

// Firma 6 (05/08/2026): el modelo presentando una tabla/lista de resultados de una herramienta de
// LECTURA (buscar_tareas, leer_mails_recientes, buscar_eventos_calendar) sin haberla llamado en
// este intercambio. Distinto de las Firmas 2-5 (que cubren ACCIONES declaradas como "ya hechas"):
// acá no hay un verbo de acción completada, es una narrativa de datos que nunca se consultaron en
// esta ronda. Bug real visto en vivo: pedido "mail → evento → cruce con tareas pendientes" en el
// que el modelo llamó leer_mails_recientes y buscar_eventos_calendar pero NUNCA buscar_tareas, y
// aun así devolvió una tabla "Cruce con tus tareas pendientes" con títulos reales.
//
// Mecanismo confirmado por código antes de escribir esto (no asumido): `messages` — el parámetro
// de entrada de chatWithTools, con el historial persistido de Firestore ya cargado por getHistory
// más el mensaje nuevo — es lo único que el modelo ve de turnos anteriores. Los resultados crudos
// de tool-calls (role:'tool') NUNCA se persisten entre turnos (saveMessage solo guarda texto
// user/assistant); solo la respuesta final en texto de una ronda anterior queda en el historial. En
// el caso real, los títulos de tareas fabricados coincidían EXACTO con una respuesta real de
// buscar_tareas de un turno anterior de la misma conversación (guardada como texto) — el modelo los
// reusó de memoria conversacional real en vez de re-consultar. Eso es distinto de inventar de la
// nada: por eso esta firma cruza contra el historial antes de bloquear, y solo bloquea si el dato
// no aparece en NINGÚN lado (ni tool-call de esta ronda, ni historial real de turnos anteriores).
const READ_TOOL_SIGNATURES = [
  { tool: 'buscar_tareas', header: /\b(tareas?\s+pendientes?|cruce\s+con\s+(tus?\s+)?tareas?|lista\s+de\s+tareas?)\b/i },
  { tool: 'leer_mails_recientes', header: /\b(mails?\s+recientes?|correos?\s+recientes?|último\s+mail|últimos?\s+mails?)\b/i },
  { tool: 'buscar_eventos_calendar', header: /\beventos?\b[^.\n]{0,25}\bcalendar\b|\bagenda(?:do|dos)?\s+ese\s+(?:mismo\s+)?d[ií]a\b/i },
];
// Normaliza para comparar texto nuevo contra historial sin que el formato Markdown (tablas,
// negritas) haga fallar una coincidencia real.
function normalizeForReadCompare(s) {
  return s.replace(/[|*_`#>-]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}
function looksLikeFakeReadResult(text, calledTools, historyMessages) {
  if (!text) return false;
  // Necesita evidencia de datos enumerados (tabla o lista real), no solo mencionar el tema de paso.
  const hasEnumeratedData = /\|.+\|.+\|/.test(text) || (text.match(/^[-•]\s+.+$/gm) || []).length >= 2;
  if (!hasEnumeratedData) return false;
  const historyText = normalizeForReadCompare(historyMessages.map((m) => String(m.content || '')).join('\n'));
  for (const sig of READ_TOOL_SIGNATURES) {
    if (calledTools.has(sig.tool)) continue; // se llamó de verdad en esta ronda, no hay nada sospechoso
    if (!sig.header.test(text)) continue;
    // ¿Los datos ya aparecieron en una respuesta REAL de un turno anterior de esta conversación?
    const candidateLines = text.split('\n').filter((l) => /[a-záéíóúñ]{3,}/i.test(l));
    const reusedFromHistory = candidateLines.some((line) => {
      // Una fila de tabla nueva mezcla el título real con columnas inventadas (ej. "conexión
      // lavarropas | No") — probamos la línea entera Y cada celda por separado.
      const cells = line.split('|').map(normalizeForReadCompare).filter((c) => c.length > 4);
      const candidates = [normalizeForReadCompare(line), ...cells];
      return candidates.some((c) => c.length > 4 && historyText.includes(c));
    });
    if (!reusedFromHistory) return true; // no se llamó Y no está en el historial real: inventado
  }
  return false;
}

async function chatWithTools(url, apiKey, model, messages, onToolNotice, ctx) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  let convo = [...messages];
  // Diagnóstico temporal (ver [[opengravity-bot-latencia]]): sin esto, agotar las rondas de
  // herramientas queda invisible en los logs — no tira ningún error, solo devuelve el mensaje
  // genérico. Necesitamos ver qué tool pidió el modelo en cada ronda para decidir el número
  // correcto de rondas con datos reales en vez de conjeturar.
  const providerLabel = url.includes('groq') ? 'groq' : 'openrouter';
  let lastToolNames = [];
  // Acumula TODAS las herramientas llamadas de verdad en todo el intercambio (no solo la última
  // ronda) — necesario para la Firma 3 de looksLikeFakeCompletedTasksAction más abajo.
  const calledTools = new Set();
  // Títulos de crear_tarea/editar_tarea realmente invocados en este intercambio — necesario para
  // la Firma 4 (chequeo por título exacto, más fino que calledTools) de looksLikeFakeCreatedTaskTitle.
  const actionedTitles = new Set();
  // Se probó subir a 5 rondas (31/07/2026) para pedidos de lote, pero se revirtió el mismo día:
  // ya había un motivo real para el límite de 3 (ver comentario de AI_TIMEOUT_MS más abajo) — más
  // rondas reales contra Google significa más chance de pisar el timeout general de 40s, y eso
  // causó duplicados de verdad (ver looksLikeFakeCompletedTasksAction y el fix de callAIWithTimeout
  // para el resultado tardío). Se queda en 3; los pedidos de lote grandes quedan mejor resueltos
  // pidiéndole a Mariano que los parta en mensajes más chicos que agrandando este número.
  const MAX_ROUNDS = 3;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await axios.post(
      url,
      {
        model, messages: convo, temperature: 0.5, tools: TOOL_DEFS, tool_choice: 'auto',
        // NO mandar reasoning:{enabled:false} acá — probado en vivo (31/07/2026) y rompe el
        // endpoint de gpt-oss en OpenRouter por completo ("Reasoning is mandatory for this
        // endpoint and cannot be disabled"), tira abajo el modelo principal Y el fallback -20b,
        // y cae en cascada hasta Nemotron nano (free) — que no llama herramientas de forma
        // confiable e inventa en texto acciones que nunca ejecutó. La mitigación real del leak de
        // razonamiento (ver handoff 30/07/2026) queda solo en stripLeakedReasoningPreamble() más
        // abajo — defensivo, no cambia el request.
      },
      { headers, timeout: 30000 }
    );
    const msg = response.data.choices[0].message;

    if (!msg.tool_calls || !msg.tool_calls.length) {
      console.log(`[chatWithTools] ${providerLabel}/${model} ronda ${round + 1}/${MAX_ROUNDS}: respuesta final sin tool_calls.`);
      // Red de seguridad de código (no solo prompt): encontrado en vivo (28/07/2026) que incluso
      // el modelo default a veces, sin llamar ninguna herramienta, escribe en texto libre una
      // "confirmación" con ✅/❌ que no es un botón real — pasó con papelera en lote y con un plan
      // inventado de "borro y creo de nuevo" un evento. No confiamos en que el modelo se autocorrija:
      // si el texto tiene la firma de una confirmación de acción falsa, se bloquea acá mismo.
      if (looksLikeFakeActionConfirmation(msg.content) || looksLikeFakeCompletedGatedAction(msg.content)) {
        console.log(`[chatWithTools] ${providerLabel}/${model} ronda ${round + 1}/${MAX_ROUNDS}: respuesta bloqueada por firma de confirmación/acción falsa: ${JSON.stringify(msg.content?.slice(0, 200))}`);
        return 'No pude armar esa acción de forma segura. Pedímelo de nuevo mencionando una sola acción concreta por vez (ej. "mové a la papelera el mail con id X", o "editá el evento con id Y") y debería funcionar.';
      }
      // Firma 3 (31/07/2026): acción libre de Tasks declarada como hecha sin haber llamado a la
      // herramienta en ningún punto de este intercambio — ver looksLikeFakeCompletedTasksAction.
      if (looksLikeFakeCompletedTasksAction(msg.content, calledTools)) {
        console.log(`[chatWithTools] ${providerLabel}/${model} ronda ${round + 1}/${MAX_ROUNDS}: respuesta bloqueada por firma de acción de Tasks inventada (sin tool_calls reales en el intercambio): ${JSON.stringify(msg.content?.slice(0, 200))}`);
        return 'No pude confirmar esa acción de Tasks de forma segura. Pedímelo de nuevo mencionando una sola acción concreta por vez y debería funcionar.';
      }
      // Firma 4 (31/07/2026): chequeo por título exacto, más fino que la Firma 3 — con MÁS de un
      // ítem en el pedido, alcanza con que UNO sea real para que el resto se cuele inventado en el
      // mismo mensaje (visto en vivo: "ventiladores tres" real + "comer perro" inventada juntas).
      if (looksLikeFakeCreatedTaskTitle(msg.content, actionedTitles)) {
        console.log(`[chatWithTools] ${providerLabel}/${model} ronda ${round + 1}/${MAX_ROUNDS}: respuesta bloqueada por firma de título de tarea inventado (no coincide con ninguna llamada real): ${JSON.stringify(msg.content?.slice(0, 200))}`);
        return 'No pude confirmar todos los ítems de forma segura. Pedímelo de nuevo mencionando uno por uno y debería funcionar.';
      }
      // Firma 5 (ítem 113): narrativa de vencimiento OAuth inventada (ver looksLikeFakeOAuthExpiryNarrative).
      if (looksLikeFakeOAuthExpiryNarrative(msg.content)) {
        console.log(`[chatWithTools] ${providerLabel}/${model} ronda ${round + 1}/${MAX_ROUNDS}: respuesta bloqueada por firma de vencimiento OAuth inventado (googleOAuthExpired=false): ${JSON.stringify(msg.content?.slice(0, 200))}`);
        return 'Hubo un problema ejecutando esa acción, pero no fue un token vencido (el token está OK). Pedímelo de nuevo — si vuelve a fallar, avisame el error real en vez de que yo invente una causa.';
      }
      // Firma 6 (05/08/2026): tabla/lista de resultados de una herramienta de LECTURA (Tasks/Mail/
      // Calendar) sin haberla llamado en este intercambio NI aparecer en el historial real de la
      // conversación (ver looksLikeFakeReadResult) — distingue reuso legítimo de datos reales vistos
      // antes en esta misma conversación de invención pura.
      if (looksLikeFakeReadResult(msg.content, calledTools, messages)) {
        console.log(`[chatWithTools] ${providerLabel}/${model} ronda ${round + 1}/${MAX_ROUNDS}: respuesta bloqueada por firma de resultado de lectura inventado (sin tool-call real ni respaldo en el historial): ${JSON.stringify(msg.content?.slice(0, 200))}`);
        return 'No pude confirmar esos datos de forma segura — no llegué a consultarlos de nuevo. Pedímelo otra vez y me fijo con una búsqueda real antes de responder.';
      }
      const cleanContent = stripLeakedReasoningPreamble(msg.content);
      if (cleanContent !== msg.content) {
        console.log(`[chatWithTools] ${providerLabel}/${model} ronda ${round + 1}/${MAX_ROUNDS}: preámbulo de razonamiento filtrado cortado: ${JSON.stringify(msg.content?.slice(0, 200))}`);
      }
      return cleanContent;
    }

    lastToolNames = msg.tool_calls.map(tc => `${tc.function.name}(${tc.function.arguments})`);
    console.log(`[chatWithTools] ${providerLabel}/${model} ronda ${round + 1}/${MAX_ROUNDS}: pidió ${lastToolNames.join(', ')}`);

    if (onToolNotice) await onToolNotice(msg.tool_calls);

    convo.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls });
    for (const tc of msg.tool_calls) {
      calledTools.add(tc.function.name);
      if (tc.function.name === 'crear_tarea' || tc.function.name === 'editar_tarea') {
        try {
          const parsedArgs = JSON.parse(tc.function.arguments || '{}');
          if (parsedArgs.title) actionedTitles.add(String(parsedArgs.title));
        } catch { /* si el JSON de argumentos vino roto, executeToolCall ya lo va a reportar aparte */ }
      }
      const result = await executeToolCall(tc, ctx);
      const resultStr = String(result);
      console.log(`[chatWithTools] ${providerLabel}/${model} ronda ${round + 1}/${MAX_ROUNDS}: resultado de ${tc.function.name} (${resultStr.length} chars): ${resultStr.slice(0, 300)}`);
      convo.push({ role: 'tool', tool_call_id: tc.id, content: resultStr.slice(0, 4000) });
    }
    // Corte duro (no depende del modelo, ver comentario en askConfirmation): si esta ronda dejó
    // una confirmación pendiente, no seguimos pidiéndole al modelo una respuesta final — evita
    // que invente que la acción ya se ejecutó cuando en realidad está esperando el botón.
    if (ctx?.__awaitingConfirmation) {
      ctx.__awaitingConfirmation = false;
      return GATED_NO_REPLY; // sentinel, no null: null ya significa "timeout" en callAIWithTimeout
    }
  }

  // Ítem 114 (05/08/2026): ronda de cierre reservada, FUERA del presupuesto de MAX_ROUNDS. Bug
  // real: la ronda que solo redacta la respuesta final competía por el mismo cupo que las rondas
  // de herramientas — un pedido legítimo que necesitara las 3 rondas de datos (ej. "listame mis
  // tareas pendientes" buscando en varias listas, ver tasksSearch más arriba) se quedaba sin
  // ninguna ronda para escribir la respuesta, aunque los datos ya estuvieran en convo. Esta ronda
  // pide tool_choice:'none' — el modelo NO puede volver a llamar herramientas, así que no reabre
  // el riesgo de duplicados del incidente del 31/07/2026 (ese fue por MÁS llamadas reales a
  // Google, no por generar texto de cierre). closingMs queda en el log para confirmar en vivo que
  // esta ronda extra no reintroduce el riesgo de pisar el timeout general de 40s (AI_TIMEOUT_MS).
  console.log(`[chatWithTools] ${providerLabel}/${model}: se agotaron las ${MAX_ROUNDS} rondas de herramientas, pidiendo ronda de cierre (sin tools).`);
  // Bug real visto en vivo (05/08/2026, revisión 00047-7qj): la ronda de cierre a veces vuelve con
  // `content` vacío (27.6s, sin ningún error) o tarda mucho (41.8s) — mismo fenómeno documentado en
  // el health check de arranque (gpt-oss a veces se come el budget en razonamiento oculto). Causa
  // real identificada por código (no supuesta): esta ronda seguía mandando las 23 definiciones de
  // TOOL_DEFS completas (~19KB / ~5000 tokens) con `tool_choice:'none'` — el modelo no puede
  // llamarlas, pero igual las procesa en el contexto para "decidir" no usarlas, gastando presupuesto
  // de razonamiento en peso muerto. Fix: la ronda de cierre ahora NO manda `tools` en absoluto (sin
  // funciones disponibles, no hace falta `tool_choice` tampoco) — mismo efecto de "no puede volver a
  // llamar herramientas" que antes, con un prompt bastante más liviano.
  //
  // Además, cuando vuelve vacía, reintenta UNA vez más antes de rendirse — no agrega llamadas reales
  // a Google, solo un segundo intento de redactar con los mismos datos ya juntados en `convo`.
  const MAX_CLOSING_ATTEMPTS = 2;
  try {
    for (let attempt = 1; attempt <= MAX_CLOSING_ATTEMPTS; attempt++) {
      const closingStart = Date.now();
      const closingResponse = await axios.post(
        url,
        { model, messages: convo, temperature: 0.5 },
        { headers, timeout: 30000 }
      );
      const closingMs = Date.now() - closingStart;
      const closingMsg = closingResponse.data.choices[0].message;
      console.log(`[chatWithTools] ${providerLabel}/${model}: ronda de cierre (intento ${attempt}/${MAX_CLOSING_ATTEMPTS}) tardó ${closingMs}ms.`);

      if (!closingMsg.content) {
        console.log(`[chatWithTools] ${providerLabel}/${model}: ronda de cierre (intento ${attempt}/${MAX_CLOSING_ATTEMPTS}) volvió sin contenido.`);
        continue; // reintenta si queda otro intento; si no, cae al mensaje genérico después del for
      }

      // Mismas firmas anti-invención que arriba — una ronda sin tool_calls sigue siendo texto libre
      // del modelo, así que puede colar la misma narrativa falsa que en una ronda normal.
      if (looksLikeFakeActionConfirmation(closingMsg.content) || looksLikeFakeCompletedGatedAction(closingMsg.content)) {
        console.log(`[chatWithTools] ${providerLabel}/${model}: cierre bloqueado por firma de confirmación/acción falsa: ${JSON.stringify(closingMsg.content?.slice(0, 200))}`);
        return 'No pude armar esa acción de forma segura. Pedímelo de nuevo mencionando una sola acción concreta por vez (ej. "mové a la papelera el mail con id X", o "editá el evento con id Y") y debería funcionar.';
      }
      if (looksLikeFakeCompletedTasksAction(closingMsg.content, calledTools)) {
        console.log(`[chatWithTools] ${providerLabel}/${model}: cierre bloqueado por firma de acción de Tasks inventada: ${JSON.stringify(closingMsg.content?.slice(0, 200))}`);
        return 'No pude confirmar esa acción de Tasks de forma segura. Pedímelo de nuevo mencionando una sola acción concreta por vez y debería funcionar.';
      }
      if (looksLikeFakeCreatedTaskTitle(closingMsg.content, actionedTitles)) {
        console.log(`[chatWithTools] ${providerLabel}/${model}: cierre bloqueado por firma de título de tarea inventado: ${JSON.stringify(closingMsg.content?.slice(0, 200))}`);
        return 'No pude confirmar todos los ítems de forma segura. Pedímelo de nuevo mencionando uno por uno y debería funcionar.';
      }
      if (looksLikeFakeOAuthExpiryNarrative(closingMsg.content)) {
        console.log(`[chatWithTools] ${providerLabel}/${model}: cierre bloqueado por firma de vencimiento OAuth inventado: ${JSON.stringify(closingMsg.content?.slice(0, 200))}`);
        return 'Hubo un problema ejecutando esa acción, pero no fue un token vencido (el token está OK). Pedímelo de nuevo — si vuelve a fallar, avisame el error real en vez de que yo invente una causa.';
      }
      if (looksLikeFakeReadResult(closingMsg.content, calledTools, messages)) {
        console.log(`[chatWithTools] ${providerLabel}/${model}: cierre bloqueado por firma de resultado de lectura inventado: ${JSON.stringify(closingMsg.content?.slice(0, 200))}`);
        return 'No pude confirmar esos datos de forma segura — no llegué a consultarlos de nuevo. Pedímelo otra vez y me fijo con una búsqueda real antes de responder.';
      }
      return stripLeakedReasoningPreamble(closingMsg.content);
    }
    console.log(`[chatWithTools] ${providerLabel}/${model}: ronda de cierre volvió sin contenido en los ${MAX_CLOSING_ATTEMPTS} intentos. Último intento de herramienta: ${lastToolNames.join(', ') || 'ninguno'}`);
    return 'No pude completar la respuesta tras varias búsquedas. Probá reformular la pregunta.';
  } catch (error) {
    console.error(`[chatWithTools] ${providerLabel}/${model}: error en la ronda de cierre:`, error.response?.data || error.message);
    console.log(`[chatWithTools] ${providerLabel}/${model}: se quedó sin rondas (incluida la de cierre). Último intento: ${lastToolNames.join(', ') || 'ninguno'}`);
    return 'No pude completar la respuesta tras varias búsquedas. Probá reformular la pregunta.';
  }
}

// Guarda en Firestore el detalle de qué proveedor/modelo falló y por qué, para diagnosticar sin adivinar
async function logAIFailure(userId, attempts) {
  try {
    await db.collection('ai_errors').add({ userId: String(userId || 'unknown'), attempts, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('Error guardando log de fallos de IA:', error.message);
  }
}

// Clasifica el motivo de una falla de IA para que quede diferenciado en ai_errors sin tener que leer la consola.
// "modelo_retirado" cubre tanto el 404 típico de un modelo que el proveedor sacó del catálogo como el mensaje
// "does not exist" que devuelve Groq cuando el modelo pedido pertenece a otro proveedor.
function classifyAIError(error) {
  const status = error.response?.status;
  const message = error.response?.data?.error?.message || error.message || '';
  if (status === 404 || /does not exist|not found|deprecated|no longer available/i.test(message)) return 'modelo_retirado';
  if (status === 401 || status === 403) return 'auth_invalida';
  if (status === 429) return 'rate_limit';
  if (status === 400) return 'request_invalida';
  return 'error_desconocido';
}

// Clasifica el motivo de un cambio de modelo (fallback) para el texto de la alerta de Telegram —
// taxonomía propia, distinta de classifyAIError() (esa alimenta ai_errors con otras categorías).
function classifyFallbackAlertReason(error, detail) {
  const status = error.response?.status;
  const message = `${detail || ''} ${error.response?.data?.error?.message || error.message || ''}`.toLowerCase();
  if (status === 429 || /requires more credits|rate.?limit/.test(message)) return 'credito_agotado';
  if ((status && status >= 500) || /provider returned error|timeout|timed out|bad gateway|service unavailable/.test(message)) return 'proveedor_fallando';
  return 'otro';
}

const MODEL_FALLBACK_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

// Antispam en Firestore, no en memoria: mismo motivo que pendingOAuthState (ver sesión del
// 16/08/2026) — Cloud Run puede reiniciar la instancia entre dos fallbacks reales (maxScale=1,
// sin minScale, escala a cero por inactividad), y un contador en memoria perdería la cuenta del
// último aviso en cada arranque nuevo, mandando alertas de más. Máximo 1 alerta cada 30 min por
// par modelo-viejo→modelo-nuevo. Best-effort: un fallo acá nunca debe romper la respuesta normal
// al usuario, solo logueado.
async function notifyModelFallback(modeloViejo, modeloNuevo, error, detail) {
  try {
    const docId = `${modeloViejo}__${modeloNuevo}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const ref = db.collection('model_fallback_alerts').doc(docId);
    const snap = await ref.get();
    const now = Date.now();
    const last = snap.exists ? snap.data().timestamp : 0;
    if (now - last < MODEL_FALLBACK_ALERT_COOLDOWN_MS) return;

    const reason = classifyFallbackAlertReason(error, detail);
    let texto;
    if (reason === 'credito_agotado') {
      texto = `⚠️ Cambio de modelo a ${modeloNuevo} — ${modeloViejo} se quedó sin crédito/cupo disponible.`;
    } else if (reason === 'proveedor_fallando') {
      texto = `⚠️ Cambio de modelo a ${modeloNuevo} — ${modeloViejo} está fallando (error del proveedor).`;
    } else {
      texto = `⚠️ Cambio de modelo a ${modeloNuevo} — ${modeloViejo} falló: ${escapeHtml(detail || 'motivo no clasificable')}.`;
    }

    await ref.set({ timestamp: now }, { merge: true });
    await bot.telegram.sendMessage(process.env.TELEGRAM_ALLOWED_USER_ID, texto, { parse_mode: 'HTML' });
  } catch (err) {
    console.error('Error mandando alerta de cambio de modelo (best-effort, no rompe la respuesta):', err.message);
  }
}

async function callAI(messages, config, onToolNotice, userId, ctx) {
  const headers = { 'Content-Type': 'application/json' };
  // Groq retirado de la cadena de chat: se da de baja el 16/08/2026 (auditoría Fable, ítem 73).
  // OpenRouter queda como único proveedor de chat. La transcripción de audio (Whisper, en
  // transcribeAudio()) sigue usando Groq aparte — eso es un reemplazo distinto, todavía en investigación.
  let provider = 'openrouter';
  let model = config?.model || MODELS_BY_PROVIDER.openrouter.default;
  const clean = cleanMessages(messages);
  const attempts = [];

  // Chequeo de sanidad: si el modelo guardado quedó inválido (retirado/inexistente en el catálogo),
  // resetear al default ANTES de llamar a la API, en vez de intentar con datos que sabemos que van a
  // fallar. Se persiste para que la próxima consulta ya arranque con una config sana.
  if (!isValidModelForProvider(provider, model)) {
    model = MODELS_BY_PROVIDER.openrouter.default;
    if (userId) saveConfig(userId, { provider, model }).catch(() => {});
  }

  // Guarda el último fallo (modelo + error crudo) fuera de `attempts` a propósito: `attempts` se
  // persiste tal cual en Firestore vía logAIFailure(), y el objeto Error de axios tiene refs
  // circulares que romperían ese write.
  let lastFailure = null;

  if (process.env.OPENROUTER_API_KEY) {
    try {
      return await chatWithTools('https://openrouter.ai/api/v1/chat/completions', process.env.OPENROUTER_API_KEY, model, clean, onToolNotice, ctx);
    } catch (error) {
      const detail = error.response?.data?.error?.message || error.message;
      console.error('Error OpenRouter:', detail);
      attempts.push({ provider: 'openrouter', model, error: detail, reason: classifyAIError(error) });
      lastFailure = { model, error, detail };
    }
  }

  const alreadyTried = (p, m) => attempts.some(a => a.provider === p && a.model === m) || (provider === p && model === m);

  // 2do intento de la cadena 100% gratuita (ver MODELS_BY_PROVIDER, reemplazo del 29/08/2026).
  if (process.env.OPENROUTER_API_KEY && !alreadyTried('openrouter', 'nvidia/nemotron-3-ultra-550b-a55b:free')) {
    if (lastFailure) await notifyModelFallback(lastFailure.model, 'nvidia/nemotron-3-ultra-550b-a55b:free', lastFailure.error, lastFailure.detail);
    try {
      return await chatWithTools('https://openrouter.ai/api/v1/chat/completions', process.env.OPENROUTER_API_KEY, 'nvidia/nemotron-3-ultra-550b-a55b:free', clean, onToolNotice, ctx);
    } catch (error) {
      const detail = error.response?.data?.error?.message || error.message;
      console.error('Error fallback Nemotron-3-ultra:', detail);
      attempts.push({ provider: 'openrouter', model: 'nvidia/nemotron-3-ultra-550b-a55b:free', error: detail, reason: classifyAIError(error) });
      lastFailure = { model: 'nvidia/nemotron-3-ultra-550b-a55b:free', error, detail };
    }
  }

  // 3er intento de la cadena 100% gratuita.
  if (process.env.OPENROUTER_API_KEY && !alreadyTried('openrouter', 'minimax/minimax-m3:free')) {
    if (lastFailure) await notifyModelFallback(lastFailure.model, 'minimax/minimax-m3:free', lastFailure.error, lastFailure.detail);
    try {
      return await chatWithTools('https://openrouter.ai/api/v1/chat/completions', process.env.OPENROUTER_API_KEY, 'minimax/minimax-m3:free', clean, onToolNotice, ctx);
    } catch (error) {
      const detail = error.response?.data?.error?.message || error.message;
      console.error('Error fallback Minimax-M3:', detail);
      attempts.push({ provider: 'openrouter', model: 'minimax/minimax-m3:free', error: detail, reason: classifyAIError(error) });
      lastFailure = { model: 'minimax/minimax-m3:free', error, detail };
    }
  }

  // Último recurso: router automático de OpenRouter (openrouter/free) — selecciona entre los
  // modelos gratis disponibles en ese momento, red de seguridad final aunque los tres anteriores
  // dejen de estar disponibles.
  if (process.env.OPENROUTER_API_KEY && !alreadyTried('openrouter', 'openrouter/free')) {
    if (lastFailure) await notifyModelFallback(lastFailure.model, 'openrouter/free', lastFailure.error, lastFailure.detail);
    try {
      return await chatWithTools('https://openrouter.ai/api/v1/chat/completions', process.env.OPENROUTER_API_KEY, 'openrouter/free', clean, onToolNotice, ctx);
    } catch (error) {
      const detail = error.response?.data?.error?.message || error.message;
      console.error('Error fallback openrouter/free:', detail);
      attempts.push({ provider: 'openrouter', model: 'openrouter/free', error: detail, reason: classifyAIError(error) });
      lastFailure = { model: 'openrouter/free', error, detail };
    }
  }

  await logAIFailure(userId, attempts);
  return 'Lo siento, no hay servicios de IA disponibles en este momento.';
}

// ─────────────────────────────────────────
// TTS — SÍNTESIS DE VOZ (node-gtts / Google)
// ─────────────────────────────────────────
async function getTTSConfig(userId) {
  const doc = await db.collection('tts_config').doc(String(userId)).get();
  if (!doc.exists) return { lang: 'es', speed: 1.0 };
  return doc.data();
}

async function saveTTSConfig(userId, config) {
  await db.collection('tts_config').doc(String(userId)).set(config, { merge: true });
}

// Voces disponibles para Edge TTS
const TTS_VOICES = {
  'tomas':  { name: 'es-AR-TomasNeural',  label: '🇦🇷 Tomás (hombre, argentino)' },
  'elena':  { name: 'es-AR-ElenaNeural',   label: '🇦🇷 Elena (mujer, argentina)' },
  'alvaro': { name: 'es-ES-AlvaroNeural',  label: '🇪🇸 Álvaro (hombre, español)' },
  'maria':  { name: 'es-MX-DaliaNeural',   label: '🇲🇽 Dalia (mujer, mexicana)' },
  'brian':  { name: 'en-US-BrianNeural',   label: '🇺🇸 Brian (hombre, inglés)' },
  'jenny':  { name: 'en-US-JennyNeural',   label: '🇺🇸 Jenny (mujer, inglés)' },
};
const DEFAULT_VOICE = 'tomas';

async function textToSpeech(text, userId) {
  try {
    const ttsConfig = await getTTSConfig(userId);
    const voiceKey = ttsConfig.voice || DEFAULT_VOICE;
    const speed = ttsConfig.speed || 1.0;
    const voiceObj = TTS_VOICES[voiceKey] || TTS_VOICES[DEFAULT_VOICE];

    // Limpiar markdown para el audio
    const clean = text
      .replace(/[*_`#~]/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .slice(0, 3000);

    // Convertir speed (0.5–2.0) a porcentaje de Edge TTS (+/-%)
    const ratePercent = Math.round((speed - 1) * 100);
    const rate = ratePercent >= 0 ? `+${ratePercent}%` : `${ratePercent}%`;

    const audioPath = path.join(__dirname, `tts_${Date.now()}.mp3`);
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voiceObj.name, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(clean, { rate });
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(audioPath);
      audioStream.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
      audioStream.on('error', reject);
    });
    return audioPath;
  } catch (error) {
    console.error('Error TTS Edge:', error.message);
    return null;
  }
}

// ─────────────────────────────────────────
// TRANSCRIPCIÓN DE AUDIO
// ─────────────────────────────────────────
// Normaliza direcciones de email dictadas por voz: Whisper (STT) se come el "@" o lo transcribe
// como la palabra "arroba" suelta, o como un punto — bug real visto en vivo (29/07/2026):
// "oliveramoa@gmail.com" dictado salió como "oliveramoa.gmail.com" y como "oliveramoa.com" en
// intentos distintos, ni el prompt de biasing de Whisper alcanzó a corregirlo solo. Se corrige acá
// con reglas determinísticas, antes de que el texto llegue a la IA — no depende de que el modelo
// "adivine" la dirección correcta.
function normalizeSpokenEmail(text) {
  let out = text.replace(/\s+arroba\s+/gi, '@');
  // "nombre.gmail.com" o "nombre gmail com" (separador punto/espacio en vez de @) -> "nombre@gmail.com".
  // Un email ya bien transcripto ("nombre@gmail.com") no matchea esto porque el separador acá es
  // literalmente "@", no un punto ni un espacio.
  out = out.replace(
    /\b([a-z0-9._-]+)[.\s]+(gmail|hotmail|outlook|yahoo|icloud|live)[.\s]+com\b/gi,
    '$1@$2.com'
  );
  return out;
}

async function transcribeAudio(fileUrl) {
  try {
    console.log(`[transcribeAudio] descarga arranca: ${new Date().toISOString()}`);
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 15000 });
    console.log(`[transcribeAudio] descarga termina (${response.data.length} bytes): ${new Date().toISOString()}`);
    const tempPath = path.join(__dirname, `audio_${Date.now()}.ogg`);
    fs.writeFileSync(tempPath, response.data);
    const FormData = require('form-data');
    const formData = new FormData();
    formData.append('file', fs.createReadStream(tempPath));
    formData.append('model', 'whisper-large-v3');
    formData.append('language', 'es');
    // "Prompt" de Whisper: no es una instrucción, es texto de referencia que sesga el vocabulario
    // esperado — ayuda (no garantiza) a que reconozca "arroba" y direcciones de Gmail dictadas.
    formData.append('prompt', 'Dirección de correo con arroba, por ejemplo nombre arroba gmail punto com.');
    console.log(`[transcribeAudio] llamada a Whisper (Groq) arranca: ${new Date().toISOString()}`);
    const res = await axios.post(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      formData,
      {
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, ...formData.getHeaders() },
        timeout: 30000,
      }
    );
    console.log(`[transcribeAudio] llamada a Whisper (Groq) termina: ${new Date().toISOString()}`);
    fs.unlinkSync(tempPath);
    return normalizeSpokenEmail(res.data.text);
  } catch (error) {
    console.error('Error transcribiendo audio:', error.message);
    return null;
  }
}

// ─────────────────────────────────────────
// DOCUMENTOS: PDF / WORD (.docx) — descarga, extracción de texto, resumen
// ─────────────────────────────────────────
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024; // límite de descarga de la Bot API de Telegram
const SUPPORTED_DOCUMENT_EXT = ['.pdf', '.docx'];

function getDocumentExtension(fileName) {
  const match = /\.[^.]+$/.exec(fileName || '');
  return match ? match[0].toLowerCase() : '';
}

async function extractPdfText(buffer) {
  const pdfParse = require('pdf-parse');
  const data = await pdfParse(buffer);
  return data.text;
}

async function extractDocxText(buffer) {
  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

// ─────────────────────────────────────────
// CATÁLOGO DE PROVEEDORES/MODELOS (fuente de verdad para validación y mensajes al usuario)
// ─────────────────────────────────────────
// Catálogo verificado en vivo contra /v1/models de cada proveedor. Cadena reemplazada el
// 29/08/2026 (diagnóstico previo confirmó que openai/gpt-oss-120b, el default real, NO es
// :free — corre contra una cuota diaria chica que se agotó dos veces en 30 días sin avisar) por
// una cadena 100% de modelos gratuitos (`:free`), los 4 confirmados en vivo el 29/08/2026 con
// precio $0 y soporte de tools/tool_choice contra /api/v1/models. Los modelos gratis de
// OpenRouter rotan sin aviso, así que si vuelve a fallar todo, este es el primer lugar para
// re-chequear.
const MODELS_BY_PROVIDER = {
  openrouter: {
    default: 'z-ai/glm-5.2:free',
    models: {
      'z-ai/glm-5.2:free': 'Default — modelo principal, 100% gratuito, uso general',
      'nvidia/nemotron-3-ultra-550b-a55b:free': '2do intento si falla el principal — grande, razonamiento fuerte, 100% gratuito',
      'minimax/minimax-m3:free': '3er intento si fallan los dos anteriores — 100% gratuito',
      'openrouter/free': 'Último recurso — router automático de OpenRouter, selecciona entre los modelos gratis disponibles en ese momento como red de seguridad final',
    },
  },
};

function isValidModelForProvider(provider, model) {
  return !!MODELS_BY_PROVIDER[provider]?.models[model];
}

const PROVIDER_LABELS = { openrouter: 'OpenRouter' };

// buildModelCatalogText() usa backticks Markdown a propósito (se reutiliza también en el system
// prompt en texto plano, ahí no importa el formato) — acá, para el mensaje real de Telegram, se
// convierten a <code> HTML (ítem 112). El texto de origen es 100% estático (ids/descripciones
// hardcodeadas en MODELS_BY_PROVIDER, no hay input de usuario), así que no hace falta escapeHtml.
function formatModelCatalog() {
  const htmlCatalog = buildModelCatalogText().replace(/`([^`]+)`/g, '<code>$1</code>');
  return `⚠️ Esa combinación no es válida.\nProveedores y modelos disponibles:\n\n${htmlCatalog}`;
}

// Texto plano del catálogo, reutilizado en el mensaje de error y en el system prompt (para que el modelo pueda recomendar el más adecuado según la tarea)
function buildModelCatalogText() {
  let out = '';
  for (const [provider, info] of Object.entries(MODELS_BY_PROVIDER)) {
    out += `• ${PROVIDER_LABELS[provider]}\n`;
    for (const [model, desc] of Object.entries(info.models)) {
      out += `  - \`${model}\` — ${desc}\n`;
    }
  }
  return out.trim();
}

// System prompt completo: base + catálogo de modelos + recordatorio operativo de tool-calling.
// El recordatorio se agrega acá (no en el .md versionado) porque nace de un bug real encontrado
// en la verificación de H1 (28/07/2026): el modelo, imitando turnos viejos guardados en su
// historial de Firestore (de antes de existir el gate en código), a veces escribe en texto libre
// una confirmación con botones falsos en vez de llamar a la herramienta real — el usuario ve
// "botones" que en realidad son texto sin clickear, sin ninguna acción real detrás.
const SYSTEM_PROMPT_STATIC = `${SYSTEM_PROMPT}

CATÁLOGO DE MODELOS DISPONIBLES (si te preguntan qué modelo conviene para una tarea, respondé con criterio usando esta info):
${buildModelCatalogText()}

REGLA OPERATIVA DURA (no negociable, aplica siempre): para redactar/enviar mails, mover mails a la papelera, crear/editar/borrar eventos de Calendar, o crear/editar/mover/marcar/descompletar/borrar tareas y listas de Tasks, SIEMPRE llamá a la herramienta correspondiente (redactar_enviar_mail, mover_mail_papelera, crear_evento_calendar, editar_evento_calendar, borrar_evento_calendar, crear_tarea, editar_tarea, mover_tarea, marcar_tarea_completa, descompletar_tarea, borrar_tarea, listar_listas_tareas, crear_lista_tareas, editar_lista_tareas, borrar_lista_tareas). NUNCA describas en texto libre una confirmación, una vista previa con botones, o un resultado de esas acciones — los botones reales y la ejecución real los maneja el código, no vos. Si en tu historial de conversación ves turnos anteriores donde "vos" escribiste una confirmación en texto en vez de usar la herramienta, es un error viejo — no lo repitas ni lo imites. Si te piden algo que ninguna herramienta puede hacer de verdad (ej. un recordatorio con hora en Tasks, o un color/etiqueta de evento), decilo explícitamente — nunca inventes un plan alternativo (como "borro y creo de nuevo") ni un resultado falso narrado en texto: si existe una herramienta para lo que hace falta (ej. editar_evento_calendar, editar_tarea, editar_lista_tareas), usala; si no existe, avisá la limitación real.

REGLA OPERATIVA DURA — editar/borrar eventos de Calendar (no negociable, aplica siempre): para editar_evento_calendar o borrar_evento_calendar NUNCA le pidas el eventId a Mariano — es información interna de Google Calendar, engorrosa de conseguir a mano y no es su trabajo dártela. Si no tenés ya el eventId (por ejemplo porque vos mismo creaste el evento en este mismo chat), llamá primero a buscar_eventos_calendar con el título y/o fecha que Mariano te dio. Si aparece un solo resultado, mostraselo (título + horario) y pedile que confirme que es ese evento antes de editarlo o borrarlo. Si aparecen varios, mostrale la lista para que elija. Recién con la confirmación de Mariano usás el eventId real para editar_evento_calendar o borrar_evento_calendar.

REGLA OPERATIVA DURA — marcar/descompletar/borrar tareas de Tasks, o borrar una lista (mismo criterio que Calendar, no negociable): para marcar_tarea_completa, descompletar_tarea, borrar_tarea o borrar_lista_tareas NUNCA le pidas el taskId/tasklistId a Mariano. Si no lo tenés ya, llamá primero a buscar_tareas (con incluirCompletadas:true si estás buscando una tarea ya completada para descompletar_tarea) o a listar_listas_tareas, y confirmá con él cuál es antes de actuar. Si aparece una sola coincidencia, confirmala; si aparecen varias, mostrale la lista para que elija. Recién con su confirmación usás el taskId/tasklistId real. Tené en cuenta que a diferencia de Calendar (papelera web) o Gmail (Papelera), borrar_tarea y borrar_lista_tareas NO tienen forma de recuperar lo borrado — por eso gatean con confirmación por botones igual que borrar_evento_calendar, mientras que marcar_tarea_completa y descompletar_tarea (reversibles entre sí) no gatean.

REGLA OPERATIVA DURA — no confundir redactar_enviar_mail con mover_mail_papelera (bug real visto en vivo 29/07/2026): son operaciones OPUESTAS y no relacionadas — redactar_enviar_mail crea y manda un mail NUEVO que Mariano está dictando/escribiendo ahora; mover_mail_papelera borra un mail YA EXISTENTE en la bandeja de entrada. Si Mariano te pide "enviá un mail", "mandale un mail a X", o te dicta destinatario/asunto/cuerpo, es SIEMPRE redactar_enviar_mail — nunca mover_mail_papelera, aunque la dirección de destino te llegue con formato raro (típico de audio transcripto, ej. "nombre.com" en vez de "nombre@gmail.com"). Si la dirección no tiene forma de email válida, la herramienta te va a avisar — en ese caso preguntale a Mariano la dirección exacta en vez de inventar una acción distinta.`;

// ítem 151 (29/08/2026): lee de Firestore (`bot_rules`) solo las reglas con activa:true, las
// agrupa por categoría y arma el bloque a inyectar en el system prompt. Se recalcula en cada
// turno (mismo motivo que la fecha/hora de abajo) para que una regla nueva quede activa desde el
// mensaje siguiente sin reiniciar nada. Si no hay ninguna regla activa, devuelve '' — el header no
// se manda vacío nunca.
async function buildUserRulesBlock() {
  const snap = await db.collection('bot_rules').where('activa', '==', true).get();
  if (snap.empty) return '';
  const porCategoria = {};
  snap.forEach((doc) => {
    const d = doc.data();
    (porCategoria[d.categoria] ||= []).push(d.texto);
  });
  const lineas = Object.entries(porCategoria)
    .filter(([, items]) => items.length)
    .map(([categoria, items]) => items.map((t) => `[${categoria}] ${t}`).join('\n'))
    .join('\n');
  if (!lineas) return '';
  return `REGLAS PERSONALES DE MARIANO (agregadas por él mismo — respetalas\nsiempre, salvo que entren en conflicto directo con una REGLA\nOPERATIVA DURA de arriba, en cuyo caso la dura gana):\n${lineas}`;
}

// Se recalcula en cada turno (no es una constante fija) porque el contenedor de Cloud Run puede
// quedar levantado horas o reiniciarse a mitad de la noche — si la fecha/hora quedara fija al
// arrancar el proceso, el modelo calculaba mal "hoy"/"mañana" (bug real detectado 28/07/2026:
// pedido a la noche del 27/07 para "mañana" resultó en un evento creado el 29/07 en vez del 28/07).
// ítem 151: ahora es async porque también lee las reglas personales activas de Firestore en cada
// turno — todos los call sites deben usar `await buildSystemPromptFull()`.
async function buildSystemPromptFull() {
  const reglasBlock = await buildUserRulesBlock();
  return `${SYSTEM_PROMPT_STATIC}

FECHA Y HORA ACTUAL EN ARGENTINA (usá esto como referencia exacta para calcular "hoy", "mañana", "el lunes que viene", etc. — nunca la infieras de otra forma): ${getArgentinaDateTime()}.${reglasBlock ? `\n\n${reglasBlock}` : ''}`;
}

// ─────────────────────────────────────────
// PARSEO DE COMANDOS DE CONFIGURACIÓN
// ─────────────────────────────────────────
function parseConfigCommand(text) {
  const t = text.toLowerCase();
  // Groq retirado como proveedor de chat (ver MODELS_BY_PROVIDER) — se deja reconocer 'groq' a
  // propósito para que isValidModelForProvider() lo rechace explícitamente con el catálogo, en vez
  // de caer en un no-op silencioso que reporte "✅ actualizada" sin haber cambiado nada.
  let provider = t.includes('groq') ? 'groq' : (t.includes('openrouter') ? 'openrouter' : null);

  const models = {
    'glm': 'z-ai/glm-5.2:free',
    'nemotron': 'nvidia/nemotron-3-ultra-550b-a55b:free',
    'minimax': 'minimax/minimax-m3:free',
    'auto': 'openrouter/free',
  };

  let model = null;
  for (const [key, val] of Object.entries(models)) {
    if (t.includes(key)) { model = val; break; }
  }

  return { provider, model };
}

// Detecta pedidos de cambio de voz/velocidad en lenguaje natural (texto o audio transcripto)
function parseVoiceCommand(text) {
  const t = text.toLowerCase();
  const isVoiceRequest = /\b(cambi\w*|pon\w*|us\w*|quier\w*)\b.*\b(voz|velocidad)\b/.test(t) ||
    /\bvoz\s+(femenina|masculina|de\s+(hombre|mujer))\b/.test(t) ||
    /\bm[aá]s\s+(r[aá]pido|lent[oa])\b/.test(t);

  if (!isVoiceRequest) return null;

  let voice = null;
  let speed = null;

  if (/femenina|de\s+mujer|mujer/.test(t)) voice = 'elena';
  else if (/masculina|de\s+hombre|hombre/.test(t)) voice = 'tomas';
  else {
    for (const key of Object.keys(TTS_VOICES)) {
      if (t.includes(key)) { voice = key; break; }
    }
  }

  const speedMatch = t.match(/(\d+(?:[.,]\d+)?)\s*(?:x|veces)/);
  if (speedMatch) {
    speed = parseFloat(speedMatch[1].replace(',', '.'));
  } else if (/m[aá]s\s+r[aá]pido/.test(t)) {
    speed = 1.3;
  } else if (/m[aá]s\s+lent[oa]/.test(t)) {
    speed = 0.8;
  }

  if (!voice && !speed) return null;
  return { voice, speed };
}

// ─────────────────────────────────────────
// CAPTURA DE IDEAS DESDE CONVERSACIÓN NATURAL (con confirmación previa — nunca se guarda directo)
// ─────────────────────────────────────────
const IDEA_KEYWORDS = ['se me ocurre', 'podría ser una idea', 'podria ser una idea', 'sería una idea', 'seria una idea',
  'para el ecosistema', 'para metatrón', 'para metatron', 'buena idea para', 'tengo una idea'];

function isPossibleIdea(text) {
  const t = text.toLowerCase();
  return IDEA_KEYWORDS.some(k => t.includes(k));
}

function isAffirmative(text) {
  // (?=\s|$|[,.!¿¡?]) en vez de \b: \b no detecta límite de palabra después de una vocal acentuada (sí, dale) en JS
  return /^\s*(s[ií]|dale|obvio|claro|okay?|de\s+una)(?=\s|$|[,.!¿¡?])/i.test(text.trim());
}

// Guarda, por usuario, la idea detectada mientras se espera su confirmación (sí/no). En memoria: es efímero, no necesita Firestore.
const pendingIdeas = new Map();

// ─────────────────────────────────────────
// COMANDOS
// ─────────────────────────────────────────
bot.start(async (ctx) => {
  const config = await getConfig(ctx.from.id);
  await ctx.reply(
    `¡Hola Mariano! Soy OpenGravity 🚀\n\n` +
    `Configuración actual:\n` +
    `• Provider: <b>${escapeHtml(config.provider)}</b>\n` +
    `• Modelo: <b>${escapeHtml(config.model)}</b>\n\n` +
    `Comandos:\n` +
    `/config — ver configuración\n` +
    `/voz — cambiar voz (tomas/elena/alvaro/brian...)\n` +
    `/velocidad — cambiar velocidad (0.5 a 2.0)\n` +
    `/idea [texto] — guardar idea\n` +
    `/ideas — ver tus ideas\n` +
    `/buscar [query] — buscar en la web\n` +
    `/clear — borrar historial\n\n` +
    `O decime en lenguaje natural:\n` +
    `<i>"Cambiá al modelo minimax"</i>`,
    { parse_mode: 'HTML' }
  );
});

bot.command('config', async (ctx) => {
  const config = await getConfig(ctx.from.id);
  await ctx.reply(
    `⚙️ <b>Configuración actual:</b>\n\n` +
    `• Provider: <code>${escapeHtml(config.provider)}</code>\n` +
    `• Modelo: <code>${escapeHtml(config.model)}</code>\n\n` +
    `Para cambiar decime:\n<i>"Cambiá a OpenRouter con nemotron"</i>`,
    { parse_mode: 'HTML' }
  );
});

bot.command('clear', async (ctx) => {
  await clearHistory(ctx.from.id);
  await ctx.reply('✅ Historial borrado.');
});

bot.command('voz', async (ctx) => {
  const arg = ctx.message.text.replace('/voz', '').trim().toLowerCase();
  const cfg = await getTTSConfig(ctx.from.id);
  const currentVoice = cfg.voice || DEFAULT_VOICE;
  if (!arg) {
    const opciones = Object.entries(TTS_VOICES).map(([k, v]) => `<code>${escapeHtml(k)}</code> — ${escapeHtml(v.label)}`).join('\n');
    return ctx.reply(
      `🎙️ <b>Configuración de voz actual:</b>\n• Voz: <code>${escapeHtml(currentVoice)}</code> — ${escapeHtml(TTS_VOICES[currentVoice]?.label)}\n\n` +
      `<b>Voces disponibles:</b>\n${opciones}\n\n` +
      `Uso: <code>/voz tomas</code> (hombre argentino) o <code>/voz elena</code> (mujer argentina)`,
      { parse_mode: 'HTML' }
    );
  }
  if (!TTS_VOICES[arg]) return ctx.reply(`Voz no válida. Opciones: ${Object.keys(TTS_VOICES).join(', ')}`);
  await saveTTSConfig(ctx.from.id, { voice: arg });
  await ctx.reply(`✅ Voz cambiada a <code>${escapeHtml(arg)}</code> — ${escapeHtml(TTS_VOICES[arg].label)}`, { parse_mode: 'HTML' });
});

bot.command('velocidad', async (ctx) => {
  const arg = parseFloat(ctx.message.text.replace('/velocidad', '').trim());
  const cfg = await getTTSConfig(ctx.from.id);
  if (isNaN(arg) || arg < 0.5 || arg > 2.0) {
    return ctx.reply(
      `⚡ <b>Velocidad actual:</b> <code>${cfg.speed || 1.0}x</code>\n\nUsá un valor entre <code>0.5</code> y <code>2.0</code>\nEjemplo: <code>/velocidad 1.2</code>`,
      { parse_mode: 'HTML' }
    );
  }
  await saveTTSConfig(ctx.from.id, { speed: arg });
  await ctx.reply(`✅ Velocidad cambiada a <code>${arg}x</code>`, { parse_mode: 'HTML' });
});

bot.command('idea', async (ctx) => {
  const text = ctx.message.text.replace('/idea', '').trim();
  if (!text) return ctx.reply('Escribí la idea después del comando:\n<code>/idea [tu idea]</code>', { parse_mode: 'HTML' });
  const id = await saveIdea(ctx.from.id, text);
  await ctx.reply(`💡 Idea guardada (ID: ${escapeHtml(id)})\n\n"${escapeHtml(text)}"`, { parse_mode: 'HTML' });
});

bot.command('ideas', async (ctx) => {
  const ideas = await getIdeas(ctx.from.id);
  if (!ideas.length) return ctx.reply('No tenés ideas guardadas todavía.');
  const lista = ideas.slice(-10)
    .map((i, idx) => `${idx + 1}. ${escapeHtml(i.text)}\n   📅 ${new Date(i.date).toLocaleDateString('es-AR')}`)
    .join('\n\n');
  await ctx.reply(`💡 <b>Tus últimas ideas:</b>\n\n${lista}`, { parse_mode: 'HTML' });
});

bot.command('buscar', async (ctx) => {
  const query = ctx.message.text.replace('/buscar', '').trim();
  if (!query) return ctx.reply('Escribí qué querés buscar:\n<code>/buscar [consulta]</code>', { parse_mode: 'HTML' });
  await ctx.sendChatAction('typing');
  await ctx.reply(`🔍 Buscando: "${query}"...`);
  let results;
  try {
    results = await searchWeb(query);
  } catch (error) {
    return ctx.reply('No pude acceder a la búsqueda web en este momento.');
  }
  if (!results) return ctx.reply('No encontré resultados.');
  const config = await getConfig(ctx.from.id);
  const history = await getHistory(ctx.from.id);
  const messages = [
    { role: 'system', content: await buildSystemPromptFull() },
    ...history,
    { role: 'user', content: `${query}\n\nResultados web:\n${results}` },
  ];
  const aiReply = await callAIWithTimeout(messages, config, null, ctx.from.id, ctx);
  if (aiReply === GATED_NO_REPLY) return; // ya se mandó la UI de confirmación, no hay nada más que responder
  await saveMessage(ctx.from.id, 'user', `/buscar ${query}`);
  await saveMessage(ctx.from.id, 'assistant', aiReply);
  await replyWithAudio(ctx, aiReply);
});

// ─────────────────────────────────────────
// HELPER: enviar respuesta en texto + audio
// ─────────────────────────────────────────
// Cloud Run corta cada mensaje a los 90s (handlerTimeout de Telegraf) y sin bot.catch() eso
// tumba el proceso entero. El TTS (llamada de red a Microsoft Edge) puede colgarse sin arrojar
// error propio, así que lo acotamos acá para que, si tarda demasiado, se salte el audio en vez
// de crashear el handler completo.
const TTS_TIMEOUT_MS = 60000;
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

// Red de seguridad adicional: aunque bajamos las rondas de chatWithTools de 5 a 3, la cadena de
// fallback de callAI() sigue probando hasta 5 combinaciones proveedor/modelo en secuencia, y eso
// puede acumularse. Si supera este umbral, respondemos antes de que Telegraf mate el handler a los 90s.
// Se dejó margen real para lo que rodea a esta llamada dentro del mismo handler: descarga+transcripción
// de audio (hasta ~15-30s en el caso de mensajes de voz) antes, y TTS + envío de la nota de voz (hasta
// ~15-20s) después. Un valor más alto (se probó 65s) dejaba pasar el TTS fuera del handlerTimeout de 90s.
const AI_TIMEOUT_MS = 40000;
async function callAIWithTimeout(messages, config, onToolNotice, userId, ctx) {
  const workPromise = callAI(messages, config, onToolNotice, userId, ctx);
  const result = await withTimeout(workPromise, AI_TIMEOUT_MS);
  if (result === null) {
    // Promise.race no cancela workPromise — sigue corriendo en segundo plano aunque ya le
    // avisamos a Mariano que "tardamos demasiado". Bug real visto en vivo (31/07/2026): un pedido
    // de subtareas de Tasks superó los 40s, Mariano leyó "tardé demasiado, probá de nuevo" y
    // reformuló el mismo pedido — como las llamadas del primer intento (crear_tarea, etc.)
    // terminaron igual en segundo plano sin que nadie las viera, el reintento las duplicó. Ahora,
    // cuando el trabajo tardío termine, se lo mandamos como mensaje de seguimiento en vez de
    // descartarlo en silencio — así Mariano ve el resultado real antes de decidir si reformular.
    workPromise
      .then(async (lateResult) => {
        if (!lateResult || lateResult === GATED_NO_REPLY) return; // GATED_NO_REPLY: la UI de confirmación ya se mandó sola
        await saveMessage(userId, 'assistant', lateResult);
        await ctx.reply(`⏱️ Esto se terminó de procesar después de avisarte que tardaba — el resultado real fue:\n\n${escapeHtml(lateResult)}`, { parse_mode: 'HTML' });
      })
      .catch((error) => console.error('[callAIWithTimeout] error en trabajo tardío:', error.message));
    return 'Perdón, tardé demasiado en responder. Probá de nuevo o reformulá la pregunta.';
  }
  return result;
}

// `text` es siempre texto plano (respuesta libre de la IA o strings armados a mano, ninguno de los
// dos confiable como HTML/Markdown ya formateado) — ítem 112: se escapa acá para el envío por
// Telegram (parse_mode HTML, nunca se rompe con `_`/`<`/`>` sueltos) pero se lee en voz alta el
// texto original sin escapar, para que el TTS no lea entidades HTML literales.
async function replyWithAudio(ctx, text) {
  // Diagnóstico temporal (ver [[opengravity-bot-latencia]]): un mensaje que solo debía leer
  // Firestore (isConfigQuery, sin IA de por medio) tardó ~82s de punta a punta sin logs intermedios.
  // Instrumentado para ver si el cuello de botella es el envío del texto, el TTS o el envío de la nota de voz.
  console.log(`[replyWithAudio] antes de ctx.reply(texto): ${new Date().toISOString()}`);
  await ctx.reply(escapeHtml(text), { parse_mode: 'HTML' }).catch(() => ctx.reply(text));
  console.log(`[replyWithAudio] después de ctx.reply(texto), antes de TTS: ${new Date().toISOString()}`);
  const audioPath = await withTimeout(textToSpeech(text, ctx.from.id), TTS_TIMEOUT_MS);
  console.log(`[replyWithAudio] después de TTS (audioPath=${!!audioPath}): ${new Date().toISOString()}`);
  if (audioPath) {
    try {
      await ctx.replyWithVoice({ source: audioPath });
      console.log(`[replyWithAudio] después de replyWithVoice: ${new Date().toISOString()}`);
    } catch (e) {
      console.error('Error enviando audio TTS:', e.message);
    } finally {
      try { fs.unlinkSync(audioPath); } catch (_) {}
    }
  }
}

// ─────────────────────────────────────────
// MENSAJES DE TEXTO
// ─────────────────────────────────────────
// Procesa un mensaje de usuario (de texto o transcripto de audio) y responde con texto + audio.
async function handleUserText(ctx, text) {
  const userId = ctx.from.id;

  // ── Borrador pendiente de confirmación (Gmail/Calendar) — ciclo iterativo en lenguaje natural,
  // ver askConfirmation. Se chequea antes que cualquier otra cosa: mientras hay un borrador
  // esperando, toda respuesta de Mariano es sobre ESE borrador, no un mensaje nuevo y suelto.
  const pendingId = pendingConfirmationsByUser.get(userId);
  if (pendingId) {
    const pending = pendingConfirmations.get(pendingId);
    const intent = classifyDraftReply(text, pending.action);
    if (intent === 'confirm') {
      clearPendingConfirmation(pendingId);
      const outcomeLine = formatConfirmationOutcome(await runPendingAction(pending));
      const edited = await finalizeDraftMessage(ctx, pending, outcomeLine);
      return edited ? undefined : ctx.reply(outcomeLine);
    }
    if (intent === 'cancel') {
      clearPendingConfirmation(pendingId);
      const edited = await finalizeDraftMessage(ctx, pending, '❌ Cancelado, no se hizo nada.');
      return edited ? undefined : ctx.reply('Cancelado, no se hizo nada.');
    }
    // Corrección en lenguaje natural: se la pasamos a la IA con el borrador actual como contexto
    // explícito para que vuelva a llamar la misma herramienta con los cambios aplicados — eso
    // genera un askConfirmation nuevo (nuevos botones) y el ciclo se repite tantas veces como haga falta.
    clearPendingConfirmation(pendingId);
    const config = await getConfig(userId);
    const history = await getHistory(userId);
    await saveMessage(userId, 'user', text);
    const revisionPrompt = `Mariano pidió un cambio sobre el borrador pendiente que le mostraste (${pending.kind}):\n${pending.preview}\n\nCambio pedido: "${text}"\n\nVolvé a armar la acción completa con este cambio aplicado y llamá otra vez a la herramienta correspondiente con el borrador corregido — no le vuelvas a preguntar datos que ya tenías antes de este cambio.`;
    const revisionMessages = [
      { role: 'system', content: await buildSystemPromptFull() },
      ...history,
      { role: 'user', content: revisionPrompt },
    ];
    const revisionReply = await callAIWithTimeout(revisionMessages, config, null, userId, ctx);
    if (revisionReply === GATED_NO_REPLY) return;
    await saveMessage(userId, 'assistant', revisionReply);
    return replyWithAudio(ctx, revisionReply);
  }

  // ── Confirmación pendiente de una idea detectada en el mensaje anterior ──
  if (pendingIdeas.has(userId)) {
    const ideaText = pendingIdeas.get(userId);
    pendingIdeas.delete(userId);
    if (isAffirmative(text)) {
      const id = await saveIdea(userId, ideaText);
      return ctx.reply(`💡 Idea guardada (ID: ${id}).`);
    }
    return ctx.reply('Dale, no la guardo.');
  }

  // ── Hora/fecha exacta — cálculo directo, sin inventar nada ──
  if (isTimeQuery(text)) {
    const datetime = getArgentinaDateTime();
    const reply = `🕐 En Argentina son las: ${datetime}`;
    await saveMessage(userId, 'user', text);
    await saveMessage(userId, 'assistant', reply);
    return replyWithAudio(ctx, reply);
  }

  // ── Consulta de la config vigente — lectura directa de Firestore, sin tocar la IA ──
  if (isConfigQuery(text)) {
    console.log(`[isConfigQuery] antes de getConfig: ${new Date().toISOString()}`);
    const config = await getConfig(userId);
    console.log(`[isConfigQuery] después de getConfig: ${new Date().toISOString()}`);
    const reply = `⚙️ Estoy funcionando con:\n• Provider: ${config.provider}\n• Modelo: ${config.model}`;
    await saveMessage(userId, 'user', text);
    await saveMessage(userId, 'assistant', reply);
    console.log(`[isConfigQuery] después de los 2 saveMessage, antes de replyWithAudio: ${new Date().toISOString()}`);
    return replyWithAudio(ctx, reply);
  }

  // ── Cambio de voz/velocidad por lenguaje natural (texto o audio) ──
  const voiceCmd = parseVoiceCommand(text);
  if (voiceCmd) {
    const currentTts = await getTTSConfig(userId);
    const newTts = {
      voice: voiceCmd.voice || currentTts.voice || DEFAULT_VOICE,
      speed: voiceCmd.speed || currentTts.speed || 1.0,
    };
    await saveTTSConfig(userId, newTts);
    const voiceLabel = TTS_VOICES[newTts.voice]?.label || newTts.voice;
    const reply = `✅ Listo. Voz: ${escapeHtml(voiceLabel)} — Velocidad: ${newTts.speed}x`;
    await ctx.reply(reply, { parse_mode: 'HTML' });
    const audioPath = await withTimeout(textToSpeech('Listo, así suena la voz ahora.', userId), TTS_TIMEOUT_MS);
    if (audioPath) {
      try { await ctx.replyWithVoice({ source: audioPath }); }
      finally { try { fs.unlinkSync(audioPath); } catch (_) {} }
    }
    return;
  }

  // ── Cambio de configuración por lenguaje natural ──
  const configKeywords = ['cambiá', 'cambia', 'usá', 'usa', 'cambiame', 'cambiar', 'pasá', 'pasa'];
  const isConfig = configKeywords.some(k => text.toLowerCase().includes(k)) &&
    ['groq', 'openrouter', 'modelo'].some(k => text.toLowerCase().includes(k));

  if (isConfig) {
    const { provider, model } = parseConfigCommand(text);

    // Si el usuario mencionó explícitamente "modelo" pero no matcheó ninguno del catálogo, no reguardar
    // la config vieja como si el cambio hubiera aplicado — eso fue el bug real observado (pedir "modelo ZAI"
    // no matcheaba nada y el bot respondía "✅ actualizada" sin cambiar nada).
    if (text.toLowerCase().includes('modelo') && !model) {
      return ctx.reply(formatModelCatalog(), { parse_mode: 'HTML' });
    }

    const current = await getConfig(userId);
    const newProvider = provider || current.provider;
    let newModel = model || current.model;

    // Proveedor inexistente en el catálogo (ej. "groq", retirado) — rechazar explícito, sin
    // intentar leer un default que no existe.
    if (!MODELS_BY_PROVIDER[newProvider]) {
      return ctx.reply(formatModelCatalog(), { parse_mode: 'HTML' });
    }

    if (!isValidModelForProvider(newProvider, newModel)) {
      if (provider && !model) {
        // Cambio de proveedor sin modelo explícito: el modelo heredado no aplica, reseteamos al default (cambio válido implícito, no un error)
        newModel = MODELS_BY_PROVIDER[newProvider].default;
      } else {
        return ctx.reply(formatModelCatalog(), { parse_mode: 'HTML' });
      }
    }

    const newConfig = { provider: newProvider, model: newModel };
    await saveConfig(userId, newConfig);
    return ctx.reply(
      `✅ <b>Configuración actualizada:</b>\n\n• Provider: <code>${escapeHtml(newConfig.provider)}</code>\n• Modelo: <code>${escapeHtml(newConfig.model)}</code>`,
      { parse_mode: 'HTML' }
    );
  }

  // ── Posible idea nueva detectada en lenguaje natural — nunca se guarda directo, siempre se pregunta primero ──
  if (isPossibleIdea(text)) {
    pendingIdeas.set(userId, text);
    return ctx.reply('💡 ¿Guardo esto como idea? (sí/no)');
  }

  // ── Todo lo demás: el modelo decide con criterio si busca, qué busca y con qué alcance ──
  const config = await getConfig(userId);
  const history = await getHistory(userId);

  await saveMessage(userId, 'user', text);
  const messages = [
    { role: 'system', content: await buildSystemPromptFull() },
    ...history,
    { role: 'user', content: text },
  ];

  let notified = false;
  const onToolNotice = async (toolCalls) => {
    if (notified) return;
    notified = true;
    const names = toolCalls.map(tc => tc.function.name);
    if (names.includes('buscar_web')) await ctx.reply('🔍 Buscando en la web...');
    else if (names.includes('leer_url')) await ctx.reply('🌐 Leyendo el enlace...');
  };

  const aiReply = await callAIWithTimeout(messages, config, onToolNotice, userId, ctx);
  if (aiReply === GATED_NO_REPLY) return; // ya se mandó la UI de confirmación, no hay nada más que responder
  await saveMessage(userId, 'assistant', aiReply);
  await replyWithAudio(ctx, aiReply);
}

// Sin esto, cualquier error no capturado dentro de un handler (incluido el handlerTimeout
// de 90s de Telegraf) tumba el proceso entero en vez de solo quedar logueado.
bot.catch((err, ctx) => {
  console.error('Error no manejado en un handler de Telegraf:', err.message);
});

bot.on('text', async (ctx) => {
  await ctx.sendChatAction('typing');
  await handleUserText(ctx, ctx.message.text);
});

// ─────────────────────────────────────────
// VOZ
// ─────────────────────────────────────────
bot.on('voice', async (ctx) => {
  const userId = ctx.from.id;
  await ctx.sendChatAction('typing');
  try {
    // Diagnóstico temporal (ver [[opengravity-bot-latencia]]): última prueba mostró ~91s de silencio
    // total sin ningún log, con una respuesta que ni siquiera llama a la IA (isConfigQuery). Sin
    // timestamps por sub-paso no se puede saber si el tiempo se va en getFile(), en la descarga del
    // audio o en la llamada a Whisper de Groq.
    console.log(`[voice] t0 arranca handler: ${new Date().toISOString()}`);
    await ctx.reply('🎙️ Procesando audio...');
    console.log(`[voice] t1 antes de getFile: ${new Date().toISOString()}`);
    const file = await ctx.telegram.getFile(ctx.message.voice.file_id);
    console.log(`[voice] t2 después de getFile: ${new Date().toISOString()}`);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const transcribed = await transcribeAudio(fileUrl);
    console.log(`[voice] t3 después de transcribeAudio: ${new Date().toISOString()}`);
    if (!transcribed) return ctx.reply('❌ No pude entender el audio.');
    await ctx.reply(`🎤 <b>Dijiste:</b> "${escapeHtml(transcribed)}"`, { parse_mode: 'HTML' });
    console.log(`[voice] t4 antes de handleUserText: ${new Date().toISOString()}`);
    await handleUserText(ctx, transcribed);
    console.log(`[voice] t5 después de handleUserText: ${new Date().toISOString()}`);
  } catch (error) {
    console.error('Error en voice:', error);
    ctx.reply('Ocurrió un error procesando tu audio.');
  }
});

// ─────────────────────────────────────────
// DOCUMENTOS (PDF / DOCX)
// ─────────────────────────────────────────
bot.on('document', async (ctx) => {
  const userId = ctx.from.id;
  const doc = ctx.message.document;
  const fileName = doc.file_name || 'documento';
  const ext = getDocumentExtension(fileName);
  let tempPath = null;

  if (!SUPPORTED_DOCUMENT_EXT.includes(ext)) {
    return ctx.reply(`❌ Formato no soportado (${ext || 'sin extensión'}). Por ahora solo puedo leer PDF y Word (.docx).`);
  }
  if (doc.file_size && doc.file_size > MAX_DOCUMENT_BYTES) {
    return ctx.reply('❌ El archivo es demasiado grande (límite: 20MB).');
  }

  await ctx.sendChatAction('typing');
  try {
    await ctx.reply(`📄 Procesando "${fileName}"...`);
    const file = await ctx.telegram.getFile(doc.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 15000 });
    tempPath = path.join(__dirname, `doc_${Date.now()}${ext}`);
    fs.writeFileSync(tempPath, response.data);

    const buffer = fs.readFileSync(tempPath);
    const text = ext === '.pdf' ? await extractPdfText(buffer) : await extractDocxText(buffer);

    if (!text || !text.trim()) {
      return ctx.reply('❌ No pude extraer texto de ese documento (puede estar escaneado como imagen o vacío).');
    }

    const config = await getConfig(userId);
    const history = await getHistory(userId);
    const userPrompt = `Resumí los puntos clave de este documento ("${fileName}"):\n\n${text.slice(0, 8000)}`;
    const messages = [
      { role: 'system', content: await buildSystemPromptFull() },
      ...history,
      { role: 'user', content: userPrompt },
    ];
    const aiReply = await callAIWithTimeout(messages, config, null, userId, ctx);
    if (aiReply === GATED_NO_REPLY) return; // ya se mandó la UI de confirmación, no hay nada más que responder
    await saveMessage(userId, 'user', `[documento] ${fileName}`);
    await saveMessage(userId, 'assistant', aiReply);
    await replyWithAudio(ctx, aiReply);
  } catch (error) {
    console.error('Error procesando documento:', error.message);
    await ctx.reply('❌ No pude procesar ese documento en este momento.');
  } finally {
    if (tempPath) {
      try { fs.unlinkSync(tempPath); } catch (_) {}
    }
  }
});

// ─────────────────────────────────────────
// ARRANQUE
// ─────────────────────────────────────────
// Reemplaza al viejo testGroq(): el chequeo de sanidad de arranque ahora valida OpenRouter, que es
// el único proveedor de chat desde que se retiró Groq (ver MODELS_BY_PROVIDER). max_tokens en 50 y
// no en 5: los modelos gpt-oss son de razonamiento y gastan tokens en el razonamiento oculto antes
// del contenido final — con un límite muy chico el content vuelve null y esto tiraría un TypeError.
async function testOpenRouter() {
  if (!process.env.OPENROUTER_API_KEY) { console.log('⚠️ OPENROUTER_API_KEY no definida'); return; }
  try {
    const r = await axios.post('https://openrouter.ai/api/v1/chat/completions',
      { model: MODELS_BY_PROVIDER.openrouter.default, messages: [{ role: 'user', content: 'di hola' }], max_tokens: 50 },
      { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    console.log('✅ OpenRouter OK:', r.data.choices[0].message.content?.slice(0, 30));
  } catch (e) {
    console.error('❌ OpenRouter FALLA:', e.response?.status, JSON.stringify(e.response?.data?.error));
  }
}

// A3: ping a CADA modelo del catálogo (no solo el default), al arranque y en el job de las 9hs —
// si alguno falla, se avisa en vez de fallar en silencio (mismo criterio de testOpenRouter()).
async function pingAllCatalogModels() {
  const results = [];
  for (const model of Object.keys(MODELS_BY_PROVIDER.openrouter.models)) {
    try {
      await axios.post('https://openrouter.ai/api/v1/chat/completions',
        { model, messages: [{ role: 'user', content: 'di hola' }], max_tokens: 50 },
        { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 }
      );
      results.push({ model, ok: true });
    } catch (e) {
      results.push({ model, ok: false, detail: e.response?.data?.error?.message || e.message });
    }
  }
  return results;
}

// ─────────────────────────────────────────
// AVISO DIARIO 9HS ART — resumen de los 3 carriles (+ estado del token de Gmail, ítem 88)
// ─────────────────────────────────────────
async function buildDailyBrief(userId) {
  const desde = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const logSnap = await db.collection('log_acciones').where('timestamp', '>=', desde).get();
  const acciones = logSnap.docs.map((d) => d.data());
  const resumenAcciones = acciones.length
    ? acciones.map((a) => `• ${escapeHtml(a.accion)} → ${escapeHtml(a.destinatario_o_archivo)} (${escapeHtml(a.resultado)})`).join('\n')
    : 'Sin acciones registradas en las últimas 24hs.';

  const hermesSnap = await db.collection('tareas_hermes').where('estado', '==', 'pendiente').get();
  let hermesTexto = `Hermes: ${hermesSnap.size} pendientes.`;
  if (hermesSnap.size > 0) {
    const masVieja = hermesSnap.docs.reduce((a, b) => (a.data().creada < b.data().creada ? a : b));
    const dias = Math.floor((Date.now() - new Date(masVieja.data().creada).getTime()) / (24 * 60 * 60 * 1000));
    hermesTexto += ` La más vieja tiene ${dias} día(s).`;
  }

  let calendarTexto = 'no disponible (token vencido, pendiente de reautorización).';
  if (!googleOAuthExpired) {
    const { inicio: hoyInicio, fin: hoyFin } = getArgentinaTodayBounds();
    const evResult = await callGoogleAPI(userId, () =>
      calendarClient.events.list({ calendarId: 'primary', timeMin: hoyInicio.toISOString(), timeMax: hoyFin.toISOString(), singleEvents: true, orderBy: 'startTime' })
    );
    calendarTexto = evResult.ok
      ? (evResult.data.data.items.length ? evResult.data.data.items.map((e) => `• ${escapeHtml(e.summary)} (${escapeHtml(e.start.dateTime || e.start.date)})`).join('\n') : 'sin eventos hoy.')
      : `error consultando Calendar: ${escapeHtml(evResult.error)}`;
  }

  const modelPings = await pingAllCatalogModels();
  const modelosFallando = modelPings.filter((m) => !m.ok);
  const modelosTexto = modelosFallando.length
    ? `⚠️ Fallando: ${modelosFallando.map((m) => `${escapeHtml(m.model)} (${escapeHtml(m.detail)})`).join('; ')}`
    : 'todos los modelos del catálogo responden OK.';

  return (
    `📋 <b>Aviso diario — ${escapeHtml(getArgentinaDateTime())}</b>\n\n` +
    `<b>Bot (ayer):</b>\n${resumenAcciones}\n\n` +
    `<b>Hermes:</b>\n${escapeHtml(hermesTexto)}\n\n` +
    `<b>Projects:</b>\nno disponible todavía (scope de Drive ya autorizado desde el ítem 146, pero la integración de lectura/escritura sigue sin implementar — H2/H3).\n\n` +
    `<b>Calendar hoy:</b>\n${calendarTexto}\n\n` +
    `<b>Token Gmail/Calendar/Tasks:</b> ${googleOAuthExpired ? '⚠️ vencido, pendiente de reautorización.' : 'OK.'}\n\n` +
    `<b>Modelos (catálogo A3):</b> ${modelosTexto}`
  );
}

// Cloud Run escala a cero y no puede sostener un loop de polling (bot.launch()) — el bot
// recibe los updates vía webhook: Telegram le pega a WEBHOOK_URL/<path secreto> cuando hay un mensaje nuevo.
const WEBHOOK_PATH = `/telegraf/${process.env.TELEGRAM_BOT_TOKEN}`;
const PORT = process.env.PORT || 8080;

async function startBot() {
  console.log('🚀 Iniciando OpenGravity Bot (modo webhook)...');
  await testOpenRouter();
  const modelPings = await pingAllCatalogModels();
  const failing = modelPings.filter((m) => !m.ok);
  if (failing.length) console.error('⚠️ Modelos del catálogo A3 fallando al arranque:', failing.map((m) => `${m.model}: ${m.detail}`).join(' | '));
  else console.log('✅ Todos los modelos del catálogo A3 responden OK.');

  const webhookUrl = process.env.WEBHOOK_URL;
  if (!webhookUrl) {
    // Cloud Run asigna la URL del servicio recién en el primer deploy: el contenedor igual debe
    // levantar y responder al health check para que el deploy no falle. El webhook se registra
    // en un deploy posterior, una vez que WEBHOOK_URL ya se conoce y está seteado.
    console.warn('⚠️ WEBHOOK_URL no configurado todavía — el servidor arranca pero NO registra el webhook de Telegram.');
  }

  // No usamos bot.webhookCallback(): ese helper de Telegraf ata la respuesta HTTP a Telegram a que
  // termine TODO el procesamiento del update (incluida la llamada a la IA). Si eso tarda, Telegram
  // no recibe el 200 a tiempo y reenvía el mismo update — visto en producción: un mismo mensaje de
  // audio se procesó dos veces (una con Groq, otra con OpenRouter) porque el primer intento tardó
  // más de lo que Telegram espera. Acá confirmamos la recepción de inmediato y procesamos en
  // background, desacoplando el ACK del procesamiento real.
  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('OK');
    }
    // Endpoint del aviso diario (ítem 3.7): lo dispara Cloud Scheduler a la hora de
    // configuracion_bot.hora_aviso_diario. Protegido por un secreto de header, no por la
    // allowlist de Telegram (esto no llega por Telegram).
    if (req.method === 'POST' && req.url === '/cron/daily-brief') {
      if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET_TOKEN) {
        res.writeHead(403); return res.end('forbidden');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      (async () => {
        try {
          const brief = await buildDailyBrief(process.env.TELEGRAM_ALLOWED_USER_ID);
          await bot.telegram.sendMessage(process.env.TELEGRAM_ALLOWED_USER_ID, brief, { parse_mode: 'HTML' });
        } catch (err) {
          console.error('Error generando/enviando el aviso diario:', err.message);
        }
      })();
      return;
    }
    if (req.method === 'POST' && req.url === WEBHOOK_PATH) {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        try {
          const update = JSON.parse(body);
          bot.handleUpdate(update).catch((err) => console.error('Error procesando update en background:', err.message));
        } catch (err) {
          console.error('Error parseando update de Telegram:', err.message);
        }
      });
      return;
    }
    if (req.method === 'GET' && req.url.startsWith(OAUTH_CALLBACK_PATH)) {
      // Async por la lectura a Firestore — mismo patrón que el handler de /cron/daily-brief más
      // arriba (IIFE en background), el listener de http.createServer no puede ser async directo.
      (async () => {
        const params = new URL(req.url, OAUTH_REDIRECT_URI || 'http://localhost').searchParams;
        const code = params.get('code');
        const errorParam = params.get('error');
        const state = params.get('state');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (errorParam) {
          res.end('<h2>Autorización cancelada o denegada. Podés cerrar esta pestaña.</h2>');
          return;
        }
        let pending = null;
        try {
          const snap = await OAUTH_STATE_DOC().get();
          pending = snap.exists ? snap.data() : null;
        } catch (err) {
          console.error('Error leyendo el estado de reautorización en Firestore:', err.message);
        }
        if (!pending || state !== pending.value || Date.now() > pending.expiresAt) {
          res.end('<h2>Este link de reautorización venció o ya se usó. Pedile uno nuevo al Bot.</h2>');
          return;
        }
        if (!code) {
          res.end('<h2>Falta el parámetro code en la respuesta de Google.</h2>');
          return;
        }
        await OAUTH_STATE_DOC().delete();
        res.end('<h2>✅ Reautorización recibida, procesando... Ya podés cerrar esta pestaña, el Bot te avisa por Telegram.</h2>');
        completeOAuthCallback(code);
      })();
      return;
    }
    res.writeHead(404);
    return res.end();
  });

  server.listen(PORT, async () => {
    console.log(`✅ Servidor HTTP escuchando en el puerto ${PORT}.`);
    if (webhookUrl) {
      await bot.telegram.setWebhook(`${webhookUrl}${WEBHOOK_PATH}`, { drop_pending_updates: true });
      console.log('✅ Webhook configurado y bot listo para recibir mensajes.');
    }
  });
}

startBot();

// No hace falta bot.stop() acá: la app corre Telegraf en modo webhook manual (server.listen +
// setWebhook), nunca bot.launch() — Telegraf.stop() asume que se lanzó con .launch() y tira
// "Error: Bot is not running!" si no, ensuciando los logs en cada SIGTERM real (Cloud Run reciclando
// una instancia). Cloud Run mata el proceso igual apenas termina el handler, no queda nada que cerrar.
