#!/usr/bin/env node
// Diagnóstico seguro del webhook de Telegram: nunca imprime el token completo en pantalla ni en logs.
// Uso:
//   node scripts/diag-webhook.js                          -> usa TELEGRAM_BOT_TOKEN del .env
//   node scripts/diag-webhook.js --secret-version latest  -> lee el token desde Secret Manager (gcloud)
//   node scripts/diag-webhook.js --secret-version 3       -> version puntual del secret

require('dotenv').config();
const { maskToken, maskOccurrences, maskBytesDump } = require('./lib/secret-mask');
const { getWebhookInfo } = require('./lib/telegram-diag');
const { readSecretVersion } = require('./lib/secret-manager');

async function main() {
  const args = process.argv.slice(2);
  const secretFlagIdx = args.indexOf('--secret-version');

  let token;
  let source;
  if (secretFlagIdx !== -1) {
    const version = args[secretFlagIdx + 1] || 'latest';
    token = readSecretVersion(version);
    source = `Secret Manager (telegram-bot-token:${version})`;
  } else {
    token = process.env.TELEGRAM_BOT_TOKEN;
    source = 'TELEGRAM_BOT_TOKEN (.env)';
  }

  if (!token) {
    console.error('No hay token disponible. Pasa --secret-version <n> o setea TELEGRAM_BOT_TOKEN en .env.');
    process.exit(1);
  }

  console.log(`Fuente del token: ${source}`);
  console.log(`Token enmascarado: ${maskToken(token)}\n`);

  console.log('--- Volcado de bytes (solo bordes) ---');
  console.log(maskBytesDump(token));

  console.log('\n--- getWebhookInfo (URL enmascarada) ---');
  try {
    const info = await getWebhookInfo(token);
    const printable = JSON.parse(JSON.stringify(info)); // copia, no tocar el original
    if (printable.result && typeof printable.result.url === 'string') {
      printable.result.url = maskOccurrences(printable.result.url, token);
    }
    console.log(JSON.stringify(printable, null, 2));
  } catch (err) {
    console.error('Error consultando getWebhookInfo:', err.message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Error inesperado:', err.message || err);
  process.exit(1);
});
