// Windows shell: opens the web build (web/, copied in by CI from dist/) in a phone-shaped window.
const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');

function createWindow() {
  const win = new BrowserWindow({
    width: 460,
    height: 920,
    title: 'Tag Team Ludo',
    // The game's background colour while it loads.
    backgroundColor: '#071a4f',
    autoHideMenuBar: true,
  });
  win.removeMenu();

  // Links leave the app and open in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file:')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  win.loadFile(path.join(__dirname, 'web', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
