#!/usr/bin/env node
// Paso 2 del plan H1: confirma/crea las colecciones nuevas de Firestore.
// Corre local, usa las credenciales de Firebase Admin ya presentes en .env.
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const admin = require('firebase-admin');

const serviceAccount = {
  type: 'service_account',
  project_id: process.env.FIREBASE_PROJECT_ID,
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
};
const certFn = admin.cert || (admin.credential && admin.credential.cert.bind(admin.credential));
admin.initializeApp({ credential: certFn(serviceAccount) });
let db;
try {
  db = require('firebase-admin/firestore').getFirestore();
} catch (e) {
  db = admin.firestore();
}

async function main() {
  const hermesSnap = await db.collection('tareas_hermes').limit(1).get();
  console.log(`tareas_hermes: ${hermesSnap.empty ? 'vacía (se crea con el primer doc real, esquema A1)' : `ya tiene documentos (ej. campos: ${Object.keys(hermesSnap.docs[0].data()).join(', ')})`}`);

  const cfgRef = db.collection('configuracion_bot').doc('default');
  const cfgSnap = await cfgRef.get();
  if (!cfgSnap.exists) {
    await cfgRef.set({
      hora_aviso_diario: '09:00',
      timezone: 'America/Argentina/Buenos_Aires',
    });
    console.log('configuracion_bot/default: creado.');
  } else {
    console.log('configuracion_bot/default: ya existía, sin tocar ->', JSON.stringify(cfgSnap.data()));
  }

  // log_acciones: append-only, no hace falta "crear" la colección (Firestore es schemaless) — se
  // confirma que está vacía o accesible, el primer log_acciones.add() real la deja creada.
  const logSnap = await db.collection('log_acciones').limit(1).get();
  console.log(`log_acciones: ${logSnap.empty ? 'vacía, se crea con el primer log real' : 'ya tiene registros'}`);

  process.exit(0);
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
