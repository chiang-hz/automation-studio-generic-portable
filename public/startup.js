/* Runs in <head>, before the app DOM or modern assets can paint. */
(() => {
  const root = document.documentElement;
  const completed = new Set();
  let failed = false;
  let revealing = false;
  let message = '';
  let slow = false;

  try {
    const preference = localStorage.getItem('studio-startup-theme') || 'system';
    root.dataset.theme = preference === 'light' || preference === 'dark'
      ? preference : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    root.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function updateMessage() {
    const title = document.getElementById('studio-startup-title');
    const description = document.getElementById('studio-startup-description');
    const reload = document.getElementById('studio-startup-reload');
    const screen = document.getElementById('studio-startup');
    if (title) title.textContent = failed ? '介面載入失敗' : slow ? '介面仍在載入' : '正在載入介面';
    if (description) description.textContent = message || '正在準備工作空間，請稍候。';
    if (reload) reload.hidden = !failed && !slow;
    if (screen) screen.setAttribute('role', failed ? 'alert' : 'status');
  }

  function fail(text) {
    failed = true;
    window.clearTimeout(timeout);
    message = text || '請重新整理後再試。';
    root.dataset.studioBoot = 'failed';
    const shell = document.querySelector('.app-shell');
    if (shell) { shell.inert = true; shell.setAttribute('aria-busy', 'true'); }
    updateMessage();
  }

  function complete(part) {
    if (failed || root.dataset.studioBoot === 'ready' || !['ui', 'data', 'styles'].includes(part)) return;
    completed.add(part);
    // A cached stylesheet may finish before React calls complete('ui').
    if (document.getElementById('studio-modern-styles')?.sheet) completed.add('styles');
    if (revealing || completed.size !== 3) return;
    revealing = true;
    // Allow store updates and portal layout effects to commit before revealing.
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      if (failed) return;
      window.clearTimeout(timeout);
      const shell = document.querySelector('.app-shell');
      if (shell) { shell.inert = false; shell.setAttribute('aria-busy', 'false'); }
      root.dataset.studioBoot = 'ready';
    }));
  }

  const timeout = window.setTimeout(() => {
    slow = true;
    message = '載入時間較長，請確認服務仍在執行。可繼續等候，或重新整理後再試。';
    updateMessage();
    // Slow assets may still finish; this is not a permanent failure.
  }, 30000);
  window.studioStartup = { complete, fail };
  window.addEventListener('load', event => {
    if (event.target?.id === 'studio-modern-styles') complete('styles');
  }, true);
  window.addEventListener('error', event => {
    const target = event.target;
    if (target?.id === 'studio-base-styles' || target?.id === 'studio-modern-styles' || target?.id === 'studio-modern-script' ||
        target?.tagName === 'SCRIPT' && /\/(?:app|bridge)\.js(?:\?|$)/.test(target.src || '')) {
      fail('介面必要檔案無法載入。請重新整理；若仍失敗，確認程式檔案完整。');
    } else if (root.dataset.studioBoot !== 'ready' && event.message) {
      fail('介面初始化失敗，請重新整理後再試。');
    }
  }, true);
  window.addEventListener('unhandledrejection', () => {
    if (root.dataset.studioBoot !== 'ready') fail('介面初始化失敗，請重新整理後再試。');
  });
  document.addEventListener('DOMContentLoaded', updateMessage);
  document.addEventListener('click', event => {
    if (event.target?.id === 'studio-startup-reload') window.location.reload();
  });
})();
