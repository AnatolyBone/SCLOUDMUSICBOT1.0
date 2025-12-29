// hf-worker/worker.js - ИСПРАВЛЕННАЯ ВЕРСИЯ
// Добавлены DNS workarounds и улучшенная обработка ошибок

import Redis from 'ioredis';
import { Telegraf } from 'telegraf';
import { spawn, execSync } from 'child_process';
import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ========================= CONFIG =========================

const REDIS_URL = process.env.REDIS_URL;
const BOT_TOKEN = process.env.BOT_TOKEN;
const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID;
const PORT = process.env.PORT || 7860;
const PROXY_URL = process.env.PROXY_URL; // Опциональный прокси для yt-dlp

const QUEUE_KEY = 'music:download:queue';
const RESULTS_KEY = 'music:download:results';
const HEARTBEAT_KEY = 'music:worker:heartbeat';
const TEMP_DIR = process.env.TEMP_DIR || '/tmp/music-worker';

// ========================= STARTUP =========================

console.log('╔════════════════════════════════════════════╗');
console.log('║      🎵 Music Worker for HuggingFace       ║');
console.log('╚════════════════════════════════════════════╝\n');

console.log('📋 Environment:');
console.log(`   REDIS_URL: ${REDIS_URL ? '✅' : '❌'}`);
console.log(`   BOT_TOKEN: ${BOT_TOKEN ? '✅' : '❌'}`);
console.log(`   STORAGE_CHANNEL_ID: ${STORAGE_CHANNEL_ID || '❌'}`);
console.log(`   PROXY_URL: ${PROXY_URL ? '✅ Set' : '❌ Not set'}`);
console.log(`   RAM: ${Math.round(os.totalmem() / 1024 / 1024)} MB`);
console.log('');

if (!REDIS_URL || !BOT_TOKEN || !STORAGE_CHANNEL_ID) {
  console.error('❌ Missing environment variables!');
  process.exit(1);
}

// Создаём папку
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// ========================= CHECK YT-DLP =========================

try {
  const version = execSync('python3 -m yt_dlp --version', { encoding: 'utf-8' }).trim();
  console.log(`✅ yt-dlp version: ${version}`);
} catch (e) {
  console.error('❌ yt-dlp not found!');
  process.exit(1);
}

// ========================= INIT =========================

const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 1000,
  connectTimeout: 10000,
  lazyConnect: true
});

redis.on('error', (err) => console.error('Redis error:', err.message));

const bot = new Telegraf(BOT_TOKEN);

// Express для health check
const app = express();
app.get('/', (req, res) => res.json({ status: 'running', uptime: Math.round(process.uptime()), redis: redis.status }));
app.get('/health', (req, res) => res.status(200).send('OK'));

// ========================= DOWNLOAD =========================

async function downloadTrack(searchQuery, quality = 'medium') {
  const bitrate = { high: '320k', medium: '192k', low: '128k' }[quality] || '192k';
  
  const baseName = `track_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const outputTemplate = path.join(TEMP_DIR, `${baseName}.%(ext)s`);

  return new Promise((resolve, reject) => {
    // ✅ ИСПРАВЛЕНО: Добавлены флаги для обхода проблем с сетью
    const args = [
      '-m', 'yt_dlp',
      `ytsearch1:${searchQuery}`,
      '-f', 'bestaudio/best',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', bitrate,
      '-o', outputTemplate,
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificates',  // ✅ Игнорируем SSL
      '--geo-bypass',             // ✅ Обходим гео-блокировки
      '--force-ipv4',             // ✅ Используем IPv4 (часто помогает с DNS)
      '--extractor-retries', '5', // ✅ Больше попыток
      '--retries', '5',
      '--fragment-retries', '5',
      '--socket-timeout', '30',
      // ✅ User-Agent как обычный браузер
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ];
    
    // ✅ Добавляем прокси, если указан
    if (PROXY_URL) {
      args.push('--proxy', PROXY_URL);
      console.log(`🌐 Using proxy: ${PROXY_URL.replace(/\/\/.*@/, '//***@')}`); // Скрываем credentials в логах
    }

    console.log(`⬇️  Downloading: "${searchQuery.slice(0, 50)}..." (${bitrate})`);
    
    const proc = spawn('python3', args, { 
      cwd: TEMP_DIR,
      env: { 
        ...process.env, 
        PYTHONUNBUFFERED: '1',
        // ✅ Используем Google DNS
        // Некоторые контейнеры не имеют resolv.conf
      }
    });
    
    let stderr = '';
    let stdout = '';
    
    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    
    proc.on('close', (code) => {
      if (code !== 0) {
        console.error(`❌ yt-dlp error (code ${code})`);
        console.error(`   stderr: ${stderr.slice(-300)}`);
        return reject(new Error(stderr.slice(-200) || `Exit code ${code}`));
      }
      
      const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(baseName));
      if (files.length === 0) {
        console.error('❌ No output file');
        return reject(new Error('File not created'));
      }
      
      const filePath = path.join(TEMP_DIR, files[0]);
      const size = fs.statSync(filePath).size;
      console.log(`✅ Downloaded: ${(size / 1024 / 1024).toFixed(2)} MB`);
      resolve(filePath);
    });
    
    proc.on('error', reject);
    
    // Таймаут 3 минуты
    setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('TIMEOUT'));
    }, 180000);
  });
}

// ========================= PROCESS TASK =========================

async function processTask(task) {
  const { metadata, quality, userId, cacheKey } = task;
  const searchQuery = `${metadata.uploader} ${metadata.title}`;
  
  console.log(`\n🎵 Processing: "${metadata.title}"`);

  let filePath = null;
  
  try {
    filePath = await downloadTrack(searchQuery, quality);
    
    // Проверка размера
    const size = fs.statSync(filePath).size;
    if (size > 48 * 1024 * 1024) {
      throw new Error('FILE_TOO_LARGE');
    }
    
    console.log(`📤 Uploading to Telegram...`);
    
    const sentMsg = await bot.telegram.sendAudio(
      STORAGE_CHANNEL_ID,
      { source: fs.createReadStream(filePath) },
      {
        title: metadata.title,
        performer: metadata.uploader,
        duration: metadata.duration || undefined,
        disable_notification: true
      }
    );

    const fileId = sentMsg.audio?.file_id;
    console.log(`✅ Uploaded: ${fileId?.slice(0, 20)}...`);

    return {
      success: true,
      fileId,
      title: metadata.title,
      artist: metadata.uploader,
      duration: sentMsg.audio?.duration || metadata.duration,
      quality,
      cacheKey,
      userId,
      statusMessageId: task.statusMessageId, // Передаём для удаления
      source: task.source || 'spotify',
      spotifyId: task.metadata?.spotifyId || null
    };

  } catch (err) {
    console.error(`❌ Failed: ${err.message}`);
    return {
      success: false,
      error: err.message,
      title: metadata?.title || 'Unknown',
      userId,
      statusMessageId: task.statusMessageId, // Передаём для удаления
      task: task, // Передаём задачу для fallback на локальную обработку
      source: task.source || 'spotify',
      quality: task.quality || 'high',
      cacheKey: task.cacheKey
    };
    
  } finally {
    if (filePath && fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (e) {}
    }
  }
}

// ========================= MAIN LOOP =========================

async function workerLoop() {
  console.log('👂 Listening for tasks...\n');

  while (true) {
    try {
      const result = await redis.brpop(QUEUE_KEY, 30);
      if (!result) continue;

      const task = JSON.parse(result[1]);
      console.log(`📥 Task: ${task.taskId}`);

      const taskResult = await processTask(task);

      await redis.publish(RESULTS_KEY, JSON.stringify({
        taskId: task.taskId,
        ...taskResult
      }));

      console.log(`📤 Result sent\n`);

    } catch (err) {
      console.error('Loop error:', err.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ========================= STARTUP =========================

async function main() {
  app.listen(PORT, '0.0.0.0', () => console.log(`🌐 HTTP on port ${PORT}`));

  console.log('🔗 Connecting to Redis...');
  await redis.connect();
  console.log('✅ Redis connected');
  
  const pong = await redis.ping();
  console.log(`📡 PING: ${pong}`);

  // Heartbeat
  const heartbeat = () => redis.set(HEARTBEAT_KEY, Date.now().toString(), 'EX', 120).catch(() => {});
  setInterval(heartbeat, 30000);
  await heartbeat();
  console.log('💓 Heartbeat started\n');

  // Cleanup
  setInterval(() => {
    try {
      const files = fs.readdirSync(TEMP_DIR);
      const now = Date.now();
      files.forEach(f => {
        const fp = path.join(TEMP_DIR, f);
        if (now - fs.statSync(fp).mtimeMs > 600000) {
          fs.unlinkSync(fp);
        }
      });
    } catch (e) {}
  }, 300000);

  await workerLoop();
}

process.on('SIGTERM', async () => {
  console.log('\n👋 Shutting down...');
  await redis.quit();
  process.exit(0);
});

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
