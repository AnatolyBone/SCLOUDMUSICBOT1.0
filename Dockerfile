# Минимальный образ Node 20 (Debian slim)
FROM node:20-slim

WORKDIR /app

# Устанавливаем зависимости системы
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Устанавливаем зависимости Python
# --break-system-packages нужен для новых версий Debian/Ubuntu в Docker
COPY requirements.txt .
RUN pip3 install --no-cache-dir --upgrade --break-system-packages --root-user-action=ignore pip && \
    pip3 install --no-cache-dir --upgrade --break-system-packages --root-user-action=ignore -r requirements.txt && \
    pip3 install --no-cache-dir --upgrade --break-system-packages --root-user-action=ignore spotdl shazamio

# 🔥 ВАЖНО: Удаляем старый yt-dlp и ставим ночную сборку с GitHub
# Это лечит ошибку "Did not get any data blocks" и другие проблемы с YouTube
RUN pip3 uninstall -y yt-dlp || true && \
    pip3 install --no-cache-dir --upgrade --break-system-packages --root-user-action=ignore \
    https://github.com/yt-dlp/yt-dlp/archive/master.zip

# Node.js зависимости
COPY package*.json ./
RUN npm install --omit=dev

# Копируем исходники
COPY . .

# ❌ УБРАЛИ ЭТУ СТРОКУ:
# Cookies берутся из Render Secret Files → /etc/secrets/cookies.txt
# Они монтируются автоматически в runtime, копировать не нужно
# COPY cookies.txt .

ENV NODE_ENV=production
EXPOSE 10000

CMD ["node", "index.js"]