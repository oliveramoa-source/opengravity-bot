FROM node:20-slim

WORKDIR /app

# Instalar ffmpeg (para audios) y herramientas de compilacion (para sqlite3)
RUN apt-get update && apt-get install -y ffmpeg python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copiar e instalar dependencias
COPY package*.json ./
RUN npm install

# Copiar codigo
COPY src ./src

# Iniciar bot
CMD ["node", "src/index.js"]