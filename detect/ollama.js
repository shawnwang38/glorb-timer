const http = require('http')

const OLLAMA_HOST = 'localhost'
const OLLAMA_PORT = 11434
const MODEL = 'qwen3:1.7b'

function buildPrompt (task, apps) {
  return `You are a strict focus assistant. Decide which open apps are DIRECTLY required for the user's task.

Rules:
- Only include an app if CLEARLY and DIRECTLY needed for the task.
- Do NOT include coding tools (Terminal, VS Code, Xcode) unless the task explicitly involves code.
- Do NOT include communication apps (Slack, Discord, Messages) unless the task is communicating.
- If the task is vague, recreational, or non-work, return [].
- Prefer fewer apps over more. When in doubt, leave it out.
- Only use names that appear exactly in the provided list.
- Reply with ONLY a JSON array. No explanation, no markdown.

User task: "${task}"

Open applications:
${JSON.stringify(apps)}

Your answer (JSON array only):`
}

function ollamaGenerate (prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: MODEL, prompt, stream: false })
    const req = http.request(
      {
        hostname: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: '/api/generate',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Ollama HTTP ${res.statusCode}: ${data}`))
            return
          }
          try {
            resolve(JSON.parse(data).response ?? '')
          } catch {
            reject(new Error(`Ollama parse error: ${data}`))
          }
        })
      }
    )
    req.on('error', (err) => {
      if (err.code === 'ECONNREFUSED') {
        reject(new Error('Ollama not running — start with: ollama serve'))
      } else {
        reject(err)
      }
    })
    req.setTimeout(30000, () => {
      req.destroy()
      reject(new Error('Ollama timed out'))
    })
    req.write(body)
    req.end()
  })
}

function parseAppArray (raw) {
  if (!raw || raw.trim() === '') throw new Error('Empty model response')
  const withoutThink = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const match = withoutThink.match(/\[[\s\S]*?\]/)
  if (!match) throw new Error(`No JSON array in response: ${raw}`)
  const arr = JSON.parse(match[0])
  if (!Array.isArray(arr)) throw new Error('Not an array')
  return arr.filter((x) => typeof x === 'string')
}

async function classifyApps (task, apps) {
  const prompt = buildPrompt(task, apps)
  const raw = await ollamaGenerate(prompt)
  return parseAppArray(raw)
}

module.exports = { classifyApps }
