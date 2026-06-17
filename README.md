# OpenGravity Bot

A powerful Telegram bot powered by multiple AI backends including GROQ, OpenRouter, and Ollama.

## Features

- 🤖 AI-powered responses using GROQ, OpenRouter, or Ollama
- 💬 Multi-turn conversation with context awareness
- 🔒 Secure environment variable management
- 📱 Telegram bot integration
- 🚀 Production-ready with Railway deployment
- ⚕️ Health checks and graceful shutdown

## Prerequisites

1. **Telegram Bot Token**: Create a bot with [@BotFather](https://t.me/botfather) on Telegram
2. **At least one AI API Key**:
   - GROQ: Get from [https://console.groq.com](https://console.groq.com)
   - OpenRouter: Get from [https://openrouter.ai](https://openrouter.ai)
   - Ollama: Local instance (optional)

## Local Development

### Setup

```bash
# Clone the repository
git clone https://github.com/oliveramoa-source/opengravity-bot.git
cd opengravity-bot

# Install dependencies
npm install

# Create .env file
cp .env.example .env

# Add your credentials to .env
# TELEGRAM_BOT_TOKEN=your_token
# GROQ_API_KEY=your_key
# OPENROUTER_API_KEY=your_key
```

### Running Locally

```bash
# Start the bot
npm start

# For development with auto-reload
npm run dev
```

## Railway Deployment

### Option 1: Via Railway Dashboard

1. Go to [Railway Dashboard](https://railway.app)
2. Create a new project
3. Connect your GitHub repository (fork this one)
4. Select the repository
5. Railway will auto-detect the Dockerfile
6. Add environment variables:
   - `TELEGRAM_BOT_TOKEN`
   - `GROQ_API_KEY` (or `OPENROUTER_API_KEY`)
7. Deploy

### Option 2: Via Railway CLI

```bash
# Install Railway CLI
npm i -g @railway/cli

# Login
railway login

# Link project
railway link

# Set environment variables
railway variables set TELEGRAM_BOT_TOKEN=your_token
railway variables set GROQ_API_KEY=your_key

# Deploy
railway up
```

### Environment Variables on Railway

Set these in your Railway project settings:

| Variable | Required | Source |
|----------|----------|--------|
| `TELEGRAM_BOT_TOKEN` | Yes | [@BotFather](https://t.me/botfather) |
| `GROQ_API_KEY` | No* | [Groq Console](https://console.groq.com) |
| `OPENROUTER_API_KEY` | No* | [OpenRouter](https://openrouter.ai) |
| `OLLAMA_BASE_URL` | No | Local Ollama instance |
| `NODE_ENV` | No | Set to `production` |
| `PORT` | No | Railway sets automatically |

*At least one AI backend is required (GROQ or OpenRouter recommended)

## Docker

### Build Locally

```bash
docker build -t opengravity-bot:latest .
```

### Run with Docker

```bash
docker run -e TELEGRAM_BOT_TOKEN=your_token \
           -e GROQ_API_KEY=your_key \
           opengravity-bot:latest
```

### Run with Docker Compose

```bash
docker-compose up --build
```

## Commands

- `/start` - Start the bot and show welcome message
- `/help` - Show help and available features
- `/clear` - Clear conversation history

## Supported Models

### GROQ
- `mixtral-8x7b-32768` (Default)
- Low latency, high throughput

### OpenRouter
- `mistralai/mistral-7b-instruct` (Default)
- Access to multiple models through one API

### Ollama
- Local AI models
- `mistral` (Default)
- No API keys required

## Troubleshooting

### Bot not responding

1. Check `TELEGRAM_BOT_TOKEN` is correct (get from [@BotFather](https://t.me/botfather))
2. Verify at least one AI API key is set
3. Check Railway logs for errors
4. Ensure environment variables are set correctly

### API Errors

1. **GROQ**: Check quota at [console.groq.com](https://console.groq.com)
2. **OpenRouter**: Verify API key and account balance
3. **Ollama**: Ensure local instance is running on correct port

### Railway Deployment Issues

1. Check build logs in Railway dashboard
2. Verify all environment variables are set
3. Ensure repository has `Dockerfile`
4. Check application logs in Railway dashboard

## Architecture

```
User Message
    ↓
Telegram Bot (Telegraf)
    ↓
Message Handler
    ↓
AI Backend Router
    ├─ GROQ API
    ├─ OpenRouter API
    └─ Ollama Local
    ↓
Response (with Context)
    ↓
Send to Telegram User
```

## Performance

- **GROQ**: 0-5s response time (recommended)
- **OpenRouter**: 5-15s response time
- **Ollama**: 10-30s response time (depends on hardware)

## Security Notes

- Never commit `.env` files
- Use Railway's secret management for credentials
- Bot runs as non-root user in container
- All API communications use HTTPS

## License

MIT

## Support

For issues or questions:
1. Check the troubleshooting section
2. Review Railway logs
3. Check API provider status
4. Open an issue on GitHub

## Contributing

Contributions are welcome! Please fork and submit pull requests.

---

**Happy botting!** 🚀
