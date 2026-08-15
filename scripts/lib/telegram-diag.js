// Llamadas de solo-diagnostico a la API de Telegram. No modifican nada del lado de Telegram
// salvo por el efecto normal de consultar (getWebhookInfo/getMe son de lectura).
const https = require('https');
const { maskOccurrences, stripUnknownTokenPatterns } = require('./secret-mask');

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(new Error(`Respuesta no-JSON (status ${res.statusCode})`)); }
      });
    }).on('error', reject);
  });
}

async function getWebhookInfo(token) {
  try {
    const { body } = await httpsGetJson(`https://api.telegram.org/bot${token}/getWebhookInfo`);
    return body;
  } catch (err) {
    throw new Error(stripUnknownTokenPatterns(maskOccurrences(err.message, token)));
  }
}

// Devuelve solo {ok, statusCode} - nunca el body completo, que podria traer
// datos del bot (nombre, username) irrelevantes para el chequeo de invalidacion.
async function getMeStatus(token) {
  try {
    const { status, body } = await httpsGetJson(`https://api.telegram.org/bot${token}/getMe`);
    return { statusCode: status, ok: !!body.ok };
  } catch (err) {
    throw new Error(stripUnknownTokenPatterns(maskOccurrences(err.message, token)));
  }
}

module.exports = { getWebhookInfo, getMeStatus };
