const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('glorb', {
  quit: () => ipcRenderer.invoke('quit-app'),
  resize: (width, height) => ipcRenderer.invoke('resize-window', { width, height }),
  storeGet: (key, defaultVal) => ipcRenderer.invoke('store-get', key, defaultVal),
  storeSet: (key, value) => ipcRenderer.invoke('store-set', key, value),
  notify: (title, body) => ipcRenderer.invoke('notify', { title, body }),
  closeOnboarding: () => ipcRenderer.invoke('close-onboarding'),
  openOnboarding: () => ipcRenderer.invoke('open-onboarding'),
  onOnboardingComplete: (cb) => ipcRenderer.on('onboarding-complete', () => cb()),
  driftDetected: () => ipcRenderer.invoke('drift-detected'),
  refocusDetected: () => ipcRenderer.invoke('refocus-detected'),
  onInterventionTerminate: (cb) => ipcRenderer.on('intervention-terminate', (_e, data) => cb(data)),
  closeOverlay: () => ipcRenderer.invoke('close-overlay')
})
