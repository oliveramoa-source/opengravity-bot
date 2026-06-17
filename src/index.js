#!/usr/bin/env node

require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN is not set');
  process.exit(1);
}

// Store conversation context
const conversationContext = {};

// Helper function to call AI APIs
async function callAI(message) {
  try {
    // Try GROQ first
    if (process.env.GROQ_API_KEY) {
      try {
        const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
          model: 'mixtral-8x7b-32768',
          messages: [{ role: 'user', content: message }],
          max_tokens: 1000,
        }, {
          headers: {
            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        });
        return response.data.choices[0].message.content;
      } catch (error) {
        console.error('GROQ API error:', error.message);
      }
    }

    // Try OpenRouter
    if (process.env.OPENROUTER_API_KEY) {
      try {
        const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
          model: 'mistralai/mistral-7b-instruct',
          messages: [{ role: 'user', content: message }],
          max_tokens: 1000,
        }, {
          headers: {
            'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        });
        return response.data.choices[0].message.content;
      } catch (error) {
        console.error('OpenRouter API error:', error.message);
      }
    }

    // Fallback to Ollama if configured
    if (process.env.OLLAMA_BASE_URL) {
      try {
        const response = await axios.post(`${process.env.OLLAMA_BASE_URL}/chat/completions`, {
          model: 'mistral',
          messages: [{ role: 'user', content: message }],
          stream: false,
          temperature: 0.7,
        }, {
          timeout: 60000,
        });
        return response.data.choices[0].message.content;
      } catch (error) {
        console.error('Ollama API error:', error.message);
      }
    }

    return 'No AI service configured. Please set GROQ_API_KEY, OPENROUTER_API_KEY, or OLLAMA_BASE_URL.';
  } catch (error) {
    console.error('Error calling AI:', error.message);
    return 'Sorry, there was an error processing your request.';
  }
}

// Start command
bot.start((ctx) => {
  conversationContext[ctx.from.id] = [];
  ctx.reply(
    'Welcome to OpenGravity Bot! 🤖\n\n' +
    'I can help you with various tasks using AI.\n\n' +
    'Commands:\n' +
    '/help - Show help\n' +
    '/clear - Clear conversation history\n\n' +
    'Just send me a message and I\'ll respond!'
  );
});

// Help command
bot.command('help', (ctx) => {
  ctx.reply(
    'OpenGravity Bot Help\n\n' +
    'Features:\n' +
    '• Ask me anything and I\'ll use AI to help\n' +
    '• I maintain conversation context within a session\n' +
    '• Use /clear to reset the conversation\n\n' +
    'Available AI backends:\n' +
    '• GROQ (fast)\n' +
    '• OpenRouter (multiple models)\n' +
    '• Ollama (local)\n\n' +
    'Just type your question!'
  );
});

// Clear command
bot.command('clear', (ctx) => {
  conversationContext[ctx.from.id] = [];
  ctx.reply('Conversation history cleared! 🧹');
});

// Handle all other messages
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const userMessage = ctx.message.text;

  // Initialize or get conversation context
  if (!conversationContext[userId]) {
    conversationContext[userId] = [];
  }

  try {
    // Show typing indicator
    await ctx.sendChatAction('typing');

    // Add user message to context
    conversationContext[userId].push({
      role: 'user',
      content: userMessage,
    });

    // Build message for API
    const lastMessages = conversationContext[userId].slice(-10); // Keep last 10 messages for context

    // Call AI with context
    let aiResponse;
    try {
      const contextMessage = lastMessages.map(msg => `${msg.role}: ${msg.content}`).join('\n');
      aiResponse = await callAI(contextMessage);
    } catch (error) {
      aiResponse = await callAI(userMessage);
    }

    // Add AI response to context
    conversationContext[userId].push({
      role: 'assistant',
      content: aiResponse,
    });

    // Limit context to last 20 messages to avoid memory issues
    if (conversationContext[userId].length > 20) {
      conversationContext[userId] = conversationContext[userId].slice(-20);
    }

    // Send response (split if too long)
    if (aiResponse.length > 4096) {
      const chunks = aiResponse.match(/[\s\S]{1,4096}/g) || [];
      for (const chunk of chunks) {
        await ctx.reply(chunk);
      }
    } else {
      await ctx.reply(aiResponse);
    }
  } catch (error) {
    console.error('Error handling message:', error);
    ctx.reply('Sorry, there was an error processing your message. Please try again.');
  }
});

// Error handler
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  try {
    ctx.reply('An error occurred. Please try again later.');
  } catch (e) {
    console.error('Error sending error message:', e);
  }
});

// Launch bot
const port = process.env.PORT || 3000;
bot.launch({
  webhook: {
    domain: process.env.WEBHOOK_DOMAIN || undefined,
    port: port,
  },
}).catch(err => {
  console.error('Failed to launch bot:', err);
  process.exit(1);
});

// Health check endpoint
if (process.env.ENABLE_HTTP === 'true') {
  const http = require('http');
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });
  server.listen(port, () => {
    console.log(`HTTP health check server listening on port ${port}`);
  });
}

console.log('🤖 OpenGravity Bot started successfully');
console.log('Listening for messages...');

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down gracefully...');
  bot.stop('SIGINT');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');
  bot.stop('SIGTERM');
  process.exit(0);
});
