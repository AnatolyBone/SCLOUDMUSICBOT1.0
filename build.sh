#!/usr/bin/env bash
# exit on error
set -o errexit

# Устанавливаем системные зависимости с правами sudo
echo ">>> Installing system dependencies (ffmpeg)..."
sudo apt-get update && sudo apt-get install -y ffmpeg

# Устанавливаем Python зависимости ИЗ ФАЙЛА requirements.txt
echo ">>> Installing Python packages from requirements.txt..."
pip install --upgrade pip
pip install -r requirements.txt

# Устанавливаем npm зависимости
echo ">>> Installing Node.js packages..."
npm install

echo ">>> Build script finished successfully!"