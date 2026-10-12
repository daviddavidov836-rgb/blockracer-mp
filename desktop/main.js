/* Block Racer — ПК-оболочка на Electron.
   • Игра грузится с сервера (Cloudflare), который сам обновляется из GitHub → у всех всегда свежая версия, ничего пересылать не нужно.
   • Каждая удачная загрузка кэшируется (страница игры + three.js). Нет интернета — игра открывается из кэша
     с тем же адресом, поэтому сохранения/карьера/машины не теряются.
   • Сама оболочка обновляется через GitHub Releases (electron-updater) — нужно только когда меняется этот файл. */
const { app, BrowserWindow, protocol, net, shell, session, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const GAME = 'https://blockracer-mp.daviddavidov836.workers.dev/';
const GAME_HOST = new URL(GAME).host;
const CACHE_DIR = () => path.join(app.getPath('userData'), 'game-cache');
const cacheFile = (u) => {
  const x = new URL(u);
  if (x.host === GAME_HOST && (x.pathname === '/' || x.pathname === '/index.html')) return 'game.html';
  if (x.host === 'cdnjs.cloudflare.com' || x.host === 'cdn.jsdelivr.net' || x.host === 'unpkg.com') return 'lib_' + x.pathname.replace(/[^a-z0-9._-]/gi, '_');
  return null;
};
const TYPES = { html: 'text/html; charset=utf-8', js: 'application/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json' };
const typeOf = (f) => TYPES[(f.split('.').pop() || '').toLowerCase()] || (f === 'game.html' ? TYPES.html : 'application/octet-stream');

// папка сохранений — прежняя («Block Racer»), даже после смены внутреннего имени программы (на Linux пробел в пути ломал запуск)
try { app.setName('Block Racer'); app.setPath('userData', path.join(app.getPath('appData'), 'Block Racer')); } catch (e) {}
if (!app.requestSingleInstanceLock()) { app.quit(); }

let win = null;
function createWindow() {
  win = new BrowserWindow({
    width: 1366, height: 820, minWidth: 900, minHeight: 540,
    backgroundColor: '#0a0f1a', title: 'Block Racer', autoHideMenuBar: true, show: false,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true, spellcheck: false }
  });
  Menu.setApplicationMenu(null);
  win.once('ready-to-show', () => win.show());
  // ссылки наружу — в обычном браузере
  win.webContents.setWindowOpenHandler(({ url }) => { if (!url.startsWith(GAME)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(GAME) && !url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); } });
  // клавиши: F11 — полный экран, F5 — перезагрузить (подтянуть обновление), Ctrl+Shift+I — консоль
  win.webContents.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown') return;
    if (i.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    else if (i.key === 'F5') { win.webContents.reloadIgnoringCache(); e.preventDefault(); }
    else if (i.control && i.shift && (i.key === 'I' || i.key === 'i')) { win.webContents.toggleDevTools(); e.preventDefault(); }
  });
  win.webContents.on('did-fail-load', (e, code, desc, url, main) => { if (main && url.startsWith(GAME)) win.loadFile(path.join(__dirname, 'offline.html')); });
  win.loadURL(GAME);
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(() => {
  fs.mkdirSync(CACHE_DIR(), { recursive: true });
  // разрешения: полный экран, захват мыши, звук
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(['fullscreen', 'pointerLock', 'media', 'clipboard-sanitized-write'].includes(perm)));
  // перехват https: сначала сеть (свежая версия), при ошибке — кэш
  protocol.handle('https', async (req) => {
    const f = cacheFile(req.url);
    if (!f) return net.fetch(req, { bypassCustomProtocolHandlers: true });
    const fp = path.join(CACHE_DIR(), f);
    try {
      const r = await net.fetch(req.url, { bypassCustomProtocolHandlers: true, cache: f === 'game.html' ? 'no-store' : 'default', headers: req.headers });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 1000) fs.promises.writeFile(fp, buf).catch(() => {});
      const h = new Headers(r.headers); h.delete('content-encoding'); h.delete('content-length');
      return new Response(buf, { status: r.status, headers: h });
    } catch (e) {
      if (fs.existsSync(fp)) {
        if (f === 'game.html' && win) setTimeout(() => win && win.webContents.executeJavaScript("try{toast('📴 Нет интернета — игра запущена из кэша')}catch(e){}").catch(() => {}), 2500);
        return new Response(fs.readFileSync(fp), { status: 200, headers: { 'content-type': typeOf(f) } });
      }
      throw e;
    }
  });
  createWindow();
  // обновление самой оболочки (exe) из GitHub Releases
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.on('update-downloaded', (info) => {
      dialog.showMessageBox(win, { type: 'info', buttons: ['Перезапустить', 'Позже'], title: 'Block Racer', message: 'Скачано обновление программы ' + info.version + '. Перезапустить сейчас?' })
        .then((r) => { if (r.response === 0) autoUpdater.quitAndInstall(); });
    });
    autoUpdater.checkForUpdates().catch(() => {});
  } catch (e) { /* нет electron-updater или нет релизов — не страшно */ }
});

app.on('window-all-closed', () => app.quit());
