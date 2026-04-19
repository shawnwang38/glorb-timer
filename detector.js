// Minimal camera presence detector.
// Samples 160x120 frames at 2Hz. Presence signal is:
//   - mean brightness in [20, 240] (rules out covered / oversaturated lens)
//   - at least one frame in the last PRESENCE_WINDOW_MS had mean-abs-diff > MOTION_THRESHOLD
// When presence is lost for > GRACE_MS -> emit 'camera-drift'
// When presence is restored -> emit 'camera-refocus'
// State transitions only (edge-triggered).

const SAMPLE_INTERVAL_MS = 500
const PRESENCE_WINDOW_MS = 15000
const GRACE_MS = 15000
const MOTION_THRESHOLD = 3
const BRIGHTNESS_MIN = 20
const BRIGHTNESS_MAX = 240

const video = document.getElementById('v')
const canvas = document.getElementById('c')
const ctx = canvas.getContext('2d', { willReadFrequently: true })

// Parse camera deviceId from query string
const params = new URLSearchParams(window.location.search)
const deviceId = params.get('deviceId') || ''

let prevFrame = null
let lastMotionAt = 0
let presence = true  // start optimistic — avoid false drift before first sample
let drifted = false
let driftedSinceMs = 0
let intervalHandle = null

function centerROI (imgData) {
  // Use full frame — simpler and more reliable than cropping for presence detection.
  return imgData.data
}

function meanBrightness (data) {
  let sum = 0
  const n = data.length / 4
  for (let i = 0; i < data.length; i += 4) {
    // Rec. 601 luma approximation
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
  }
  return sum / n
}

function meanAbsDiff (a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let sum = 0
  let count = 0
  // Sample every 16th pixel (4 channels, 4x stride) — ~4000 samples on 160x120
  for (let i = 0; i < a.length; i += 16) {
    sum += Math.abs(a[i] - b[i])
    count++
  }
  return sum / count
}

function sample () {
  if (video.readyState < 2) return
  try {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  } catch (_) {
    return
  }
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const data = centerROI(img)
  const bright = meanBrightness(data)

  let motion = 0
  if (prevFrame) motion = meanAbsDiff(data, prevFrame)
  prevFrame = data

  const brightnessOk = bright > BRIGHTNESS_MIN && bright < BRIGHTNESS_MAX
  const now = Date.now()
  if (brightnessOk && motion > MOTION_THRESHOLD) {
    lastMotionAt = now
  }

  const hadRecentMotion = now - lastMotionAt < PRESENCE_WINDOW_MS
  const newPresence = brightnessOk && hadRecentMotion

  if (newPresence) {
    presence = true
    if (drifted) {
      drifted = false
      driftedSinceMs = 0
      window.glorbDetector.refocus()
      console.log('[detector] camera refocus')
    }
  } else {
    // lost presence — start grace timer on first transition
    if (presence) {
      presence = false
      driftedSinceMs = now
    }
    if (!drifted && driftedSinceMs && now - driftedSinceMs > GRACE_MS) {
      drifted = true
      window.glorbDetector.drift()
      console.log('[detector] camera drift (bright=', bright.toFixed(1), ' motion=', motion.toFixed(2), ')')
    }
  }
}

async function init () {
  try {
    const constraints = {
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: 320, height: 240 }
        : { width: 320, height: 240 }
    }
    const stream = await navigator.mediaDevices.getUserMedia(constraints)
    video.srcObject = stream
    await video.play()
    lastMotionAt = Date.now()
    intervalHandle = setInterval(sample, SAMPLE_INTERVAL_MS)
    console.log('[detector] camera started', deviceId ? `device=${deviceId}` : 'default')
  } catch (err) {
    console.error('[detector] getUserMedia failed:', err.message)
  }
}

window.addEventListener('beforeunload', () => {
  if (intervalHandle) clearInterval(intervalHandle)
  if (video.srcObject) {
    video.srcObject.getTracks().forEach((t) => t.stop())
  }
})

init()
