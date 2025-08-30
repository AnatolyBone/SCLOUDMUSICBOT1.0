# Шаг 1: Используем официальный образ Node.js 18 как основу.
# Он построен на Debian, что позволяет легко установить правильный Python и ffmpeg.
FROM node:18-slim

# Шаг 2: Устанавливаем системные зависимости
# - python3.11 - именно та версия, которая нам нужна
# - python3-pip - для установки пакетов
# - ffmpeg - для обработки аудио
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.11 \
    python3-pip \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Шаг 3: Устанавливаем рабочую директорию внутри сервера
WORKDIR /app

# Шаг 4: Копируем файлы с зависимостями
# Это делается для оптимизации. Если эти файлы не меняются,
# Docker не будет переустанавливать всё заново при каждой сборке.
COPY package*.json ./
COPY requirements.txt ./

# Шаг 5: Устанавливаем Python зависимости из нашего файла
RUN pip3 install -r requirements.txt

# Шаг 6: Устанавливаем Node.js зависимости
RUN npm install

# Шаг 7: Копируем весь остальной код вашего проекта
COPY . .

# Шаг 8: Команда для запуска вашего бота
CMD ["node", "index.js"]