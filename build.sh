#!/usr/bin/env bash
# exit on error
set -o errexit

# --- УСТАНОВКА ИНСТРУМЕНТОВ ---
# Обновляем список пакетов и устанавливаем базовые утилиты
echo ">>> Updating package lists and installing core utilities..."
sudo apt-get update
sudo apt-get install -y curl software-properties-common

# --- УСТАНОВКА NODE.JS v18 ---
echo ">>> Installing Node.js v18..."
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# --- УСТАНОВКА PYTHON v3.11 ---
echo ">>> Installing Python v3.11..."
sudo add-apt-repository ppa:deadsnakes/ppa -y
sudo apt-get update
sudo apt-get install -y python3.11 python3.11-venv python3-pip ffmpeg

# --- УСТАНОВКА ЗАВИСИМОСТЕЙ ПРОЕКТА ---
# Устанавливаем Python пакеты из requirements.txt
echo ">>> Installing Python packages..."
pip3 install -r requirements.txt

# Устанавливаем Node.js пакеты
echo ">>> Installing Node.js packages..."
npm install

echo ">>> Build script finished successfully!"