// Push Surface for Windows: an Electron window around the status page (ui/window.html). Like the Mac app, the engine
// runs in a separate Node process (src/ipc.js, JSON lines over stdin/stdout) using the bundled runtime\node.exe,
// because the native modules it needs (MIDI, USB, canvas) are built for Node, not for Electron.
import { app, BrowserWindow, ipcMain, shell, Menu, nativeTheme } from 'electron';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, writeFileSync, mkdirSync, appendFileSync, statSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = process.env.NTPUSH_DIR || join(app.getPath('appData'), 'Push Surface');
mkdirSync(dir, { recursive: true });
app.setPath('userData', join(dir, 'electron')); // keep Chromium's cache out of the settings folder
app.setAppUserModelId('com.gregdalmata.pushsurface');

// ---- log file ----
const logPath = join(dir, 'push-surface.log');
try { if (statSync(logPath).size > 2e6) renameSync(logPath, logPath + '.old'); } catch {}
const writeLog = (s) => { try { appendFileSync(logPath, s.endsWith('\n') ? s : s + '\n'); } catch {} };
writeLog(`---- Push Surface ${app.getVersion()} started ${new Date().toISOString()}`);

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); } // MIDI ports are single-client on Windows

let win = null, child = null, lastStatus = null, configPath = join(dir, 'config.json'), quitting = false;
const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };
const toEngine = (msg) => { try { child?.stdin.write(JSON.stringify(msg) + '\n'); } catch {} };

// ---- engine process ----
function nodePath() {
  if (process.env.NTPUSH_NODE) return process.env.NTPUSH_NODE;
  const bundled = join(ROOT, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  return existsSync(bundled) ? bundled : 'node';
}
function startEngine() {
  const p = spawn(nodePath(), [join(ROOT, 'src', 'ipc.js')], {
    cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NTPUSH_DIR: dir, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined },
  });
  child = p;
  createInterface({ input: p.stdout }).on('line', (line) => {
    let m; try { m = JSON.parse(line); } catch { return writeLog(line); }
    if (m.type === 'status') { lastStatus = m.data; send('status', m.data); }
    else if (m.type === 'log') send('log', m.data);
    else if (m.type === 'config') configPath = m.data;
  });
  p.stderr.on('data', (d) => writeLog(d.toString()));
  p.on('error', (e) => { writeLog('engine: ' + e.message); send('log', 'Could not start the engine: ' + e.message); });
  p.on('exit', (code, sig) => {
    if (child === p) child = null;
    if (quitting) return;
    writeLog(`engine exited (${code ?? sig}); restarting`);
    send('log', `engine stopped (${code ?? sig}) — restarting`);
    setTimeout(() => { if (!quitting) startEngine(); }, 2000);
  });
}

ipcMain.on('mode', (_e, m) => toEngine({ cmd: 'mode', arg: m === 'demo' ? 'demo' : 'live' }));
ipcMain.on('reload', () => toEngine({ cmd: 'reload' }));
ipcMain.on('settings', () => shell.openPath(configPath));
ipcMain.on('resize', (_e, h) => {
  if (!win || typeof h !== 'number') return;
  const [w] = win.getContentSize();
  win.setContentSize(w, Math.max(200, Math.min(900, Math.round(h))));
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 440, height: 360, useContentSize: true, resizable: false, maximizable: false, fullscreenable: false,
    title: 'Push Surface', icon: join(ROOT, 'win', 'AppIcon.ico'), show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#f5f5f7',
    webPreferences: { preload: join(ROOT, 'win', 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); } });
  win.webContents.on('did-finish-load', () => { if (lastStatus) send('status', lastStatus); });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
  await win.loadFile(join(ROOT, 'ui', 'window.html'));
  startEngine();
  // build check: NTPUSH_SELFTEST=out.png captures the window after a few seconds and quits
  if (process.env.NTPUSH_SELFTEST) setTimeout(async () => {
    if (process.env.NTPUSH_SELFTEST_MODE) { toEngine({ cmd: 'mode', arg: process.env.NTPUSH_SELFTEST_MODE }); await new Promise((r) => setTimeout(r, 3000)); }
    const img = await win.webContents.capturePage();
    writeFileSync(process.env.NTPUSH_SELFTEST, img.toPNG());
    writeLog('selftest ' + JSON.stringify({ size: win.getContentSize(), status: lastStatus }));
    app.quit();
  }, 5000);
});

// closing the window quits; the engine is told to stop first so it hands the Push back
app.on('window-all-closed', () => app.quit());
app.on('before-quit', (e) => {
  if (quitting || !child) { quitting = true; return; }
  e.preventDefault();
  quitting = true;
  const p = child;
  const done = () => app.quit();
  const t = setTimeout(() => { try { p.kill(); } catch {} done(); }, 3000);
  p.once('exit', () => { clearTimeout(t); done(); });
  toEngine({ cmd: 'quit' });
});
