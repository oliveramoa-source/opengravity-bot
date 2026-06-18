#!/usr/bin/env node

// IMPORTANTE: dotenv debe cargar ANTES que cualquier otra cosa
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { Telegraf } = require('telegraf');
const axios = require('axios');
const fs = require('fs');

// ─────────────────────────────────────────
// FIREBASE ADMIN
// ─────────────────────────────────────────
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
});

const db = getFirestore();

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
`;

// ─────────────────────────────────────────
// BÚSQUEDA WEB CON FIRECRAWL
// ─────────────────────────────────────────
async function searchWeb(query) {
  if (!process.env.FIRECRAWL_API_KEY) return null;
  try {
    const response = await axios.post(
      'https://api.firecrawl.dev/v1/search',
      { query, limit: 3 },
      {
        headers: {
          Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );
    const results = response.data?.data || [];
    if (!results.length) return null;
    return results
      .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.markdown?.slice(0, 500) || ''}`)
      .join('\n\n');
  } catch (error) {
    console.error('Error Firecrawl:', error.message);
    return null;
  }
}

// ─────────────────────────────────────────
// CALL AI
// ─────────────────────────────────────────
async function callAI(messages, config) {
  const headers = { 'Content-Type': 'application/json' };
  const provider = config?.provider || 'groq';
  const model = config?.model || 'llama-3.3-70b-versatile';

  if (provider === 'groq' && process.env.GROQ_API_KEY) {
    try {
      headers['Authorization'] = `Bearer ${process.env.GROQ_API_KEY}`;
      const response = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        { model, messages, temperature: 0.7 },
        { headers, timeout: 30000 }
      );
      return response.data.choices[0].message.content;
    } catch (error) { console.error('Error Groq:', error.message); }
  }

  if (provider === 'openrouter' && process.env.OPENROUTER_API_KEY) {
    try {
      headers['Authorization'] = `Bearer ${process.env.OPENROUTER_API_KEY}`;
      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        { model, messages },
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
        { model: model || 'qwen3:4b', messages, stream: false },
        { timeout: 120000 }
      );
      return response.data.message?.content;
    } catch (error) {
      console.error('Error Ollama:', error.message);
      if (process.env.GROQ_API_KEY) {
        try {
          headers['Authorization'] = `Bearer ${process.env.GROQ_API_KEY}`;
          const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            { model: 'llama-3.3-70b-versatile', messages, temperature: 0.7 },
            { headers, timeout: 30000 }
          );
          return `[Ollama no disponible — usando Groq]\n\n${response.data.choices[0].message.content}`;
        } catch (e) { console.error('Error fallback Groq:', e.message); }
      }
    }
  }

  if (process.env.OPENROUTER_API_KEY) {
    try {
      headers['Authorization'] = `Bearer ${process.env.OPENROUTER_API_KEY}`;
      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        { model: 'meta-llama/llama-3.1-8b-instruct:free', messages },
        { headers, timeout: 30000 }
      );
      return `[Fallback OpenRouter]\n\n${response.data.choices[0].message.content}`;
    } catch (error) { console.error('Error fallback OpenRouter:', error.message); }
  }

  return 'Lo siento, no hay servicios de IA disponibles en este momento.';
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
  await ctx.reply(aiReply, { parse_mode: 'Markdown' }).catch(() => ctx.reply(aiReply));
});

// ─────────────────────────────────────────
// MENSAJES DE TEXTO
// ─────────────────────────────────────────
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;
  await ctx.sendChatAction('typing');

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

  const searchKeywords = ['buscá', 'busca', 'buscame', 'investigá', 'investiga', 'precio de', 'cotización'];
  const isSearch = searchKeywords.some(k => text.toLowerCase().includes(k));

  if (isSearch && process.env.FIRECRAWL_API_KEY) {
    await ctx.reply('🔍 Buscando en la web...');
    const results = await searchWeb(text);
    if (results) {
      const config = await getConfig(userId);
      const history = await getHistory(userId);
      const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...history,
        { role: 'user', content: `${text}\n\nResultados web:\n${results}` },
      ];
      const aiReply = await callAI(messages, config);
      await saveMessage(userId, 'user', text);
      await saveMessage(userId, 'assistant', aiReply);
      return ctx.reply(aiReply, { parse_mode: 'Markdown' }).catch(() => ctx.reply(aiReply));
    }
  }

  await saveMessage(userId, 'user', text);
  const config = await getConfig(userId);
  const history = await getHistory(userId);
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...history];
  const aiReply = await callAI(messages, config);
  await saveMessage(userId, 'assistant', aiReply);
  await ctx.reply(aiReply, { parse_mode: 'Markdown' }).catch(() => ctx.reply(aiReply));
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
    await saveMessage(userId, 'user', `[Audio]: ${transcribed}`);
    const config = await getConfig(userId);
    const history = await getHistory(userId);
    const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...history];
    const aiReply = await callAI(messages, config);
    await saveMessage(userId, 'assistant', aiReply);
    await ctx.reply(aiReply, { parse_mode: 'Markdown' }).catch(() => ctx.reply(aiReply));
  } catch (error) {
    console.error('Error en voice:', error);
    ctx.reply('Ocurrió un error procesando tu audio.');
  }
});

// ─────────────────────────────────────────
// ARRANQUE
// ─────────────────────────────────────────
console.log('🚀 Iniciando OpenGravity Bot...');
bot.launch({ dropPendingUpdates: true })
  .then(() => console.log('✅ Bot conectado y escuchando mensajes.'))
  .catch(err => { console.error('❌ Fallo al iniciar:', err); process.exit(1); });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
