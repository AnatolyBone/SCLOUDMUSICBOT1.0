#!/usr/bin/env bash
# exit on error
set -o errexit

# Устанавливаем системные зависимости
echo ">>> Installing system dependencies (ffmpeg)..."
apt-get update && apt-get install -y ffmpeg

# Устанавливаем Python зависимости ИЗ ФАЙЛА requirements.txt
echo ">>> Installing Python packages from requirements.txt..."
pip install --upgrade pip
pip install -r requirements.txt # <--- ВОТ ГЛАВНОЕ ИСПРАВЛЕНИЕ

# Устанавливаем npm зависимости
echo ">>> Installing Node.js packages..."
npm install

echo ">>> Build script finished successfully!"