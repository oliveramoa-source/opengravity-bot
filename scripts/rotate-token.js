#!/usr/bin/env node
// Rotación del token de Telegram con una sola intervención manual real: guardar el
// token nuevo en un archivo temporal vía el Bloc de notas (mismo método ya probado
// en la rotación anterior). Todo lo demás queda encadenado: Secret Manager ->
// redeploy de Cloud Run -> verificación vía diag:webhook -> confirmación de
// invalidación del token viejo. El único otro paso manual es mandar un mensaje
// real desde Telegram (inevitable: requiere el teléfono de Mariano, no el token).
//
// Por qué archivo y no pegado directo en la terminal: el pegado oculto (raw mode)
// resultó poco confiable en consolas de Windows con PSReadLine deshabilitado
// (detección de lector de pantalla) - entregaba datos truncados o duplicados.
// El archivo vía Notepad es el método que ya funcionó de punta a punta antes.
//
// Requiere una terminal interactiva real (PowerShell o Git Bash) para el paso de
// "apretá Enter cuando termines" - no corre a través de herramientas automatizadas.
//
// Uso: node scripts/rotate-token.js

const readline = require('readline');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { maskToken, stripUnknownTokenPatterns } = require('./lib/secret-mask');
const { getWebhookInfo, getMeStatus } = require('./lib/telegram-diag');
const {
  WEBHOOK_URL, readSecretVersion, addSecretVersionFromValue, updateCloudRunToSecretVersion,
} = require('./lib/secret-manager');
const https = require('https');

const EXPECTED_TOKEN_LENGTH = 46;
const TOKEN_FILE_PATH = path.join(os.tmpdir(), 'gws_token_temp.txt');

function askVisible(promptText) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(promptText, (answer) => { rl.close(); resolve(answer); }));
}

async function askFileToken() {
  console.log('=== Paso para pegar el token, sin que pase por la terminal ni por el chat ===\n');
  console.log('1. Abrí el Bloc de notas de Windows (buscá "Bloc de notas" en el menú de Windows).');
  console.log('2. Pegá ahí SOLO el token nuevo de @BotFather, nada más (ni espacios ni texto extra).');
  console.log(`3. Guardalo (Ctrl+S) con este nombre y ubicación exactos:\n   ${TOKEN_FILE_PATH}`);
  console.log('   (En el cuadro de "Guardar como", pegá esa ruta completa en el campo "Nombre de archivo" y apretá Guardar.)');
  console.log('4. Cerrá el Bloc de notas.');
  console.log('5. Volvé acá y apretá Enter.\n');

  await askVisible('Apretá Enter cuando ya guardaste el archivo... ');

  if (!fs.existsSync(TOKEN_FILE_PATH)) {
    throw new Error(`No encontré el archivo en ${TOKEN_FILE_PATH}. ¿Lo guardaste con ese nombre exacto? Volvé a correr el script.`);
  }

  try {
    const raw = fs.readFileSync(TOKEN_FILE_PATH, 'utf8');
    // Solo se recorta un salto de linea final (Notepad suele agregar uno) -
    // no un trim() completo, para no enmascarar basura real (espacios, \r sueltos).
    return raw.replace(/[\r\n]+$/, '');
  } finally {
    fs.unlinkSync(TOKEN_FILE_PATH); // se borra apenas se lee, haya salido bien o mal
  }
}

function httpGetStatus(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  console.log('=== Rotación del token de Telegram (OpenGravity Bot) ===\n');

  let newToken;
  try {
    newToken = await askFileToken();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  if (newToken.length !== EXPECTED_TOKEN_LENGTH) {
    console.log(`Token recibido: ${maskToken(newToken)} — largo INCORRECTO (esperado ${EXPECTED_TOKEN_LENGTH}).`);
    console.log('Corto acá sin tocar nada — parece mal guardado (¿espacio o salto de línea de más? ¿copia incompleta?). Volvé a correr el script.');
    process.exit(1);
  }
  console.log(`Token recibido: ${maskToken(newToken)} — largo correcto.\n`);

  // --- 1. Capturar el token viejo (en memoria, nunca impreso) para poder confirmar su invalidación al final ---
  console.log('[1/6] Leyendo la versión actual del secret (para poder confirmar después que quedó invalidada)...');
  let oldToken;
  try {
    oldToken = readSecretVersion('latest');
    console.log(`      Versión actual capturada en memoria: ${maskToken(oldToken)}`);
  } catch (err) {
    console.error('Error leyendo la versión actual del secret:', stripUnknownTokenPatterns(err.message));
    process.exit(1);
  }

  // --- 2. Cargar el token nuevo a Secret Manager vía archivo temporal ---
  console.log('\n[2/6] Cargando el token nuevo a Secret Manager (archivo temporal, borrado inmediato)...');
  let newVersion;
  try {
    newVersion = addSecretVersionFromValue(newToken);
    if (!/^\d+$/.test(newVersion)) {
      throw new Error(`Numero de version invalido ("${newVersion}") - no sigo al redeploy con esto.`);
    }
    console.log(`      Nueva versión creada: telegram-bot-token:${newVersion}`);
  } catch (err) {
    console.error('Error cargando el secret nuevo:', stripUnknownTokenPatterns(err.message));
    process.exit(1);
  }

  // --- 3. Redeploy de Cloud Run apuntando a la versión nueva ---
  console.log('\n[3/6] Redesplegando Cloud Run con la versión nueva del secret...');
  let revisionOut;
  try {
    revisionOut = updateCloudRunToSecretVersion(newVersion);
    console.log(`      Deploy terminado. Revisión activa: ${revisionOut.trim()}`);
  } catch (err) {
    console.error('Error en el redeploy:', stripUnknownTokenPatterns(err.message));
    console.error('El secret ya tiene la versión nueva cargada pero Cloud Run puede seguir en la vieja — revisar a mano.');
    process.exit(1);
  }

  // --- 4. Verificación con el token nuevo, exclusivamente vía las mismas rutinas de diag:webhook ---
  console.log('\n[4/6] Verificando con el token nuevo...');
  try {
    const health = await httpGetStatus(`${WEBHOOK_URL}/health`);
    console.log(`      /health -> ${health}`);

    const info = await getWebhookInfo(newToken);
    const pendingBefore = info.result ? info.result.pending_update_count : 'desconocido';
    console.log(`      getWebhookInfo -> ok:${info.ok}, pending_update_count:${pendingBefore}`);
    if (!info.ok) {
      console.error('getWebhookInfo no devolvió ok:true con el token nuevo. Deteniendo — no sigo con más pasos.');
      process.exit(1);
    }
  } catch (err) {
    console.error('Error en la verificación post-deploy:', stripUnknownTokenPatterns(err.message));
    process.exit(1);
  }

  // --- 5. Mensaje de prueba real (único paso manual restante, inevitable) ---
  console.log('\n[5/6] Paso manual: desde tu Telegram, mandale un mensaje real al bot ahora.');
  await askVisible('      Apretá Enter acá apenas lo hayas mandado... ');
  console.log('      Esperando ~8s para que se procese...');
  await sleep(8000);
  try {
    const infoAfter = await getWebhookInfo(newToken);
    const pendingAfter = infoAfter.result ? infoAfter.result.pending_update_count : 'desconocido';
    console.log(`      pending_update_count después del mensaje: ${pendingAfter} (0 = se procesó, no quedó colgado)`);
  } catch (err) {
    console.error('Error re-consultando getWebhookInfo:', stripUnknownTokenPatterns(err.message));
  }

  // --- 6. Confirmar que el token viejo quedó invalidado ---
  console.log('\n[6/6] Confirmando que el token viejo quedó invalidado...');
  try {
    const oldStatus = await getMeStatus(oldToken);
    if (oldStatus.statusCode === 401 && !oldStatus.ok) {
      console.log(`      getMe con el token viejo -> ${oldStatus.statusCode} Unauthorized. Confirmado: quedó invalidado.`);
    } else {
      console.log(`      getMe con el token viejo -> status ${oldStatus.statusCode}, ok:${oldStatus.ok}. NO se confirmó la invalidación — revisar a mano.`);
    }
  } catch (err) {
    console.error('Error confirmando invalidación del token viejo:', stripUnknownTokenPatterns(err.message));
  }

  console.log('\n=== Rotación completa. Ningún token se imprimió en texto plano en ningún paso. ===');
}

main().catch((err) => {
  console.error('Error inesperado:', err.message ? err.message : err);
  process.exit(1);
});
