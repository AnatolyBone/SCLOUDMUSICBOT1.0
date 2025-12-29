FROM node:20-slim

# Системные зависимости
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp (последняя версия)
RUN pip3 install --break-system-packages --no-cache-dir yt-dlp

# Рабочая директория
WORKDIR /app

# Зависимости Node.js
COPY package*.json ./
RUN npm install --production

# Код
COPY . .

# Создаём папку для временных файлов
RUN mkdir -p /tmp/music-worker

# Переменные окружения
ENV NODE_ENV=production
ENV TEMP_DIR=/tmp/music-worker

# Порт для health check (HuggingFace требует)
EXPOSE 7860

# Используем Google DNS
RUN echo "nameserver 8.8.8.8" > /etc/resolv.conf && \
    echo "nameserver 8.8.4.4" >> /etc/resolv.conf

# Запуск
CMD ["node", "worker.js"]

