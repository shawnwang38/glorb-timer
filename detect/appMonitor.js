const { execFile } = require('child_process')
const { classifyApps } = require('./ollama')

const ALIASES = {
  Code: 'Visual Studio Code',
  VSCode: 'Visual Studio Code',
  Chrome: 'Google Chrome',
  iTerm: 'iTerm2',
  'System Preferences': 'System Settings',
  'zoom.us': 'Zoom'
}

const ALWAYS_ALLOWED = ['Finder', 'System Settings', 'Glorb Timer', 'Electron']

const LOW_INTENT = [
  /\bnothing\b/i,
  /\bidle\b/i,
  /\bbreak\b/i,
  /\brelax\b/i,
  /\brest\b/i,
  /\bkilling time\b/i
]

function normalize (name) {
  return ALIASES[name] ?? name
}

function osa (script, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout) => {
      if (err) return reject(err)
      resolve(stdout.trim())
    })
  })
}

async function getOpenApps () {
  const raw = await osa(
    'tell application "System Events" to get name of every process where background only is false',
    5000
  )
  return [...new Set(raw.split(',').map((s) => normalize(s.trim())).filter(Boolean))]
}

async function getActiveApp () {
  const raw = await osa(
    'tell application "System Events" to get name of first application process whose frontmost is true',
    3000
  )
  return normalize(raw)
}

let pollHandle = null
let prevDrifted = false

function stop () {
  if (pollHandle) {
    clearInterval(pollHandle)
    pollHandle = null
  }
  prevDrifted = false
}

// Start the app monitor. onDrift/onRefocus are edge-triggered callbacks.
async function start ({ task, onDrift, onRefocus, intervalMs = 2000 }) {
  stop()
  prevDrifted = false

  let whitelist = new Set(ALWAYS_ALLOWED)

  const lowIntent = LOW_INTENT.some((re) => re.test(task || ''))
  if (task && task.trim() && !lowIntent) {
    try {
      const open = await getOpenApps()
      const llmApps = await classifyApps(task.trim(), open)
      llmApps.forEach((a) => whitelist.add(a))
      console.log('[appMonitor] whitelist:', [...whitelist])
    } catch (err) {
      console.warn('[appMonitor] classify failed, using always-allowed only:', err.message)
    }
  } else {
    console.log('[appMonitor] low-intent or empty task — always-allowed only:', [...whitelist])
  }

  pollHandle = setInterval(async () => {
    let active
    try {
      active = await getActiveApp()
    } catch (err) {
      return
    }
    const drifted = !whitelist.has(active)
    if (drifted && !prevDrifted) {
      prevDrifted = true
      console.log('[appMonitor] drift → active:', active)
      try { onDrift && onDrift({ active }) } catch (_) {}
    } else if (!drifted && prevDrifted) {
      prevDrifted = false
      console.log('[appMonitor] refocus → active:', active)
      try { onRefocus && onRefocus({ active }) } catch (_) {}
    }
  }, intervalMs)
}

module.exports = { start, stop }
