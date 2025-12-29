# 📁 Структура проекта SCloudMusicBot

## Дерево файлов и папок

```
SCLOUDMUSICBOT2.0-main/
│
├── 📄 index.js                    # Точка входа приложения (Express + Webhook)
├── 📄 bot.js                      # Основной файл бота (Telegraf handlers)
├── 📄 db.js                       # Работа с базой данных (Supabase)
├── 📄 config.js                   # Конфигурация (env переменные)
├── 📄 package.json                # Node.js зависимости
├── 📄 Dockerfile                  # Docker образ для Render.com
├── 📄 requirements.txt            # Python зависимости
├── 📄 render.yaml                 # Конфигурация Render.com
├── 📄 env.example                 # Пример переменных окружения
├── 📄 README.md                   # Основная документация
├── 📄 ARCHITECTURE.md             # Архитектура проекта
├── 📄 PROJECT_STRUCTURE.md        # Этот файл
│
├── 📂 config/                     # Конфигурационные файлы
│   ├── texts.js                   # Тексты бота (мультиязычность)
│   └── 0.txt                      # (служебный файл)
│
├── 📂 services/                   # Сервисы и бизнес-логика
│   ├── downloadManager.js         # ⭐ Центральный менеджер загрузок
│   ├── taskBroker.js              # 🔗 Брокер задач (Master ↔ Worker)
│   ├── spotifyManager.js          # Обработка Spotify ссылок
│   ├── spotifyDownloader.js       # Скачивание Spotify треков
│   ├── youtubeManager.js          # Обработка YouTube ссылок
│   ├── searchManager.js           # Умный поиск по SoundCloud
│   ├── shazamService.js           # Распознавание музыки (Shazam)
│   ├── karaokeService.js          # Создание минусовок
│   ├── lyricsService.js           # Получение текстов песен
│   ├── referralManager.js         # Реферальная система
│   ├── broadcastManager.js        # Система рассылок
│   ├── notifier.js                # Уведомления пользователям
│   ├── settingsManager.js         # Управление настройками
│   ├── appState.js                # Состояние приложения
│   ├── workerManager.js           # Управление воркерами
│   ├── redisClient.js             # Redis клиент
│   └── 0.txt                      # (служебный файл)
│
├── 📂 hf-worker/                  # 🚀 HuggingFace Worker (standalone)
│   ├── worker.js                  # Воркер для HuggingFace Spaces
│   ├── Dockerfile                 # Docker образ для HuggingFace
│   ├── package.json               # Зависимости воркера
│   └── README.md                  # Документация воркера
│
├── 📂 lib/                        # Библиотеки и утилиты
│   ├── TaskQueue.js              # Очередь задач с приоритетами
│   └── 0.txt                     # (служебный файл)
│
├── 📂 routes/                     # Express роуты (админ-панель)
│   ├── admin.js                  # Основные роуты админки
│   ├── admin-users.js            # Управление пользователями
│   ├── texts-admin.js            # Управление текстами
│   └── 0.txt                     # (служебный файл)
│
├── 📂 views/                      # EJS шаблоны (админ-панель)
│   ├── layout.ejs                # Основной layout
│   ├── login.ejs                 # Страница входа
│   ├── dashboard.ejs              # Главная страница (статистика)
│   ├── users.ejs                 # Список пользователей
│   ├── user-profile.ejs          # Профиль пользователя
│   ├── broadcasts.ejs            # Рассылки
│   ├── broadcast-form.ejs         # Форма создания рассылки
│   ├── broken-tracks.ejs         # Битые треки
│   ├── expiring-users.ejs        # Пользователи с истекающим Premium
│   ├── settings.ejs              # Настройки приложения
│   ├── texts.ejs                 # Управление текстами
│   ├── admin.ejs                 # (legacy)
│   ├── partials/                 # Частичные шаблоны
│   │   └── users-table.ejs       # Таблица пользователей
│   └── 0.txt                     # (служебный файл)
│
├── 📂 public/                     # Статические файлы
│   └── static/                   # CSS и JS для админки
│       ├── admin.css             # Стили админ-панели
│       ├── admin.js              # JavaScript админ-панели
│       └── 0.txt                 # (служебный файл)
│
├── 📂 scripts/                    # Вспомогательные скрипты
│   └── recognize.py              # Python скрипт для Shazam
│
├── 📂 src/                        # (legacy/backup)
│   ├── app.js                    # (старая версия)
│   ├── bot.js                    # (старая версия)
│   └── 0.txt                     # (служебный файл)
│
├── 📂 SCLMB/                      # (submodule/legacy)
│   └── README.md
│
├── 📄 worker.js                   # Локальный воркер (для домашнего ПК)
├── 📄 indexer.js                  # Индексатор треков
├── 📄 indexer-coop.js             # Кооперативный индексатор
├── 📄 backup.js                   # Резервное копирование
├── 📄 routes_admin_users.js       # (legacy)
└── 📄 users.json                  # (legacy/backup)

```

---

## 📋 Описание основных директорий

### 🎯 **Корень проекта**
- `index.js` - Точка входа, инициализация Express, вебхуков, фоновых задач
- `bot.js` - Все обработчики команд и сообщений Telegram
- `db.js` - Все SQL запросы к Supabase (PostgreSQL)
- `config.js` - Централизованная конфигурация

### 🎵 **services/** - Бизнес-логика
- `downloadManager.js` - **Центральный менеджер** всех загрузок
- `taskBroker.js` - **Брокер задач** для гибридной архитектуры
- `spotifyManager.js` - Обработка Spotify (меню, выбор качества)
- `spotifyDownloader.js` - Скачивание Spotify треков (pipe-стриминг)
- `youtubeManager.js` - Обработка YouTube ссылок
- Остальные сервисы - дополнительные функции

### 🚀 **hf-worker/** - Standalone воркер
- Полностью независимый модуль для HuggingFace Spaces
- Не требует основного проекта
- Скачивает через yt-dlp, загружает в Telegram

### 📊 **routes/** + **views/** - Админ-панель
- Express роуты для веб-интерфейса
- EJS шаблоны для отображения
- Управление пользователями, статистика, рассылки

### 🛠 **lib/** - Утилиты
- `TaskQueue.js` - Очередь задач с приоритетами

### 📝 **config/** - Конфигурация
- `texts.js` - Все текстовые сообщения бота

---

## 🔗 Связи между компонентами

```
index.js
  └── bot.js
      ├── services/spotifyManager.js
      ├── services/youtubeManager.js
      ├── services/searchManager.js
      └── services/downloadManager.js
          ├── services/taskBroker.js ←→ Redis ←→ hf-worker/worker.js
          ├── services/spotifyDownloader.js
          └── lib/TaskQueue.js
```

---

## 📦 Размер проекта

- **Основные файлы:** ~15 файлов
- **Сервисы:** ~16 файлов
- **Админ-панель:** ~20 файлов (роуты + шаблоны)
- **Воркер:** 4 файла (standalone)
- **Всего:** ~55+ файлов

---

## 🎯 Ключевые файлы для понимания

1. **`index.js`** - Начало работы приложения
2. **`bot.js`** - Все команды бота
3. **`services/downloadManager.js`** - Логика скачивания
4. **`services/taskBroker.js`** - Гибридная архитектура
5. **`hf-worker/worker.js`** - Standalone воркер
6. **`db.js`** - Работа с базой данных

---

## 📝 Примечания

- Файлы `0.txt` - служебные файлы (можно игнорировать)
- Папка `src/` - legacy/backup код
- Папка `SCLMB/` - submodule (можно игнорировать)
- `worker.js` в корне - локальный воркер (для домашнего ПК)
- `hf-worker/` - воркер для HuggingFace Spaces (standalone)

