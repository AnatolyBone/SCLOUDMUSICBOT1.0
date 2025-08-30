#!/usr/bin/env bash
# exit on error
set -o errexit

# ================================ ГЛАВНОЕ ИСПРАВЛЕНИЕ ================================
# Блокируем azlyrics.com, чтобы предотвратить ошибку 'TooManyRedirects' при запуске spotdl.
# Это заставит spotdl проигнорировать неработающий провайдер текстов и продолжить выполнение.
echo ">>> Blocking azlyrics.com to prevent spotdl crash..."
echo "127.0.0.1 www.azlyrics.com" >> /etc/hosts
# =====================================================================================

# Устанавливаем системные зависимости
echo ">>> Installing system dependencies (ffmpeg)..."
apt-get update && apt-get install -y ffmpeg

# Устанавливаем Python зависимости
echo ">>> Installing Python packages (yt-dlp, spotdl) without cache..."
pip install --upgrade pip
pip install --no-cache-dir --upgrade yt-dlp spotdl

# Устанавливаем npm зависимости
echo ">>> Installing Node.js packages..."
npm install

echo ">>> Build script finished successfully!"