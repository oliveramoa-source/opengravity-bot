// Wrapper de gcloud para Secret Manager. Ningun valor de secret pasa por
// stdout/stderr visible: se captura por buffer (stdio 'pipe') o se escribe
// directo a un archivo temporal, nunca se interpola en un console.log.
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT_ID = 'opengravity-bot-717d4';
const SECRET_NAME = 'telegram-bot-token';
const SERVICE_NAME = 'opengravity-bot';
const REGION = 'southamerica-east1';
const WEBHOOK_URL = 'https://opengravity-bot-bho2epf45q-rj.a.run.app';

function readSecretVersion(version) {
  const raw = execSync(
    `gcloud secrets versions access ${version} --secret=${SECRET_NAME} --project=${PROJECT_ID}`,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  return raw.replace(/\n$/, ''); // solo el salto final que agrega gcloud, no un trim completo: queremos poder DETECTAR basura, no ocultarla
}

// Escribe el token a un archivo temporal, lo carga como version nueva del secret,
// y borra el archivo en el finally pase lo que pase (exito o error).
function addSecretVersionFromValue(tokenValue) {
  const tmpPath = path.join(os.tmpdir(), `tgtoken_rotate_${Date.now()}.txt`);
  try {
    fs.writeFileSync(tmpPath, tokenValue, { encoding: 'utf8' });
    // --format=value(name) fuerza una salida estable por stdout (el mensaje humano
    // "Created version [N]..." de gcloud va por stderr y execSync no lo captura,
    // eso fue lo que rompio el redeploy la primera vez: version quedaba vacia).
    const out = execSync(
      `gcloud secrets versions add ${SECRET_NAME} --data-file="${tmpPath}" --project=${PROJECT_ID} --format="value(name)"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    ).trim();
    const match = out.match(/\/versions\/(\d+)/) || out.match(/(\d+)$/);
    if (!match) {
      throw new Error(`No se pudo determinar el numero de la version nueva del secret (salida de gcloud: "${out}")`);
    }
    return match[1];
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}

function updateCloudRunToSecretVersion(version) {
  return execSync(
    `gcloud run services update ${SERVICE_NAME} --project=${PROJECT_ID} --region=${REGION} --update-secrets=TELEGRAM_BOT_TOKEN=${SECRET_NAME}:${version}`,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
}

module.exports = {
  PROJECT_ID, SECRET_NAME, SERVICE_NAME, REGION, WEBHOOK_URL,
  readSecretVersion, addSecretVersionFromValue, updateCloudRunToSecretVersion,
};
