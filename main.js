const { app, BrowserWindow, Tray, nativeImage, ipcMain, globalShortcut, Notification, screen } = require('electron')
const path = require('path')
const { execFile } = require('child_process')
const net = require('net')
const fs = require('fs')
const Store = require('electron-store')
const store = new Store()
const appMonitor = require('./detect/appMonitor')

// Phase 8 — macOS system sound paths (D-01: afplay only, no bundled files)
const SND = {
  chime: '/System/Library/Sounds/Glass.aiff',
  note1: '/System/Library/Sounds/Tink.aiff',
  note2: '/System/Library/Sounds/Pop.aiff',
  note3: '/System/Library/Sounds/Morse.aiff',
  note4: '/System/Library/Sounds/Blow.aiff',
  note5: '/System/Library/Sounds/Sosumi.aiff'
}

function playSound (filePath) {
  execFile('afplay', [filePath], { timeout: 10000 }, () => {})
}

function playNotes (count) {
  const sounds = [SND.note1, SND.note2, SND.note3, SND.note4, SND.note5].slice(0, count)
  sounds.forEach((s, i) => {
    trackTimeout(() => playSound(s), i * 300)
  })
}

let tray = null
let win = null
let onboardingWin = null
let detectorWin = null

function triggerDrift () {
  driftCount++
  const strength = store.get('strength', 'weak')
  const hasADHD = store.get('hasADHD', false)
  runPath(`${strength === 'strong' ? 'strong' : 'weak'}-${hasADHD ? 'adhd' : 'regular'}`)
}

function triggerRefocus () {
  if (driftCount > 0) {
    new Notification({ title: 'Glorb Timer', body: 'Focus regained.' }).show()
  }
  driftCount = 0
  clearAllTimers()
}

// Phase 8 — CLI IPC socket (D-12: dev-only, Unix domain socket)
const SOCK_PATH = '/tmp/glorb-ipc.sock'

// Phase 8 — Intervention state machine (D-09: all state in main process)
let driftCount = 0
const escalationTimers = []  // D-11: store all setTimeout/setInterval refs here
let overlayWin = null        // shared ref for overlay BrowserWindow (Plans 03/04)

function clearAllTimers () {
  while (escalationTimers.length) {
    const ref = escalationTimers.pop()
    if (ref && ref._isInterval) clearInterval(ref)
    else clearTimeout(ref)
  }
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.close()
    overlayWin = null
  }
}

function trackTimeout (fn, ms) {
  const id = setTimeout(fn, ms)
  escalationTimers.push(id)
  return id
}
function trackInterval (fn, ms) {
  const id = setInterval(fn, ms)
  id._isInterval = true
  escalationTimers.push(id)
  return id
}

// Phase 8 — Path dispatcher (D-10: called from IPC handlers and CLI socket)
// pathId: 'weak-regular' | 'weak-adhd' | 'strong-regular' | 'strong-adhd'
// Implementations filled in by Plans 02 and 03.
function runPath (pathId) {
  switch (pathId) {
    case 'weak-regular':   return runWeakRegular()
    case 'weak-adhd':      return runWeakADHD()
    case 'strong-regular': return runStrongRegular()
    case 'strong-adhd':    return runStrongADHD()
    default:
      console.warn('[intervention] unknown pathId:', pathId)
  }
}

function weakTerminate (message) {
  // End timer in renderer and show popup
  if (win && !win.isDestroyed()) {
    win.show()
    win.focus()
    win.webContents.send('intervention-terminate', { message })
  }
}

function runWeakRegular () {
  // Step 1 — 30s: push "Stay focused!" + 1 chime
  trackTimeout(() => {
    new Notification({ title: 'Glorb Timer', body: 'Stay focused!' }).show()
    playSound(SND.chime)

    let pingCount = 1  // first ping already fired above

    // Steps 2–3 — every 10s: 2 chimes; on 3rd ping: 3 chimes + last reminder
    const interval = trackInterval(() => {
      pingCount++
      if (pingCount === 2) {
        playSound(SND.chime)
        trackTimeout(() => playSound(SND.chime), 400)
      } else if (pingCount === 3) {
        playSound(SND.chime)
        trackTimeout(() => playSound(SND.chime), 400)
        trackTimeout(() => playSound(SND.chime), 800)
        new Notification({ title: 'Glorb Timer', body: 'Last reminder — Stay focused!' }).show()
        // Step 4 — terminate after 3rd ping fires
        clearInterval(interval)
        // Remove from escalationTimers so clearAllTimers won't double-clear
        const idx = escalationTimers.indexOf(interval)
        if (idx !== -1) escalationTimers.splice(idx, 1)
        trackTimeout(() => weakTerminate('Ready to continue focusing?'), 10000)
      }
    }, 10000)
  }, 30000)
}

function runWeakADHD () {
  // Step 1 — 10s: push notif + 1 note
  trackTimeout(() => {
    new Notification({ title: 'Glorb Timer', body: 'Stay focused!' }).show()
    playNotes(1)

    let pingCount = 1

    // Steps 2-up — every 5s up to 5 pings total with increasing notes
    const interval = trackInterval(() => {
      pingCount++
      if (pingCount <= 5) {
        playNotes(pingCount)
        if (pingCount === 5) {
          // After 5th ping, stop interval and start constant chime for 10s
          clearInterval(interval)
          const idx = escalationTimers.indexOf(interval)
          if (idx !== -1) escalationTimers.splice(idx, 1)
          // D-02: rapid repeated afplay loop for 10s constant chiming
          const chimeIntervalMs = 600
          const chimeCount = Math.floor(10000 / chimeIntervalMs)
          for (let i = 0; i < chimeCount; i++) {
            trackTimeout(() => playSound(SND.note1), i * chimeIntervalMs)
          }
          // terminate after 10s constant chime
          trackTimeout(() => weakTerminate('You lost focus.'), 10000)
        }
      }
    }, 5000)
  }, 10000)
}
function createOverlayWindow (htmlFile, durationMs) {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.close()
  }
  overlayWin = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    show: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  overlayWin.loadFile(htmlFile)
  overlayWin.on('closed', () => { overlayWin = null })
  if (durationMs) {
    trackTimeout(() => {
      if (overlayWin && !overlayWin.isDestroyed()) overlayWin.close()
    }, durationMs)
  }
  return overlayWin
}

function fadeAudioOver30s () {
  // D-03: fade system volume to 0 over 30s using osascript in 10 steps of 3s each
  const steps = 10
  const stepMs = 3000
  for (let i = 1; i <= steps; i++) {
    const targetVol = Math.max(0, 100 - i * 10)
    trackTimeout(() => {
      execFile('osascript', ['-e', `set volume output volume ${targetVol}`], () => {})
    }, i * stepMs)
  }
}

function runStrongRegular () {
  // Step 1 — 15s: push "Stay focused!" + 1 chime
  trackTimeout(() => {
    new Notification({ title: 'Glorb Timer', body: 'Stay focused!' }).show()
    playSound(SND.chime)

    let pingCount = 1

    // Steps 2-3 — every 10s: 2 chimes; on 3rd ping: 3 chimes + last reminder
    const interval = trackInterval(() => {
      pingCount++
      if (pingCount === 2) {
        playSound(SND.chime)
        trackTimeout(() => playSound(SND.chime), 400)
      } else if (pingCount === 3) {
        playSound(SND.chime)
        trackTimeout(() => playSound(SND.chime), 400)
        trackTimeout(() => playSound(SND.chime), 800)
        new Notification({ title: 'Glorb Timer', body: 'Last reminder — Stay focused!' }).show()
        clearInterval(interval)
        const idx = escalationTimers.indexOf(interval)
        if (idx !== -1) escalationTimers.splice(idx, 1)

        // Step 4 — after last reminder: 2s full-screen Glorb flash (D-05)
        trackTimeout(() => {
          createOverlayWindow('flash.html', 2000)

          // Step 5 — after flash closes (2s): fade audio over 30s
          trackTimeout(() => {
            fadeAudioOver30s()

            // Step 6 — vignette for 60s
            trackTimeout(() => {
              createOverlayWindow('vignette.html', 60000)

              // Step 7 — terminate screen after vignette
              trackTimeout(() => {
                createOverlayWindow('terminate.html', null)  // dwell-to-dismiss
              }, 60000)
            }, 500)  // slight offset so flash closes before vignette opens
          }, 2000)
        }, 1000)
      }
    }, 10000)
  }, 15000)
}

function runStrongADHD () {
  // Step 1 — 10s: push notif + 1 note
  trackTimeout(() => {
    new Notification({ title: 'Glorb Timer', body: 'Stay focused!' }).show()
    playNotes(1)

    let pingCount = 1

    // Steps 2 — every 5s up to 5 pings with increasing notes
    const interval = trackInterval(() => {
      pingCount++
      if (pingCount <= 5) {
        playNotes(pingCount)
        if (pingCount === 5) {
          clearInterval(interval)
          const idx = escalationTimers.indexOf(interval)
          if (idx !== -1) escalationTimers.splice(idx, 1)

          // Step 3 — 5s full-screen Glorb flash (D-06)
          createOverlayWindow('flash.html', 5000)

          // Step 4 — after flash (5s): fade audio 30s
          trackTimeout(() => {
            fadeAudioOver30s()

            // Step 5 — vignette 60s
            trackTimeout(() => {
              createOverlayWindow('vignette.html', 60000)

              // Step 6 — terminate screen
              trackTimeout(() => {
                createOverlayWindow('terminate.html', null)  // dwell-to-dismiss
              }, 60000)
            }, 500)
          }, 5000)
        }
      }
    }, 5000)
  }, 10000)
}

function createWindow () {
  win = new BrowserWindow({
    width: 286,
    height: 560,
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.loadFile('renderer.html')

  win.on('blur', () => {
    win.hide()
  })
}

function createDetectorWindow (deviceId) {
  if (detectorWin && !detectorWin.isDestroyed()) {
    detectorWin.close()
    detectorWin = null
  }
  detectorWin = new BrowserWindow({
    width: 320,
    height: 240,
    show: false,
    frame: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  const q = deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : ''
  detectorWin.loadURL(`file://${path.join(__dirname, 'detector.html')}${q}`)
  detectorWin.on('closed', () => { detectorWin = null })
}

function stopDetectorWindow () {
  if (detectorWin && !detectorWin.isDestroyed()) {
    detectorWin.close()
  }
  detectorWin = null
}

function createTray () {
  const trayIcon = nativeImage
    .createFromPath(path.join(__dirname, 'glorb_icon.png'))
    .resize({ width: 18, height: 18 })
  trayIcon.setTemplateImage(true)

  tray = new Tray(trayIcon)

  tray.on('click', () => {
    // Lock menu bar during onboarding / retake-test
    if (onboardingWin && !onboardingWin.isDestroyed()) return

    if (win.isVisible()) {
      win.hide()
    } else {
      const bounds = tray.getBounds()
      win.setPosition(
        Math.round(bounds.x + bounds.width / 2 - 143),
        Math.round(bounds.y + bounds.height)
      )
      win.show()
      win.focus()
    }
  })
}

function createOnboardingWindow () {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize
  onboardingWin = new BrowserWindow({
    width: Math.round(sw * 0.92),
    height: Math.round(sh * 0.92),
    show: true,
    frame: true,
    resizable: true,
    center: true,
    alwaysOnTop: false,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  onboardingWin.loadFile('onboarding.html')

  onboardingWin.on('closed', () => {
    onboardingWin = null
  })
}

function startSocketServer () {
  // Clean up stale socket file from previous run
  try { fs.unlinkSync(SOCK_PATH) } catch (_) {}

  const server = net.createServer((socket) => {
    let buf = ''
    socket.on('data', (chunk) => {
      buf += chunk.toString()
      if (buf.includes('\n')) {
        const cmd = buf.trim()
        if (cmd === 'drift') {
          driftCount++
          const strength = store.get('strength', 'weak')
          const hasADHD = store.get('hasADHD', false)
          runPath(`${strength === 'strong' ? 'strong' : 'weak'}-${hasADHD ? 'adhd' : 'regular'}`)
          socket.write('ok\n')
        } else if (cmd === 'refocus') {
          if (driftCount > 0) {
            new Notification({ title: 'Glorb Timer', body: 'Focus regained.' }).show()
          }
          driftCount = 0
          clearAllTimers()
          socket.write('ok\n')
        } else {
          socket.write(`unknown command: ${cmd}\n`)
        }
        socket.end()
      }
    })
    socket.on('error', () => {})
  })

  server.listen(SOCK_PATH, () => {
    console.log('[glorb] CLI socket listening at', SOCK_PATH)
  })

  server.on('error', (err) => {
    console.warn('[glorb] socket server error:', err.message)
  })

  return server
}

app.dock.hide()
app.setActivationPolicy('accessory')

app.whenReady().then(async () => {
  createWindow()
  createTray()
  startSocketServer()

  globalShortcut.register('Command+Q', () => {
    app.quit()
  })

  // ONBOARD-01: show onboarding on first launch if no profile yet
  const onboardingComplete = store.get('onboardingComplete', false)
  if (!onboardingComplete) {
    createOnboardingWindow()
  }
})

app.on('window-all-closed', (e) => {
  e.preventDefault()
})

app.on('before-quit', () => {
  try { fs.unlinkSync(SOCK_PATH) } catch (_) {}
})

ipcMain.handle('quit-app', () => {
  app.quit()
})

ipcMain.handle('resize-window', (event, { width, height }) => {
  win.setSize(Math.round(width), Math.round(height))
  const bounds = tray.getBounds()
  win.setPosition(
    Math.round(bounds.x + bounds.width / 2 - width / 2),
    Math.round(bounds.y + bounds.height)
  )
})

ipcMain.handle('store-get', (event, key, defaultVal) => store.get(key, defaultVal))
ipcMain.handle('store-set', (event, key, value) => { store.set(key, value) })

ipcMain.handle('notify', (event, { title, body }) => {
  new Notification({ title, body }).show()
})

// Phase 7 — ONBOARD-01/06: onboarding window lifecycle
ipcMain.handle('open-onboarding', () => {
  // Reset flag so onboarding runs from the beginning
  store.set('onboardingComplete', false)
  if (onboardingWin && !onboardingWin.isDestroyed()) {
    onboardingWin.focus()
    return
  }
  createOnboardingWindow()
})

ipcMain.handle('close-overlay', () => {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.close()
    overlayWin = null
  }
})

ipcMain.handle('close-onboarding', () => {
  if (onboardingWin && !onboardingWin.isDestroyed()) {
    onboardingWin.close()
  }
  // Notify main window to refresh name/profile after onboarding completes
  if (win && !win.isDestroyed()) {
    win.webContents.send('onboarding-complete')
  }
})

// Phase 8 — INTERV-01/02: drift and refocus IPC handlers
ipcMain.handle('drift-detected', () => triggerDrift())
ipcMain.handle('refocus-detected', () => triggerRefocus())

// Quick-260419-d21: camera detector IPC (from hidden detector window)
ipcMain.handle('camera-drift', () => triggerDrift())
ipcMain.handle('camera-refocus', () => triggerRefocus())

// Quick-260419-d21: monitor lifecycle (from timer UI)
ipcMain.handle('start-monitors', async (event, { task, cameraDeviceId }) => {
  const userWhitelistApps = store.get('userWhitelistApps', [])
  try {
    createDetectorWindow(cameraDeviceId || '')
  } catch (err) {
    console.warn('[monitors] camera detector failed:', err.message)
  }
  try {
    await appMonitor.start({
      task: task || '',
      userWhitelist: userWhitelistApps,
      onDrift: () => triggerDrift(),
      onRefocus: () => triggerRefocus()
    })
  } catch (err) {
    console.warn('[monitors] app monitor failed:', err.message)
  }
})

ipcMain.handle('list-applications', () => {
  try {
    return fs.readdirSync('/Applications')
      .filter(f => f.endsWith('.app'))
      .map(f => f.replace(/\.app$/, ''))
      .sort()
  } catch { return [] }
})

ipcMain.handle('stop-monitors', () => {
  appMonitor.stop()
  stopDetectorWindow()
  triggerRefocus()
})
