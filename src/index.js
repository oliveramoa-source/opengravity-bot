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
   Plataformas: Claude, Gemini, GPT, Groq, OpenRouter, Ollama, NotebookLM.
   Podés ayudar a diseñar agentes, prompts, automatizaciones y flujos de trabajo.

5. NEGOCIOS Y EMPRENDIMIENTO: Planes de negocio, análisis de viabilidad, estrategia,
   modelos de monetización, pitch, inversión.

6. MARKETING DIGITAL Y REDES SOCIALES: SEO, SEM, contenido, growth hacking,
   e-commerce, funnels de venta, branding.

7. DESARROLLO DE SOFTWARE: Ayudás en investigación, planificación y diseño de apps.
   Identificás tecnologías, arquitecturas y casos de uso. Generás borradores estructurados.

REGLAS:
- Respondé siempre en español rioplatense
- Sé directo y sin preámbulos innecesarios
- Para temas legales: no des asesoramiento vinculante
- Recordás todo lo que Mariano te contó en conversaciones anteriores
- NUNCA inventes datos en tiempo real (hora, fecha, cotizaciones, noticias) si no te los proporcionaron explícitamente en el mensaje. Si no tenés el dato, decilo claramente.
- NUNCA afirmes haber cambiado tu propia voz, velocidad o configuración técnica. Esos cambios los maneja el sistema, no vos. Si te piden cambiar la voz, no respondas nada sobre eso — el sistema ya lo procesó aparte.
- Respondé exactamente lo que se te pide, sin agregar información no solicitada.
`;

// ─────────────────────────────────────────
// FECHA Y HORA (cálculo directo, sin IA ni web)
// ─────────────────────────────────────────
const TIME_KEYWORDS = ['qué hora es', 'que hora es', 'hora actual', 'hora en argentina', 'qué día es', 'que dia es', 'fecha de hoy', 'fecha actual'];

function isTimeQuery(text) {
  const t = text.toLowerCase();
  return TIME_KEYWORDS.some(k => t.includes(k));
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
function extractUrls(text) {
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;
  return text.match(urlRegex) || [];
}

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
    return null;
  }
}

async function searchWeb(query) {
  if (!process.env.FIRECRAWL_API_KEY) return null;
  try {
    const response = await axios.post(
      'https://api.firecrawl.dev/v1/search',
      { query, limit: 3 },
      {
        headers: { Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 15000,
      }
    );
    const results = response.data?.data || response.data?.results || [];
    if (!results.length) {
      console.log('Firecrawl search: sin resultados. Raw:', JSON.stringify(response.data).slice(0, 300));
      return null;
    }
    return results
      .map((r, i) => `[${i + 1}] ${r.title || r.url}\n${r.url}\n${(r.markdown || r.description || r.snippet || '').slice(0, 500)}`)
      .join('\n\n');
  } catch (error) {
    console.error('Error Firecrawl search:', error.message);
    return null;
  }
}

// ─────────────────────────────────────────
// CALL AI
// ─────────────────────────────────────────

// Limpia los mensajes: solo { role, content } — Groq rechaza campos extra como timestamp
function cleanMessages(messages) {
  return messages.map(m => ({ role: m.role, content: m.content }));
}

async function callAI(messages, config) {
  const headers = { 'Content-Type': 'application/json' };
  const provider = config?.provider || 'groq';
  const model = config?.model || 'llama-3.3-70b-versatile';
  const clean = cleanMessages(messages);

  if (provider === 'groq' && process.env.GROQ_API_KEY) {
    try {
      headers['Authorization'] = `Bearer ${process.env.GROQ_API_KEY}`;
      const response = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        { model, messages: clean, temperature: 0.7 },
        { headers, timeout: 30000 }
      );
      return response.data.choices[0].message.content;
    } catch (error) {
      console.error('Error Groq:', error.response?.data?.error?.message || error.message);
    }
  }

  if (provider === 'openrouter' && process.env.OPENROUTER_API_KEY) {
    try {
      headers['Authorization'] = `Bearer ${process.env.OPENROUTER_API_KEY}`;
      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        { model, messages: clean },
        { headers, timeout: 30000 }
      );
      return response.data.choices[0].message.content;
    } catch (error) { console.error('Error OpenRouter:', error.message); }
  }

  if (provider === 'ollama') {
    const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
    try {
      const response = await axios.post(
        `${ollamaUrl}/api/chat`,
        { model: model || 'qwen3:4b', messages: clean, stream: false },
        { timeout: 120000 }
      );
      return response.data.message?.content;
    } catch (error) {
      console.error('Error Ollama:', error.message);
    }
  }

  // Fallback final: Groq con modelo estable
  if (process.env.GROQ_API_KEY) {
    try {
      headers['Authorization'] = `Bearer ${process.env.GROQ_API_KEY}`;
      const response = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        { model: 'llama-3.3-70b-versatile', messages: clean, temperature: 0.7 },
        { headers, timeout: 30000 }
      );
      return response.data.choices[0].message.content;
    } catch (error) { console.error('Error fallback Groq:', error.message); }
  }

  if (process.env.OPENROUTER_API_KEY) {
    try {
      headers['Authorization'] = `Bearer ${process.env.OPENROUTER_API_KEY}`;
      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        { model: 'meta-llama/llama-3.1-8b-instruct', messages: clean },
        { headers, timeout: 30000 }
      );
      return response.data.choices[0].message.content;
    } catch (error) { console.error('Error fallback OpenRouter:', error.message); }
  }

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
// PARSEO DE COMANDOS DE CONFIGURACIÓN
// ─────────────────────────────────────────
function parseConfigCommand(text) {
  const t = text.toLowerCase();
  let provider = null;
  let model = null;

  if (t.includes('groq')) provider = 'groq';
  else if (t.includes('openrouter')) provider = 'openrouter';
  else if (t.includes('ollama')) provider = 'ollama';

  const models = {
    'llama-3.3-70b': 'llama-3.3-70b-versatile',
    'llama 3.3': 'llama-3.3-70b-versatile',
    'llama-3.1-8b': 'llama-3.1-8b-instant',
    'gemma2': 'gemma2-9b-it',
    'mixtral': 'mixtral-8x7b-32768',
    'deepseek': 'deepseek/deepseek-r1:free',
    'mistral': 'mistralai/mistral-7b-instruct:free',
    'qwen': 'qwen/qwen-2.5-72b-instruct:free',
    'qwen3:4b': 'qwen3:4b',
    'qwen3:8b': 'qwen3:8b',
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
  const results = await searchWeb(query);
  if (!results) return ctx.reply('No encontré resultados.');
  const config = await getConfig(ctx.from.id);
  const history = await getHistory(ctx.from.id);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: `${query}\n\nResultados web:\n${results}` },
  ];
  const aiReply = await callAI(messages, config);
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

  // ── Hora/fecha exacta — cálculo directo, sin inventar nada ──
  if (isTimeQuery(text)) {
    const datetime = getArgentinaDateTime();
    const reply = `🕐 En Argentina son las: *${datetime}*`;
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
    ['groq', 'openrouter', 'ollama', 'modelo'].some(k => text.toLowerCase().includes(k));

  if (isConfig) {
    const { provider, model } = parseConfigCommand(text);
    const current = await getConfig(userId);
    const newConfig = { provider: provider || current.provider, model: model || current.model };
    await saveConfig(userId, newConfig);
    return ctx.reply(
      `✅ *Configuración actualizada:*\n\n• Provider: \`${newConfig.provider}\`\n• Modelo: \`${newConfig.model}\``,
      { parse_mode: 'Markdown' }
    );
  }

  const config = await getConfig(userId);
  const history = await getHistory(userId);
  let extraContext = '';

  // ── Lectura de URLs en el mensaje ──
  const urls = extractUrls(text);
  if (urls.length > 0 && process.env.FIRECRAWL_API_KEY) {
    await ctx.reply('🌐 Leyendo el enlace...');
    for (const url of urls.slice(0, 2)) {
      const content = await scrapeUrl(url);
      if (content) extraContext += `\n\n${content}`;
    }
  }

  // ── Búsqueda web proactiva ──
  const searchKeywords = ['buscá', 'busca', 'buscame', 'investigá', 'investiga', 'precio de', 'cotización',
    'noticias', 'últimas noticias', 'qué pasó', 'que paso'];
  const isSearch = !urls.length && searchKeywords.some(k => text.toLowerCase().includes(k));

  if (isSearch && process.env.FIRECRAWL_API_KEY) {
    await ctx.reply('🔍 Buscando en la web...');
    const results = await searchWeb(text);
    if (results) extraContext += `\n\nResultados web:\n${results}`;
  }

  // ── Construcción del prompt y respuesta ──
  const userContent = extraContext
    ? `${text}\n\n⚠️ IMPORTANTE: Tenés los siguientes datos obtenidos en tiempo real. USÁ ESTA INFORMACIÓN para responder con los datos concretos que encontraste. No digas que no tenés acceso a info en tiempo real.\n${extraContext}`
    : text;
  await saveMessage(userId, 'user', text);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: userContent },
  ];
  const aiReply = await callAI(messages, config);
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
