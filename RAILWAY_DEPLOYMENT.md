# Railway Deployment Guide

This guide provides step-by-step instructions to deploy OpenGravity Bot to Railway.

## Prerequisites

1. GitHub account with access to the repository
2. Railway account ([sign up here](https://railway.app))
3. API keys for at least one AI service

## Obtaining Required Credentials

### 1. Telegram Bot Token

1. Open Telegram and search for [@BotFather](https://t.me/botfather)
2. Send `/start` and then `/newbot`
3. Follow the prompts to create your bot
4. Copy the bot token provided (format: `123456789:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)

### 2. GROQ API Key (Recommended - Fastest)

1. Go to [https://console.groq.com](https://console.groq.com)
2. Sign up or log in
3. Navigate to API Keys section
4. Create a new API key
5. Copy the key

### 3. OpenRouter API Key (Alternative)

1. Go to [https://openrouter.ai](https://openrouter.ai)
2. Sign up or log in
3. Go to keys page
4. Create and copy your API key

## Step-by-Step Railway Deployment

### Method 1: Via Railway Dashboard (Easiest)

1. **Log in to Railway**
   - Go to [https://railway.app](https://railway.app)
   - Click "Login" and use GitHub
   - Authorize Railway to access your GitHub account

2. **Create New Project**
   - Click "+ New Project"
   - Select "Deploy from GitHub repo"

3. **Select Repository**
   - Search for `opengravity-bot`
   - Select the repository
   - Click "Deploy"

4. **Wait for Auto-Detection**
   - Railway will detect the Dockerfile
   - Initial build will start automatically

5. **Configure Environment Variables**
   - After deployment starts, go to project settings
   - Click "Variables"
   - Add each variable:

   | Variable | Value |
   |----------|-------|
   | `TELEGRAM_BOT_TOKEN` | Your bot token from @BotFather |
   | `GROQ_API_KEY` | Your GROQ API key |
   | `NODE_ENV` | `production` |

6. **Start the Service**
   - Click the service name
   - Click "Deploy"
   - Wait for build to complete
   - Bot should now be running

### Method 2: Via Railway CLI

1. **Install Railway CLI**
   ```bash
   npm install -g @railway/cli
   ```

2. **Login to Railway**
   ```bash
   railway login
   ```

3. **Link to Your Project**
   ```bash
   railway link
   ```
   - Select your project from the list

4. **Set Environment Variables**
   ```bash
   railway variables set TELEGRAM_BOT_TOKEN=your_token_here
   railway variables set GROQ_API_KEY=your_groq_key_here
   railway variables set NODE_ENV=production
   ```

5. **Deploy**
   ```bash
   railway up
   ```

6. **View Logs**
   ```bash
   railway logs -f
   ```

## Verification

After deployment:

1. **Check Logs**
   - In Railway dashboard, click your service
   - View "Logs" tab
   - Should see: `🤖 OpenGravity Bot started successfully`

2. **Test the Bot**
   - Open Telegram
   - Search for your bot name
   - Send `/start`
   - Bot should respond with welcome message

3. **Check Health Status**
   - Bot should be in "Running" state
   - No error messages in logs

## Environment Variables Reference

### Required Variables

- **TELEGRAM_BOT_TOKEN**: Your Telegram bot token (required)
- At least one AI API: **GROQ_API_KEY** or **OPENROUTER_API_KEY** (required)

### Optional Variables

- **NODE_ENV**: Set to `production` for deployment
- **OLLAMA_BASE_URL**: If using local Ollama instance
- **ENABLE_HTTP**: Set to `true` for health checks

## Troubleshooting

### Bot not responding in Telegram

1. Check bot token is correct (from @BotFather)
2. Verify environment variables are set
3. Check Railway logs for errors:
   ```
   ERROR: TELEGRAM_BOT_TOKEN is not set
   ```

### Build failing on Railway

1. Check Dockerfile is present in repository
2. Verify package.json exists
3. Check build logs in Railway dashboard
4. Ensure all files were committed to GitHub

### API errors

**GROQ errors:**
- Verify API key is correct
- Check GROQ quota at [console.groq.com](https://console.groq.com)
- Ensure account has available credits

**OpenRouter errors:**
- Verify API key validity
- Check account balance
- Ensure at least $0.01 credit available

### Memory issues

1. Railway provides limited memory
2. Bot maintains conversation history for up to 20 messages per user
3. For many concurrent users, consider upgrading Railway plan

## Updating Your Bot

### Update Code

1. Make changes locally
2. Commit and push to GitHub:
   ```bash
   git add .
   git commit -m "Your change description"
   git push
   ```
3. Railway will automatically trigger rebuild

### Update Environment Variables

1. Go to Railway project settings
2. Click "Variables"
3. Update values
4. Changes take effect after service restart

## Monitoring

### Via Railway Dashboard

1. Check service status (green = running)
2. View resource usage (CPU, memory)
3. Check logs for errors
4. Monitor uptime metrics

### Via CLI

```bash
# View status
railway status

# Stream logs
railway logs -f

# View environment variables
railway variables list
```

## Scaling

Railway automatically handles:
- Bot restarts on crash
- Memory management
- Resource allocation

For growth:
- Monitor Railway usage in dashboard
- Upgrade plan if needed
- Consider load balancing if multiple instances needed

## Support

For issues:
1. Check [Railway documentation](https://docs.railway.app)
2. Review bot logs
3. Verify API keys are valid
4. Check repository README for troubleshooting

---

Your bot is now deployed and running 24/7 on Railway!
