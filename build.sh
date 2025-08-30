#!/usr/bin/env bash
# exit on error
set -o errexit

echo ">>> Build script started..."

# Render предоставляет несколько версий Python. Мы будем использовать python3.11.
# Если его нет, сборка упадет с ошибкой, и мы это увидим.
PYTHON_EXE="python3.11"

# Шаг 1: Создаем нашу собственную изолированную среду Python 3.11
echo ">>> Creating a Python 3.11 virtual environment in './venv'..."
$PYTHON_EXE -m venv venv

# Шаг 2: Активируем эту среду. Теперь все команды 'pip' и 'python'
# будут работать внутри нее, с правильной версией.
echo ">>> Activating the virtual environment..."
source venv/bin/activate

# Шаг 3: Устанавливаем Python зависимости в нашу изолированную среду
echo ">>> Installing Python packages from requirements.txt..."
pip install --upgrade pip
pip install -r requirements.txt

# Шаг 4: Устанавливаем Node.js зависимости
echo ">>> Installing Node.js packages..."
npm install

echo ">>> Build script finished successfully!"