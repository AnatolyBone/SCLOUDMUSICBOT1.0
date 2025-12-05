export async function trackDownloadProcessor(task) {
  let statusMessage = null;
  let tempFilePath = null;
  const userId = parseInt(task.userId, 10);
  
  try {
    // 1. Лимиты
    const usage = await getUserUsage(userId);
    if (!usage || usage.downloads_today >= usage.premium_limit) {
      await safeSendMessage(userId, T('limitReached'));
      return;
    }

    // 2. Метаданные
    const ensured = await ensureTaskMetadata(task);
    const { metadata, cacheKey } = ensured;
    const { title, uploader, duration, webpage_url: fullUrl } = metadata;
    const roundedDuration = duration ? Math.round(duration) : undefined;
    
    if (!fullUrl) throw new Error(`Нет ссылки на трек: ${title}`);

    // 3. КЭШ
    let cached = await db.findCachedTrack(cacheKey) || await db.findCachedTrack(fullUrl);
    if (cached?.fileId) {
      console.log(`[Worker/Cache] ХИТ! Отправляю "${cached.title}" из кэша.`);
      await bot.telegram.sendAudio(userId, cached.fileId, { title: cached.title, performer: cached.artist || uploader, duration: roundedDuration });
      await incrementDownload(userId, cached.title, cached.fileId, cacheKey);
      return;
    }

    statusMessage = await safeSendMessage(userId, `⏳ Начинаю обработку: "${title}"`);
    
    let stream;
    let usedFallback = false;
    let finalFileId = null;

    // ========================================================
    // 4. СКАЧИВАНИЕ (SCDL STREAM - БЫСТРО)
    // ========================================================
    try {
        console.log(`[Worker/Stream] (SCDL) Пробую скачать: ${fullUrl}`);
        stream = await scdl.default.download(fullUrl);
        
        // === ГЛАВНОЕ ИЗМЕНЕНИЕ ЗДЕСЬ ===
        if (STORAGE_CHANNEL_ID) {
            console.log(`[Worker/Stream] Отправка в хранилище для проверки...`);
            const sentMsg = await bot.telegram.sendAudio(
                STORAGE_CHANNEL_ID,
                { source: stream, filename: `${sanitizeFilename(title)}.mp3` },
                { title, performer: uploader, duration: roundedDuration }
            );
            
            // ПРОВЕРКА ОБРУБКА СРЕДСТВАМИ ТЕЛЕГРАМА
            const realDuration = sentMsg.audio?.duration || 0;
            
            // Если трек должен быть длинным (>60 сек), а пришло меньше 35 сек
            if (roundedDuration > 60 && realDuration < 35) {
                console.warn(`[Worker] ОБРУБОК DETECTED! Ожидали ${roundedDuration}s, получили ${realDuration}s.`);
                // Удаляем плохой файл из канала
                await bot.telegram.deleteMessage(STORAGE_CHANNEL_ID, sentMsg.message_id).catch(()=>{});
                throw new Error('SCDL_INCOMPLETE_FILE'); // Вызываем ошибку, чтобы сработал YT-DLP
            }
            
            finalFileId = sentMsg.audio?.file_id;
        }
        
    } catch (scdlError) {
        // Если SCDL упал ИЛИ мы сами выбросили ошибку 'SCDL_INCOMPLETE_FILE'
        console.warn(`[Worker] Переключаюсь на YT-DLP (Причина: ${scdlError.message})...`);
        
        // YT-DLP Fallback (Медленно, но надежно)
        tempFilePath = path.join(TEMP_DIR, `dl_${Date.now()}_${userId}.mp3`);
        usedFallback = true;

        await ytdl(fullUrl, {
            output: tempFilePath,
            format: 'bestaudio[ext=mp3]/bestaudio',
            noPlaylist: true,
            ...YTDL_COMMON
        });

        if (fs.existsSync(tempFilePath)) {
            console.log(`[Worker/Fallback] Файл скачан YT-DLP: ${tempFilePath}`);
            // Создаем стрим из файла
            stream = fs.createReadStream(tempFilePath);
        } else {
            throw new Error(`YT-DLP не смог скачать файл.`);
        }
    }

    // ========================================================
    // 5. ОТПРАВКА ПОЛЬЗОВАТЕЛЮ
    // ========================================================
    
    if (finalFileId) {
        // Если уже залили в канал (успешный SCDL)
        const urlAliases = [];
        if (task.originalUrl && task.originalUrl !== fullUrl) urlAliases.push(task.originalUrl);
        if (cacheKey) urlAliases.push(cacheKey);
        
        await db.cacheTrack({ 
            url: fullUrl, 
            fileId: finalFileId, 
            title, 
            artist: uploader, 
            duration: roundedDuration, 
            thumbnail: metadata.thumbnail, 
            aliases: urlAliases 
        });
        
        await bot.telegram.sendAudio(userId, finalFileId, { title, performer: uploader, duration: roundedDuration });
        await incrementDownload(userId, title, finalFileId, task.originalUrl || fullUrl);

    } else {
        // Если сработал YT-DLP или нет канала-хранилища
        // Заливаем пользователю (или в канал, если YT-DLP)
        
        if (STORAGE_CHANNEL_ID && usedFallback) {
             // Если это был YT-DLP, зальем в канал, чтобы закэшировать нормальную версию
             const sentToStorage = await bot.telegram.sendAudio(
                STORAGE_CHANNEL_ID, 
                { source: stream, filename: `${sanitizeFilename(title)}.mp3` },
                { title, performer: uploader, duration: roundedDuration }
             );
             finalFileId = sentToStorage?.audio?.file_id;
             
             // Кэшируем "хорошую" версию
             if (finalFileId) {
                 await db.cacheTrack({ url: fullUrl, fileId: finalFileId, title, artist: uploader, duration: roundedDuration, thumbnail: metadata.thumbnail });
             }
             
             // И пользователю
             await bot.telegram.sendAudio(userId, finalFileId || { source: fs.createReadStream(tempFilePath) }, { title, performer: uploader, duration: roundedDuration });
             
        } else {
             // Прямая отправка (крайний случай)
             await bot.telegram.sendAudio(userId, { source: stream, filename: `${sanitizeFilename(title)}.mp3` }, { title, performer: uploader, duration: roundedDuration });
        }
        
        await incrementDownload(userId, title, finalFileId, task.originalUrl || fullUrl);
    }

  } catch (err) {
    console.error(`❌ Ошибка (User ${userId}):`, err.message);
    await safeSendMessage(userId, `❌ Не удалось скачать трек. Возможно, он удален или недоступен.`);
  } finally {
    if (statusMessage) try { await bot.telegram.deleteMessage(userId, statusMessage.message_id); } catch (e) {}
    if (tempFilePath && fs.existsSync(tempFilePath)) try { fs.unlinkSync(tempFilePath); } catch (e) {}
  }
}
