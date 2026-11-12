import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron';
import { validateCampaignSave } from './src/campaign-save.js';

const gamePage = new URL('./index.html', import.meta.url);
const manualPage = fileURLToPath(new URL('./src/manual/manual.html', import.meta.url));
const preload = fileURLToPath(new URL('./preload.js', import.meta.url));
const manualFilename = 'Unterseeboot_Field_Manual.pdf';
let gameWindow;
let printingManual;
let openingManual;
let savingManual;

app.setName('Unterseeboot');
nativeTheme.themeSource = 'dark';

function isGameFrame({ sender, senderFrame }) {
  return Boolean(senderFrame && senderFrame === sender.mainFrame && senderFrame.url === gamePage.href);
}

async function replaceLocalFile(path, data) {
  const temporaryPath = join(dirname(path), `.unterseeboot-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, data, { flag: 'wx', mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

function registerCampaignStorage() {
  const directory = join(app.getPath('userData'), 'campaign');
  const path = join(directory, 'captains-log.json');
  let pending = Promise.resolve();

  function handle(channel, operation) {
    ipcMain.handle(channel, (event, data) => {
      if (!isGameFrame(event)) {
        return { ok: false, message: 'Campaign storage is only available in the game window.' };
      }

      // Serialize reads and writes so a load sees the last completed save.
      const result = pending.then(() => operation(data));
      pending = result.catch(() => {});
      return result;
    });
  }

  handle('campaign:save', async (data) => {
    let save;
    try {
      save = validateCampaignSave(data);
    } catch (error) {
      return { ok: false, message: error.message };
    }

    try {
      await mkdir(directory, { recursive: true });
      await replaceLocalFile(path, `${JSON.stringify(save, null, 2)}\n`);
      return { ok: true, path };
    } catch (error) {
      console.error('Could not write campaign save:', error);
      return { ok: false, message: 'Could not write the local campaign save.' };
    }
  });

  handle('campaign:load', async () => {
    let contents;
    try {
      contents = await readFile(path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { ok: false, message: 'No saved campaign yet.' };
      console.error('Could not read campaign save:', error);
      return { ok: false, message: 'Could not read the local campaign save.' };
    }

    try {
      const save = validateCampaignSave(JSON.parse(contents));
      return { ok: true, path, save };
    } catch (error) {
      return { ok: false, message: error instanceof SyntaxError ? 'The campaign save is not valid JSON.' : error.message };
    }
  });
}

function printFieldManual() {
  printingManual ??= (async () => {
    const window = new BrowserWindow({
      show: false,
      webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    try {
      await window.loadFile(manualPage);
      await window.webContents.executeJavaScript('document.fonts.ready.then(() => undefined)');
      return await window.webContents.printToPDF({ printBackground: true, pageSize: 'Letter', generateTaggedPDF: true });
    } finally {
      if (!window.isDestroyed()) window.destroy();
    }
  })().finally(() => { printingManual = undefined; });
  return printingManual;
}

function openGameManual() {
  openingManual ??= (async () => {
    const directory = app.getPath('userData');
    const path = join(directory, manualFilename);
    const pdf = await printFieldManual();
    await mkdir(directory, { recursive: true });
    await replaceLocalFile(path, pdf);
    const error = await shell.openPath(path);
    return error
      ? { ok: false, message: `Manual saved at ${path}. The default PDF viewer could not open it. ${error}` }
      : { ok: true, path };
  })().catch((error) => {
    console.error('Could not open the field manual:', error);
    return { ok: false, message: 'Could not generate or open the field manual.' };
  }).finally(() => { openingManual = undefined; });
  return openingManual;
}

function saveGameManualCopy() {
  savingManual ??= (async () => {
    const options = {
      title: 'Save Copy of PDF Manual',
      defaultPath: join(app.getPath('documents'), manualFilename),
      filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
      properties: ['showOverwriteConfirmation', 'createDirectory'],
    };
    const { canceled, filePath } = await (gameWindow
      ? dialog.showSaveDialog(gameWindow, options) : dialog.showSaveDialog(options));
    if (canceled || !filePath) return { ok: true, canceled: true };
    await replaceLocalFile(filePath, await printFieldManual());
    return { ok: true, path: filePath };
  })().catch((error) => {
    console.error('Could not export the field manual:', error);
    return { ok: false, message: 'Could not save the PDF manual to the selected location.' };
  }).finally(() => { savingManual = undefined; });
  return savingManual;
}

function registerManualActions() {
  for (const [channel, action] of [['open-game-manual', openGameManual], ['save-game-manual-copy', saveGameManualCopy]]) {
    ipcMain.handle(channel, (event) => isGameFrame(event)
      ? action() : { ok: false, message: 'The field manual is available from the game window.' });
  }
}

async function runManualMenuAction(action) {
  const result = await action();
  if (!result.ok) dialog.showErrorBox('Unterseeboot Field Manual', result.message);
}

function createWindow() {
  const window = new BrowserWindow({
    title: 'Unterseeboot',
    width: 1280,
    height: 800,
    useContentSize: true,
    minWidth: 820,
    minHeight: 690,
    autoHideMenuBar: true,
    backgroundColor: '#111817',
    show: false,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  gameWindow = window;
  window.on('closed', () => { gameWindow = undefined; });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  window.loadFile(fileURLToPath(gamePage)).catch((error) => {
    console.error('Could not load Unterseeboot:', error);
    app.exit(1);
  });
}

app.whenReady().then(() => {
  registerCampaignStorage();
  registerManualActions();
  ipcMain.on('quit-app', (event) => {
    if (isGameFrame(event)) app.quit();
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Unterseeboot', submenu: [{ role: 'quit' }] },
    { label: 'View', submenu: [{ role: 'togglefullscreen' }] },
    { label: 'Help', submenu: [
      { label: 'Open Field Manual', accelerator: 'F1', click: () => runManualMenuAction(openGameManual) },
      { label: 'Save Copy of PDF Manual…', click: () => runManualMenuAction(saveGameManualCopy) },
    ] },
  ]));

  createWindow();
  app.on('activate', () => {
    if (!gameWindow) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
