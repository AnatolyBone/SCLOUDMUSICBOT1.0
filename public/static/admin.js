// public/admin.js (улучшенная версия)

(function() {
  'use strict';

  // ========================= THEME MANAGEMENT =========================
  
  const root = document.documentElement;
  const STORAGE_KEY = 'theme';
  
  /**
   * Получает сохранённую тему или определяет по системным настройкам
   */
  function getInitialTheme() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
    
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  
  /**
   * Применяет тему к документу
   */
  function applyTheme(theme) {
    root.setAttribute('data-theme', theme);
    localStorage.setItem(STORAGE_KEY, theme);
    
    // Обновляем иконку кнопки (если есть)
    const themeIcon = document.querySelector('#themeToggle i');
    if (themeIcon) {
      themeIcon.className = theme === 'dark' ? 'bi bi-sun-fill' : 'bi bi-moon-fill';
    }
  }
  
  /**
   * Переключает тему
   */
  function toggleTheme() {
    const current = root.getAttribute('data-theme');
    const newTheme = current === 'dark' ? 'light' : 'dark';
    applyTheme(newTheme);
  }
  
  // Устанавливаем начальную тему ДО загрузки DOM (чтобы не было мигания)
  applyTheme(getInitialTheme());
  
  // ========================= ALERTS AUTO-HIDE =========================
  
  /**
   * Автоматически скрывает уведомления через заданное время
   */
  function initAutoHideAlerts() {
    document.querySelectorAll('.alert[data-autohide]').forEach(el => {
      const delay = parseInt(el.dataset.autohide, 10) || 4000;
      
      // Добавляем анимацию fade-out перед скрытием
      setTimeout(() => {
        el.style.transition = 'opacity 0.3s ease-out';
        el.style.opacity = '0';
        
        // Скрываем через 300ms после начала анимации
        setTimeout(() => {
          el.classList.add('d-none');
          el.remove(); // Удаляем из DOM для очистки
        }, 300);
      }, delay);
    });
  }
  
  // ========================= CHARTS HELPERS =========================
  
  /**
   * Форматирует большие числа (например, 1234 -> 1.2k)
   */
  window.formatNumber = function(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
    return num.toString();
  };
  
  /**
   * Создаёт градиент для графиков Chart.js
   */
  window.createGradient = function(ctx, color1, color2) {
    const gradient = ctx.createLinearGradient(0, 0, 0, 400);
    gradient.addColorStop(0, color1);
    gradient.addColorStop(1, color2);
    return gradient;
  };
  
  // ========================= INITIALIZATION =========================
  
  /**
   * Инициализация после загрузки DOM
   */
  function init() {
    console.log('[Admin] Инициализация...');
    
    // Подключаем переключатель темы
    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) {
      themeToggle.addEventListener('click', toggleTheme);
      console.log('[Admin] Переключатель темы активирован');
    } else {
      console.warn('[Admin] Кнопка переключения темы не найдена');
    }
    
    // Запускаем автоскрытие уведомлений
    initAutoHideAlerts();
    
    // Добавляем обработчик для форм поиска (если есть)
    const searchForm = document.querySelector('form[role="search"]');
    if (searchForm) {
      searchForm.addEventListener('submit', (e) => {
        const input = searchForm.querySelector('input[name="q"]');
        if (!input?.value.trim()) {
          e.preventDefault();
          input?.focus();
        }
      });
    }
    
    // Добавляем подтверждение для опасных действий
    document.querySelectorAll('[data-confirm]').forEach(el => {
      el.addEventListener('click', (e) => {
        const message = el.dataset.confirm || 'Вы уверены?';
        if (!confirm(message)) {
          e.preventDefault();
        }
      });
    });
    
    console.log('[Admin] Инициализация завершена');
  }
  
  // ========================= EVENT LISTENERS =========================
  
  // Инициализация после полной загрузки DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // DOM уже загружен
    init();
  }
  
  // Слушаем изменения системной темы
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    // Применяем только если пользователь не выбрал тему вручную
    if (!localStorage.getItem(STORAGE_KEY)) {
      applyTheme(e.matches ? 'dark' : 'light');
    }
  });
  
})();