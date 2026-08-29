#!/usr/bin/env node

// Único camino sancionado para confirmar qué variables existen en .env SIN ver sus valores
// (ver CLAUDE.md — el bloqueo de lectura directa de .env es ahora un hook de permisos, esto es
// la vía de consulta que queda disponible en su lugar). Nunca imprime el valor de una variable,
// solo su nombre — lee el archivo completo en memoria pero descarta todo menos el nombre antes
// de loguear cualquier cosa.
//
// Uso:
//   node scripts/lib/env-vars.js              -> lista todos los nombres de variables presentes
//   node scripts/lib/env-vars.js NOMBRE       -> "true"/"false" según exista esa variable puntual

const fs = require('fs');
const path = require('path');

function listEnvVarNames(envPath) {
  const content = fs.readFileSync(envPath, 'utf8');
  const names = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (match) names.push(match[1]);
  }
  return names;
}

const envPath = path.resolve(__dirname, '../../.env');
if (!fs.existsSync(envPath)) {
  console.error('No existe .env en la raíz del repo.');
  process.exit(1);
}

const names = listEnvVarNames(envPath);
const query = process.argv[2];
if (query) {
  console.log(names.includes(query) ? `true (${query} existe)` : `false (${query} no existe)`);
} else {
  console.log(names.join('\n'));
}
