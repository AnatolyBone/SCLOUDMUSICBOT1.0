#!/usr/bin/env bash
# exit on error
set -o errexit

# Устанавливаем системные зависимости
echo ">>> Installing system dependencies (ffmpeg)..."
apt-get update && apt-get install -y ffmpeg

# Устанавливаем Python зависимости
echo ">>> Installing Python packages (yt-dlp, spotdl) without cache..."
pip install --upgrade pip

# ДОБАВЛЕН ФЛАГ --no-cache-dir ДЛЯ ГАРАНТИРОВАННОЙ ЧИСТОЙ УСТАНОВКИ
pip install --no-cache-dir --upgrade yt-dlp spotdl

# Устанавливаем npm зависимости
echo ">>> Installing Node.js packages..."
npm install

echo ">>> Build script finished successfully!"