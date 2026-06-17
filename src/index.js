#!/usr/bin/env node

require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN no configurado');
  process.exit(1);
}

// --- MEMORIA EN ARCHIVO JSON (Sin librerías externas) ---
const MEMORY_FILE = path.join(__dirname, 'memory.json');

function loadMemory() {
  try { return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveMemory(data) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2));
}
function getHistory(userId) {
  const mem = loadMemory();
  return mem[userId] || [];
}
function saveMessage(userId, role, content) {
  const mem = loadMemory();
  if (!mem[userId]) mem[userId] = [];
  mem[userId].push({ role, content });
  if (mem[userId].length > 15) mem[userId] = mem[userId].slice(-15); // Mantener últimos 15
  saveMemory(mem);
}
function clearHistory(userId) {
  const mem = loadMemory();
  delete mem[userId];
  saveMemory(mem);
}

// SYSTEM PROMPT
const SYSTEM_PROMPT = `
Eres "OpenGravity", un asistente de inteligencia artificial de élite.
Tu usuario es un Abogado y Músico profesional. Responde siempre en español.
Tus áreas de experiencia son:
1. DERECHO: Consultas legales, redacción de escritos, jurisprudencia, contratos.
2. MÚSICA: Teoría musical, producción, negocios musicales.
3. NEGOCIOS: Desarrollo de planes de negocio, estrategias.
Responde de forma profesional, estructurada y directa.
`;

async function callAI(messages) {
  const headers = { 'Content-Type': 'application/json' };

  if (process.env.GROQ_API_KEY) {
    try {
      headers['Authorization'] = `Bearer ${process.env.GROQ_API_KEY}`;
      const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model: 'llama-3.3-70b-versatile', 
        messages: messages,
        temperature: 0.7,
      }, { headers, timeout: 30000 });
      return response.data.choices[0].message.content;
    } catch (error) { console.error('Error con Groq:', error.message); }
  }

  if (process.env.OPENROUTER_API_KEY) {
    try {
      headers['Authorization'] = `Bearer ${process.env.OPENROUTER_API_KEY}`;
      const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
        model: 'meta-llama/llama-3.1-8b-instruct:free',
        messages: messages,
      }, { headers, timeout: 30000 });
      return response.data.choices[0].message.content;
    } catch (error) { console.error('Error con OpenRouter:', error.message); }
  }

  return 'Lo siento, no hay servicios de IA disponibles.';
}

async function transcribeAudio(fileUrl) {
  try {
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    const tempPath = path.join(__dirname, `audio_${Date.now()}.ogg`);
    fs.writeFileSync(tempPath, response.data);

    const FormData = require('form-data');
    const formData = new FormData();
    formData.append('file', fs.createReadStream(tempPath));
    formData.append('model', 'whisper-large-v3');

    const res = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', formData, {
      headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, ...formData.getHeaders() },
      timeout: 30000,
    });
    fs.unlinkSync(tempPath);
    return res.data.text;
  } catch (error) {
    console.error('Error transcribiendo audio:', error.message);
    return null;
  }
}

bot.start((ctx) => {
  saveMessage(ctx.from.id, 'assistant', 'El usuario inició el bot.');
  ctx.reply('¡Hola! Soy OpenGravity. 🧠\nTu asistente legal, musical y de negocios.\n\nEnvíame un mensaje o un audio.\nUsa /clear para borrar tu historial.');
});

bot.command('clear', (ctx) => {
  clearHistory(ctx.from.id);
  ctx.reply('✅ Historial borrado.');
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  await ctx.sendChatAction('typing');
  saveMessage(userId, 'user', ctx.message.text);

  const messagesForAI = [{ role: 'system', content: SYSTEM_PROMPT }, ...getHistory(userId)];
  const aiReply = await callAI(messagesForAI);
  saveMessage(userId, 'assistant', aiReply);
  
  await ctx.reply(aiReply, { parse_mode: 'Markdown' }).catch(() => ctx.reply(aiReply));
});

bot.on('voice', async (ctx) => {
  const userId = ctx.from.id;
  await ctx.sendChatAction('typing');
  try {
    ctx.reply('🔊 Procesando audio...');
    const file = await ctx.telegram.getFile(ctx.message.voice.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    
    const transcribedText = await transcribeAudio(fileUrl);
    if (!transcribedText) return ctx.reply('❌ No pude entender el audio.');

    await ctx.reply(`🗣️ *Dijiste:* "${transcribedText}"`, { parse_mode: 'Markdown' });

    saveMessage(userId, 'user', `[Audio]: ${transcribedText}`);
    const messagesForAI = [{ role: 'system', content: SYSTEM_PROMPT }, ...getHistory(userId)];
    const aiReply = await callAI(messagesForAI);
    saveMessage(userId, 'assistant', aiReply);
    await ctx.reply(aiReply, { parse_mode: 'Markdown' }).catch(() => ctx.reply(aiReply));
  } catch (error) {
    console.error('Error en voice:', error);
    ctx.reply('Ocurrió un error procesando tu audio.');
  }
});

console.log('🚀 Iniciando OpenGravity Bot...');
bot.launch({ dropPendingUpdates: true })
  .then(() => console.log('✅ Bot conectado y escuchando mensajes.'))
  .catch(err => { console.error('❌ Fallo al iniciar:', err); process.exit(1); });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));