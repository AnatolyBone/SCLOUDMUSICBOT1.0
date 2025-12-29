---
title: Music Worker
emoji: 🎵
colorFrom: purple
colorTo: blue
sdk: docker
pinned: false
---

# 🎵 Music Download Worker

Worker for downloading music from YouTube/Spotify.
Connects to Redis queue and uploads to Telegram.

## Environment Variables

- `REDIS_URL` - Redis connection URL
- `BOT_TOKEN` - Telegram bot token
- `STORAGE_CHANNEL_ID` - Telegram channel ID for storage
- `PORT` - HTTP server port (default: 7860)
- `TEMP_DIR` - Temporary files directory (default: /tmp/music-worker)

## How it works

1. Connects to Redis queue (`music:download:queue`)
2. Waits for tasks (blocking pop)
3. Downloads track via `yt-dlp`
4. Uploads to Telegram storage channel
5. Publishes result back to Redis (`music:download:results`)
6. Sends heartbeat every 30 seconds


## Health Check!

- `GET /` - Stats endpoint
- `GET /health` - Health check endpoint

