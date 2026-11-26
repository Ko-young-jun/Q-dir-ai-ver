const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('qdirElectron', {
  isElectron: true,
  startDrag: (filePaths) => {
    ipcRenderer.send('ondragstart', filePaths);
  },
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return file?.path || '';
    }
  }
});
