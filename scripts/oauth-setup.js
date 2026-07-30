#!/usr/bin/env node
// Herramienta de un solo uso (y de reautorización cada 7 días, ítem 88 v5.1):
// arma el consent screen de Google, captura el code del redirect local, y sube
// client_id / client_secret / refresh_token directo a Secret Manager — nunca
// se imprime ningún valor completo en consola ni queda en un archivo del repo.
//
// Uso: node scripts/oauth-setup.js "<ruta al client_secret_....json descargado de GCP Console>"

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { google } = require('googleapis');

const PROJECT = 'opengravity-bot-717d4';
const PORT = 53682;
// PATH del proceso node no siempre incluye gcloud (ya documentado en el handoff del proyecto
// para sesiones nuevas de PowerShell/Bash) — se usa la ruta completa del ejecutable para no depender de eso.
const GCLOUD_BIN = process.env.GCLOUD_BIN || 'C:\\Users\\olive\\AppData\\Local\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd';
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/tasks',
];

function mask(value) {
  if (!value || value.length < 8) return '****';
  return `${value.slice(0, 4)}...${value.slice(-4)} (${value.length} chars)`;
}

function upsertSecret(name, value, scratchDir) {
  const tmpPath = path.join(scratchDir, `${name}-${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, value, { encoding: 'utf8' }); // nunca WriteAllText de PowerShell (bug de BOM ya documentado)
  try {
    // .cmd de gcloud en Windows necesita shell:true (si no, EINVAL) — y con shell:true Node no
    // cita el propio ejecutable, así que si la ruta tiene espacios ("Google\Cloud SDK") el shell
    // la corta ahí (visto en vivo: "Google\Cloud" no reconocido) — hay que citarla nosotros.
    const gcloudQuoted = `"${GCLOUD_BIN}"`;
    const exists = (() => {
      try {
        execFileSync(gcloudQuoted, ['secrets', 'describe', name, `--project=${PROJECT}`], { stdio: 'ignore', shell: true });
        return true;
      } catch (e) {
        return false;
      }
    })();
    if (exists) {
      execFileSync(gcloudQuoted, ['secrets', 'versions', 'add', name, `--project=${PROJECT}`, `--data-file=${tmpPath}`], { stdio: 'inherit', shell: true });
    } else {
      execFileSync(gcloudQuoted, ['secrets', 'create', name, `--project=${PROJECT}`, `--data-file=${tmpPath}`, '--replication-policy=automatic'], { stdio: 'inherit', shell: true });
    }
    console.log(`✅ Secret '${name}' actualizado en Secret Manager (valor: ${mask(value)}, nunca impreso completo).`);
  } finally {
    fs.unlinkSync(tmpPath);
  }
}

async function main() {
  const jsonPath = process.argv[2];
  if (!jsonPath) {
    console.error('Uso: node scripts/oauth-setup.js "<ruta al client_secret_....json>"');
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const creds = raw.installed || raw.web;
  const { client_id, client_secret } = creds;
  const redirectUri = `http://localhost:${PORT}`;

  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // fuerza refresh_token también en reautorizaciones (ciclo de 7 días, ítem 88)
    scope: SCOPES,
  });

  console.log('\n=== ABRÍ ESTE LINK EN TU NAVEGADOR (ya logueado con tu cuenta de Google) ===\n');
  console.log(authUrl);
  console.log('\nEsperando a que completes el consent screen...\n');

  const scratchDir = process.env.OAUTH_SETUP_SCRATCH_DIR || path.join(require('os').tmpdir(), 'opengravity-oauth');
  fs.mkdirSync(scratchDir, { recursive: true });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, redirectUri);
    if (url.pathname !== '/') { res.writeHead(404); return res.end(); }
    const code = url.searchParams.get('code');
    const errorParam = url.searchParams.get('error');
    if (errorParam) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>Autorización cancelada o denegada. Podés cerrar esta pestaña.</h2>');
      console.error(`❌ Google devolvió error: ${errorParam}`);
      server.close();
      process.exit(1);
    }
    if (!code) { res.writeHead(400); return res.end('Falta el parámetro code.'); }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h2>✅ Listo, ya podés cerrar esta pestaña.</h2>');

    try {
      const { tokens } = await oAuth2Client.getToken(code);
      if (!tokens.refresh_token) {
        console.error('❌ Google no devolvió refresh_token (puede pasar si ya habías autorizado antes sin "prompt=consent"). Revocá el acceso en https://myaccount.google.com/permissions y volvé a correr el script.');
        server.close();
        process.exit(1);
      }
      upsertSecret('google-oauth-client-id', client_id, scratchDir);
      upsertSecret('google-oauth-client-secret', client_secret, scratchDir);
      upsertSecret('google-oauth-refresh-token', tokens.refresh_token, scratchDir);
      console.log('\n✅ Los 3 secrets quedaron en Secret Manager. Nada se imprimió completo ni quedó en el repo.');
    } catch (error) {
      console.error('❌ Error intercambiando el code por tokens:', error.message);
    } finally {
      server.close();
      process.exit(0);
    }
  });

  server.listen(PORT, () => {
    console.log(`(servidor local escuchando en ${redirectUri} esperando el redirect de Google)`);
  });
}

main();
