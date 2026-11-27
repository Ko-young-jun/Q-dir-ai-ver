const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('qdirElectron', {
  isElectron: true,
  startDrag: (filePaths) => {
    ipcRenderer.send('ondragstart', filePaths);
  },
  showItemInFolder: (targetPath) => {
    ipcRenderer.send('show-item-in-folder', targetPath);
  },
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return file?.path || '';
    }
  }
});
