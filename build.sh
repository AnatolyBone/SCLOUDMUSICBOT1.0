#!/usr/bin/env bash
# exit on error
set -o errexit

# Устанавливаем npm зависимости
npm install

# Обновляем yt-dlp до последней версии
pip install --upgrade yt-dlp