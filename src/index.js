#!/usr/bin/env node

// IMPORTANTE: dotenv debe cargar ANTES que cualquier otra cosa
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { Telegraf } = require('telegraf');
const axios = require('axios');
const fs = require('fs');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

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
// CONFIGURACIÓN DEL BOT (guardada en Firebase)
// ─────────────────────────────────────────
async function getConfig(userId) {
  const doc = await db.collection('config').doc(String(userId)).get();
  if (!doc.exists) {
    return { provider: 'groq', model: 'llama-3.3-70b-versatile' };
  }
  return doc.data();
}

async function saveConfig(userId, config) {
  await db.collection('config').doc(String(userId)).set(config, { merge: true });
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
// SYSTEM PROMPT
// ─────────────────────────────────────────
const SYSTEM_PROMPT = `
Sos "OpenGravity", un asistente de inteligencia artificial de élite creado para Mariano.
Respondé SIEMPRE en español rioplatense. Sos directo, profesional y sin rodeos.

PERFIL DEL USUARIO:
- Abogado civilista argentino (CABA y Provincia de Buenos Aires) reactivando su práctica
- Músico y productor profesional
- Broker de comercio internacional
- Desarrollador de ecosistema de IA (proyecto Metatrón)
- Emprendedor con múltiples proyectos de software en desarrollo
- Experto en marketing digital y redes sociales

TUS ÁREAS DE EXPERTISE:

1. DERECHO: Derecho civil, comercial, penal y laboral argentino. CCyCN, CPCCN, CPPF, LCT.
   Redacción de escritos, análisis de casos, estrategia procesal, jurisprudencia CSJN y SCBA.
   Fuentes: SAIJ, InfoLeg, CIJ, JUBA.

2. MÚSICA: Teoría musical, producción, arreglos, negocios musicales, licencias, distribución digital.

3. BROKER / COMERCIO INTERNACIONAL: Exportación, importación, triangulación, Incoterms,
   análisis de mercados, proveedores, precios internacionales, logística.

4. INTELIGENCIA ARTIFICIAL: Conocés todo el ecosistema Metatrón de Mariano.
   Plataformas: Claude, Gemini, GPT, Groq, OpenRouter, NotebookLM.
   Podés ayudar a diseñar agentes, prompts, automatizaciones y flujos de trabajo.

5. NEGOCIOS Y EMPRENDIMIENTO: Planes de negocio, análisis de viabilidad, estrategia,
   modelos de monetización, pitch, inversión.

6. MARKETING DIGITAL Y REDES SOCIALES: SEO, SEM, contenido, growth hacking,
   e-commerce, funnels de venta, branding.

7. DESARROLLO DE SOFTWARE: Ayudás en investigación, planificación y diseño de apps.
   Identificás tecnologías, arquitecturas y casos de uso. Generás borradores estructurados.

HERRAMIENTAS DISPONIBLES (vos decidís cuándo usarlas, con criterio propio):
- buscar_web(query): para cualquier dato que pueda haber cambiado desde tu entrenamiento — cotizaciones, noticias, legislación vigente, jurisprudencia, precios de commodities, mercados internacionales, info de productos/empresas. Usala SIEMPRE que la pregunta dependa de info actual o específica que no tengas con certeza, incluso en preguntas de seguimiento ("compará", "profundizá", "qué cambió") — no esperes a que digan "buscá" explícitamente.
- leer_url(url): cuando el usuario manda una URL.
- hora_actual(): para la fecha/hora exacta. Nunca la inventes, siempre usá esta herramienta.

CRITERIO DE ALCANCE GEOGRÁFICO (esto es donde más se nota si tenés criterio real o no):
- Mariano es abogado argentino: temas de derecho, laboral, impositivo, judicial → alcance Argentina por defecto, salvo que pida otro país.
- Commodities, mercados financieros internacionales, tecnología, productos para vender globalmente → alcance internacional, NO restrinjas a Argentina solo porque Mariano vive ahí.
- Si la pregunta es ambigua, usá el contexto de la conversación para decidir el alcance correcto, igual que lo harías si pensaras como un asistente humano experto.

REGLAS:
- Respondé siempre en español rioplatense, sin mezclar palabras en inglés.
- Sé directo y sin preámbulos innecesarios. Respondé exactamente lo que se pide, sin agregar info no solicitada.
- Para temas legales: no des asesoramiento vinculante.
- Recordás todo lo que Mariano te contó en conversaciones anteriores, pero NUNCA repitas datos de mensajes previos (hora, voz, velocidad, config) salvo que se pregunte por eso específicamente ahora.
- NUNCA afirmes haber cambiado tu propia voz o velocidad — eso lo maneja el sistema aparte, no respondas nada sobre eso si te lo piden.
- Cuando resumas una URL o resultado de búsqueda: hacelo en tus propias palabras (3-6 líneas), nunca copies bullets textuales.
- Para datos específicos (montos, porcentajes, comparaciones "antes vs. después", artículos de ley): si no tenés el dato verificado por una herramienta, decilo explícitamente en vez de inventar cifras. Nunca presentes una comparación legal específica como hecho sin haberla buscado.
`;

// ─────────────────────────────────────────
// FECHA Y HORA (cálculo directo, sin IA ni web)
// ─────────────────────────────────────────
const TIME_KEYWORDS = ['qué hora es', 'que hora es', 'hora actual', 'hora en argentina', 'qué día es', 'que dia es', 'fecha de hoy', 'fecha actual'];

function isTimeQuery(text) {
  const t = text.toLowerCase();
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
};

async function executeToolCall(toolCall) {
  const fn = TOOL_HANDLERS[toolCall.function.name];
  if (!fn) return 'Herramienta no reconocida.';
  try {
    const args = JSON.parse(toolCall.function.arguments || '{}');
    return await fn(args);
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
async function chatWithTools(url, apiKey, model, messages, onToolNotice) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  let convo = [...messages];

  for (let round = 0; round < 5; round++) {
    const response = await axios.post(
      url,
      { model, messages: convo, temperature: 0.5, tools: TOOL_DEFS, tool_choice: 'auto' },
      { headers, timeout: 30000 }
    );
    const msg = response.data.choices[0].message;

    if (!msg.tool_calls || !msg.tool_calls.length) {
      return msg.content;
    }

    if (onToolNotice) await onToolNotice(msg.tool_calls);

    convo.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls });
    for (const tc of msg.tool_calls) {
      const result = await executeToolCall(tc);
      convo.push({ role: 'tool', tool_call_id: tc.id, content: String(result).slice(0, 4000) });
    }
  }
  return 'No pude completar la respuesta tras varias búsquedas. Probá reformular la pregunta.';
}

// Guarda en Firestore el detalle de qué proveedor/modelo falló y por qué, para diagnosticar sin adivinar
async function logAIFailure(userId, attempts) {
  try {
    await db.collection('ai_errors').add({ userId: String(userId || 'unknown'), attempts, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('Error guardando log de fallos de IA:', error.message);
  }
}

async function callAI(messages, config, onToolNotice, userId) {
  const headers = { 'Content-Type': 'application/json' };
  const provider = config?.provider || 'groq';
  const model = config?.model || 'llama-3.3-70b-versatile';
  const clean = cleanMessages(messages);
  const attempts = [];

  if (provider === 'groq' && process.env.GROQ_API_KEY) {
    try {
      return await chatWithTools('https://api.groq.com/openai/v1/chat/completions', process.env.GROQ_API_KEY, model, clean, onToolNotice);
    } catch (error) {
      const detail = error.response?.data?.error?.message || error.message;
      console.error('Error Groq:', detail);
      attempts.push({ provider: 'groq', model, error: detail });
    }
  }

  if (provider === 'openrouter' && process.env.OPENROUTER_API_KEY) {
    try {
      return await chatWithTools('https://openrouter.ai/api/v1/chat/completions', process.env.OPENROUTER_API_KEY, model, clean, onToolNotice);
    } catch (error) {
      console.error('Error OpenRouter:', error.message);
      attempts.push({ provider: 'openrouter', model, error: error.message });
    }
  }

  // Fallback final: Groq con modelo estable
  if (process.env.GROQ_API_KEY) {
    try {
      return await chatWithTools('https://api.groq.com/openai/v1/chat/completions', process.env.GROQ_API_KEY, 'llama-3.3-70b-versatile', clean, onToolNotice);
    } catch (error) {
      console.error('Error fallback Groq:', error.message);
      attempts.push({ provider: 'groq', model: 'llama-3.3-70b-versatile', error: error.message });
    }
  }

  // Fallback de razonamiento: modelo gratuito fuerte en derecho/finanzas/marketing (ranking OpenRouter jul-2026)
  if (process.env.OPENROUTER_API_KEY) {
    try {
      return await chatWithTools('https://openrouter.ai/api/v1/chat/completions', process.env.OPENROUTER_API_KEY, 'tencent/hy3:free', clean, onToolNotice);
    } catch (error) {
      console.error('Error fallback Hy3:', error.message);
      attempts.push({ provider: 'openrouter', model: 'tencent/hy3:free', error: error.message });
    }
  }

  // Último recurso: modelo chico y liviano, casi siempre disponible
  if (process.env.OPENROUTER_API_KEY) {
    try {
      return await chatWithTools('https://openrouter.ai/api/v1/chat/completions', process.env.OPENROUTER_API_KEY, 'meta-llama/llama-3.1-8b-instruct:free', clean, onToolNotice);
    } catch (error) {
      console.error('Error fallback OpenRouter:', error.message);
      attempts.push({ provider: 'openrouter', model: 'meta-llama/llama-3.1-8b-instruct:free', error: error.message });
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
async function transcribeAudio(fileUrl) {
  try {
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    const tempPath = path.join(__dirname, `audio_${Date.now()}.ogg`);
    fs.writeFileSync(tempPath, response.data);
    const FormData = require('form-data');
    const formData = new FormData();
    formData.append('file', fs.createReadStream(tempPath));
    formData.append('model', 'whisper-large-v3');
    const res = await axios.post(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      formData,
      {
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, ...formData.getHeaders() },
        timeout: 30000,
      }
    );
    fs.unlinkSync(tempPath);
    return res.data.text;
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
const MODELS_BY_PROVIDER = {
  groq: {
    default: 'llama-3.3-70b-versatile',
    models: {
      'llama-3.3-70b-versatile': 'Default — modelo principal, más capaz, uso general',
      'llama-3.1-8b-instant': 'Rápido, para tareas simples/livianas',
      'gemma2-9b-it': 'Alternativa liviana de Google',
      'mixtral-8x7b-32768': 'Contexto largo',
    },
  },
  openrouter: {
    default: 'meta-llama/llama-3.1-8b-instruct:free',
    models: {
      'tencent/hy3:free': 'Fallback de razonamiento (uso interno del sistema)',
      'meta-llama/llama-3.1-8b-instruct:free': 'Último recurso del sistema',
      'deepseek/deepseek-r1:free': 'Razonamiento profundo/matemático',
      'mistralai/mistral-7b-instruct:free': 'Liviano y rápido',
      'qwen/qwen-2.5-72b-instruct:free': 'Modelo grande, multilingüe',
      'z-ai/glm-4.5-air:free': 'GLM, uso general',
    },
  },
};

function isValidModelForProvider(provider, model) {
  return !!MODELS_BY_PROVIDER[provider]?.models[model];
}

const PROVIDER_LABELS = { groq: 'Groq', openrouter: 'OpenRouter' };

function formatModelCatalog() {
  return `⚠️ Esa combinación no es válida.\nProveedores y modelos disponibles:\n\n${buildModelCatalogText()}`;
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

// System prompt completo: base + catálogo de modelos, para que el modelo pueda recomendar el más adecuado si le preguntan
const SYSTEM_PROMPT_FULL = `${SYSTEM_PROMPT}

CATÁLOGO DE MODELOS DISPONIBLES (si te preguntan qué modelo conviene para una tarea, respondé con criterio usando esta info):
${buildModelCatalogText()}`;

// ─────────────────────────────────────────
// PARSEO DE COMANDOS DE CONFIGURACIÓN
// ─────────────────────────────────────────
function parseConfigCommand(text) {
  const t = text.toLowerCase();
  let provider = null;
  let model = null;

  if (t.includes('groq')) provider = 'groq';
  else if (t.includes('openrouter')) provider = 'openrouter';

  const models = {
    'llama-3.3-70b': 'llama-3.3-70b-versatile',
    'llama 3.3': 'llama-3.3-70b-versatile',
    'llama-3.1-8b': 'llama-3.1-8b-instant',
    'gemma2': 'gemma2-9b-it',
    'mixtral': 'mixtral-8x7b-32768',
    'deepseek': 'deepseek/deepseek-r1:free',
    'mistral': 'mistralai/mistral-7b-instruct:free',
    'qwen': 'qwen/qwen-2.5-72b-instruct:free',
    'hy3': 'tencent/hy3:free',
    'glm': 'z-ai/glm-4.5-air:free',
  };

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
    `• Provider: *${config.provider}*\n` +
    `• Modelo: *${config.model}*\n\n` +
    `Comandos:\n` +
    `/config — ver configuración\n` +
    `/voz — cambiar voz (tomas/elena/alvaro/brian...)\n` +
    `/velocidad — cambiar velocidad (0.5 a 2.0)\n` +
    `/idea [texto] — guardar idea\n` +
    `/ideas — ver tus ideas\n` +
    `/buscar [query] — buscar en la web\n` +
    `/clear — borrar historial\n\n` +
    `O decime en lenguaje natural:\n` +
    `_"Cambiá a Groq con llama-3.3-70b"_`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('config', async (ctx) => {
  const config = await getConfig(ctx.from.id);
  await ctx.reply(
    `⚙️ *Configuración actual:*\n\n` +
    `• Provider: \`${config.provider}\`\n` +
    `• Modelo: \`${config.model}\`\n\n` +
    `Para cambiar decime:\n_"Cambiá a OpenRouter con deepseek"_`,
    { parse_mode: 'Markdown' }
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
    const opciones = Object.entries(TTS_VOICES).map(([k, v]) => `\`${k}\` — ${v.label}`).join('\n');
    return ctx.reply(
      `🎙️ *Configuración de voz actual:*\n• Voz: \`${currentVoice}\` — ${TTS_VOICES[currentVoice]?.label}\n\n` +
      `*Voces disponibles:*\n${opciones}\n\n` +
      `Uso: \`/voz tomas\` (hombre argentino) o \`/voz elena\` (mujer argentina)`,
      { parse_mode: 'Markdown' }
    );
  }
  if (!TTS_VOICES[arg]) return ctx.reply(`Voz no válida. Opciones: ${Object.keys(TTS_VOICES).join(', ')}`);
  await saveTTSConfig(ctx.from.id, { voice: arg });
  await ctx.reply(`✅ Voz cambiada a \`${arg}\` — ${TTS_VOICES[arg].label}`, { parse_mode: 'Markdown' });
});

bot.command('velocidad', async (ctx) => {
  const arg = parseFloat(ctx.message.text.replace('/velocidad', '').trim());
  const cfg = await getTTSConfig(ctx.from.id);
  if (isNaN(arg) || arg < 0.5 || arg > 2.0) {
    return ctx.reply(
      `⚡ *Velocidad actual:* \`${cfg.speed || 1.0}x\`\n\nUsá un valor entre \`0.5\` y \`2.0\`\nEjemplo: \`/velocidad 1.2\``,
      { parse_mode: 'Markdown' }
    );
  }
  await saveTTSConfig(ctx.from.id, { speed: arg });
  await ctx.reply(`✅ Velocidad cambiada a \`${arg}x\``, { parse_mode: 'Markdown' });
});

bot.command('idea', async (ctx) => {
  const text = ctx.message.text.replace('/idea', '').trim();
  if (!text) return ctx.reply('Escribí la idea después del comando:\n`/idea [tu idea]`', { parse_mode: 'Markdown' });
  const id = await saveIdea(ctx.from.id, text);
  await ctx.reply(`💡 Idea guardada (ID: ${id})\n\n"${text}"`);
});

bot.command('ideas', async (ctx) => {
  const ideas = await getIdeas(ctx.from.id);
  if (!ideas.length) return ctx.reply('No tenés ideas guardadas todavía.');
  const lista = ideas.slice(-10)
    .map((i, idx) => `${idx + 1}. ${i.text}\n   📅 ${new Date(i.date).toLocaleDateString('es-AR')}`)
    .join('\n\n');
  await ctx.reply(`💡 *Tus últimas ideas:*\n\n${lista}`, { parse_mode: 'Markdown' });
});

bot.command('buscar', async (ctx) => {
  const query = ctx.message.text.replace('/buscar', '').trim();
  if (!query) return ctx.reply('Escribí qué querés buscar:\n`/buscar [consulta]`', { parse_mode: 'Markdown' });
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
    { role: 'system', content: SYSTEM_PROMPT_FULL },
    ...history,
    { role: 'user', content: `${query}\n\nResultados web:\n${results}` },
  ];
  const aiReply = await callAI(messages, config, null, ctx.from.id);
  await saveMessage(ctx.from.id, 'user', `/buscar ${query}`);
  await saveMessage(ctx.from.id, 'assistant', aiReply);
  await replyWithAudio(ctx, aiReply);
});

// ─────────────────────────────────────────
// HELPER: enviar respuesta en texto + audio
// ─────────────────────────────────────────
async function replyWithAudio(ctx, text) {
  // 1. Respuesta en texto
  await ctx.reply(text, { parse_mode: 'Markdown' }).catch(() => ctx.reply(text));
  // 2. Respuesta en audio (TTS)
  const audioPath = await textToSpeech(text, ctx.from.id);
  if (audioPath) {
    try {
      await ctx.replyWithVoice({ source: audioPath });
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
    const reply = `🕐 En Argentina son las: *${datetime}*`;
    await saveMessage(userId, 'user', text);
    await saveMessage(userId, 'assistant', reply);
    return replyWithAudio(ctx, reply);
  }

  // ── Consulta de la config vigente — lectura directa de Firestore, sin tocar la IA ──
  if (isConfigQuery(text)) {
    const config = await getConfig(userId);
    const reply = `⚙️ Estoy funcionando con:\n• Provider: *${config.provider}*\n• Modelo: *${config.model}*`;
    await saveMessage(userId, 'user', text);
    await saveMessage(userId, 'assistant', reply);
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
    const reply = `✅ Listo. Voz: ${voiceLabel} — Velocidad: ${newTts.speed}x`;
    await ctx.reply(reply, { parse_mode: 'Markdown' });
    const audioPath = await textToSpeech('Listo, así suena la voz ahora.', userId);
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
    const current = await getConfig(userId);
    const newProvider = provider || current.provider;
    let newModel = model || current.model;

    if (!isValidModelForProvider(newProvider, newModel)) {
      if (provider && !model) {
        // Cambio de proveedor sin modelo explícito: el modelo heredado no aplica, reseteamos al default (cambio válido implícito, no un error)
        newModel = MODELS_BY_PROVIDER[newProvider].default;
      } else {
        return ctx.reply(formatModelCatalog(), { parse_mode: 'Markdown' });
      }
    }

    const newConfig = { provider: newProvider, model: newModel };
    await saveConfig(userId, newConfig);
    return ctx.reply(
      `✅ *Configuración actualizada:*\n\n• Provider: \`${newConfig.provider}\`\n• Modelo: \`${newConfig.model}\``,
      { parse_mode: 'Markdown' }
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
    { role: 'system', content: SYSTEM_PROMPT_FULL },
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

  const aiReply = await callAI(messages, config, onToolNotice, userId);
  await saveMessage(userId, 'assistant', aiReply);
  await replyWithAudio(ctx, aiReply);
}

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
    await ctx.reply('🎙️ Procesando audio...');
    const file = await ctx.telegram.getFile(ctx.message.voice.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const transcribed = await transcribeAudio(fileUrl);
    if (!transcribed) return ctx.reply('❌ No pude entender el audio.');
    await ctx.reply(`🎤 *Dijiste:* "${transcribed}"`, { parse_mode: 'Markdown' });
    await handleUserText(ctx, transcribed);
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
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
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
      { role: 'system', content: SYSTEM_PROMPT_FULL },
      ...history,
      { role: 'user', content: userPrompt },
    ];
    const aiReply = await callAI(messages, config, null, userId);
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
async function testGroq() {
  if (!process.env.GROQ_API_KEY) { console.log('⚠️ GROQ_API_KEY no definida'); return; }
  try {
    const r = await axios.post('https://api.groq.com/openai/v1/chat/completions',
      { model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'di hola' }], max_tokens: 5 },
      { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    console.log('✅ Groq OK:', r.data.choices[0].message.content.slice(0, 30));
  } catch (e) {
    console.error('❌ Groq FALLA:', e.response?.status, JSON.stringify(e.response?.data?.error));
  }
}

async function startBot(attempt = 1) {
  console.log(`🚀 Iniciando OpenGravity Bot... (intento ${attempt})`);
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    console.log('🔁 Sesión anterior limpiada.');
  } catch (e) {
    console.warn('Aviso al limpiar webhook:', e.message);
  }
  await testGroq();
  // Esperar a que Railway apague la instancia anterior (más tiempo en reintentos)
  const delay = attempt === 1 ? 5000 : 15000;
  await new Promise(r => setTimeout(r, delay));
  try {
    await bot.launch({ dropPendingUpdates: true });
    console.log('✅ Bot conectado y escuchando mensajes.');
  } catch (err) {
    if (err.message?.includes('409') && attempt < 5) {
      console.warn(`⚠️ Conflicto 409, reintentando en 15s... (intento ${attempt}/5)`);
      await new Promise(r => setTimeout(r, 15000));
      return startBot(attempt + 1);
    }
    console.error('❌ Fallo al iniciar:', err.message);
    process.exit(1);
  }
}

startBot();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
