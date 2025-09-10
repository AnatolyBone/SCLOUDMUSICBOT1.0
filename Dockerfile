# Минимальный образ Node 18 (Debian slim)
FROM node:18-slim

WORKDIR /app

# Сначала зависимости, чтобы кэшировалось
COPY package*.json ./
RUN npm ci --omit=dev

# Копируем исходники
COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "index.js"]