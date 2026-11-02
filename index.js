/**
 * dsh-video-remix — DSH-facing half of the video-remix capability.
 *
 * This plugin intentionally contains no generative logic of its own: it exposes
 * the sibling `video-remix` skill (a plain CLI at <workspace>/.dsh/skills/video-remix)
 * as three Harness tools. One implementation, two faces — so a fix or a new
 * voice never has to be made twice.
 *
 * Tool names avoid the `vision_` prefix on purpose: dsh-vision-router claims every
 * tool registered under that prefix and hides it whenever its Vision mode is off.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const DEFAULTS = {
  renderTimeoutMs: 15 * 60 * 1000,
  samplesTimeoutMs: 5 * 60 * 1000,
  voicesTimeoutMs: 90 * 1000,
}

/** Locate the sibling skill and the workspace it lives in. */
function locateSkill() {
  const candidates = [
    path.resolve(HERE, '..', '.dsh', 'skills', 'video-remix'),
    path.resolve(HERE, '..', '..', '.dsh', 'skills', 'video-remix'),
    path.resolve(process.cwd(), '.dsh', 'skills', 'video-remix'),
  ]
  for (const dir of candidates) {
    const script = path.join(dir, 'scripts', 'remix.mjs')
    if (existsSync(script)) {
      return { dir, script, workspace: path.resolve(dir, '..', '..', '..') }
    }
  }
  return null
}

function runNode(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      windowsHide: true,
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = options.timeoutMs
      ? setTimeout(() => {
          if (settled) return
          settled = true
          try {
            child.kill('SIGKILL')
          } catch {
            // gone
          }
          reject(new Error(`执行超时（${Math.round(options.timeoutMs / 1000)} 秒）`))
        }, options.timeoutMs)
      : null

    child.stdout.on('data', (d) => {
      if (stdout.length < 4_000_000) stdout += d
    })
    child.stderr.on('data', (d) => {
      if (stderr.length < 4_000_000) stderr += d
    })
    child.on('error', (e) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

function lastJson(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return null
  // Whole-output parse first; the payloads here are pure JSON.
  try {
    return JSON.parse(trimmed)
  } catch {
    // fall through: maybe some progress line preceded it
  }
  // Otherwise take the FIRST '{' — lastIndexOf would slice into an inner object.
  const start = trimmed.indexOf('{')
  if (start < 0) return null
  try {
    return JSON.parse(trimmed.slice(start))
  } catch {
    return null
  }
}

function skillProblem() {
  return (
    '找不到 video-remix skill：期望在 <工作区>/.dsh/skills/video-remix/scripts/remix.mjs。' +
    '请先把该 skill 放到工作区的 .dsh/skills/ 下。'
  )
}

/* ------------------------------------------------------------------- tools */

function buildRenderTool(settings) {
  return {
    name: 'render_video',
    description:
      'Render a narrated video from a script: text-card slides by default, or real AI footage when visual="ai". ' +
      'Each segment pairs a short on-screen title/subtitle with a spoken narration line; the clip length follows the narration. ' +
      'Delegates to the local video-remix skill (one implementation, two faces). ' +
      'Use visual="ai" only when the user wants real imagery — it calls an external video model and takes minutes per segment.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Output file name (without extension). Defaults to "video".' },
        visual: {
          type: 'string',
          enum: ['cards', 'ai'],
          description:
            'cards (default): ffmpeg text cards, fast and exact for tutorials. ai: real footage per segment via agnes-video; ' +
            'slow (minutes per segment) and needs AGNES_API_KEY and every segment\'s prompt.',
        },
        voice: {
          type: 'object',
          description: 'TTS route. Defaults to engine=edge, name=zh-CN-YunxiNeural.',
          properties: {
            engine: { type: 'string', enum: ['edge', 'local'], description: 'edge = online neural voices; local = offline Windows voices.' },
            name: { type: 'string', description: 'Voice id, e.g. zh-CN-YunxiNeural or Kangkang. Use list_voices to see all.' },
          },
        },
        ratio: { type: 'string', description: 'Aspect ratio for visual="ai", e.g. 16:9, 9:16, 1:1. Defaults to 16:9.' },
        segments: {
          type: 'array',
          description: 'Ordered segments. At least one.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Large on-screen line.' },
              sub: { type: 'string', description: 'Smaller on-screen line (cards mode only).' },
              narration: { type: 'string', description: 'What the voice says. Falls back to title when omitted.' },
              prompt: { type: 'string', description: 'Visual prompt for this segment. Required when visual="ai".' },
              duration: { type: 'number', description: 'Force this segment length in seconds instead of following the narration.' },
            },
          },
        },
      },
      required: ['segments'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          file: { type: 'string' },
          durationSec: { type: 'number' },
          bytes: { type: 'number' },
          segments: { type: 'number' },
        },
      },
      render: (args, value) => [
        {
          type: 'text',
          text:
            `🎬 已生成：${value.file}\n` +
            `时长 ${Number(value.durationSec || 0).toFixed(1)} 秒 · ${value.segments} 段 · ` +
            `${(Number(value.bytes || 0) / 1024 / 1024).toFixed(2)} MB · 音色 ${value.voice ? `${value.voice.engine}/${value.voice.name}` : '默认'}\n` +
            '要微调文案或音色，改参数重跑即可（文字卡片版通常在 1 分钟内完成）。',
        },
      ],
    },
    isConcurrencySafe: () => false,
    timeoutMs: DEFAULTS.renderTimeoutMs,
    execute: async (args, exec) => {
      const skill = locateSkill()
      if (!skill) throw new Error(skillProblem())

      const segments = Array.isArray(args.segments) ? args.segments : []
      if (segments.length === 0) throw new Error('segments 不能为空')

      const visual = String(args.visual || 'cards')
      if (visual === 'ai') {
        const missing = segments.findIndex((s) => !s || !s.prompt)
        if (missing >= 0) {
          throw new Error(`visual="ai" 时第 ${missing + 1} 段缺少 prompt（画面提示词）。`)
        }
      }

      const title = String(args.title || 'video')
      const workDir = path.join(skill.workspace, '.video-remix-work')
      mkdirSync(workDir, { recursive: true })
      const scriptPath = path.join(workDir, `script-${Date.now().toString(36)}.json`)
      const outFile = path.join(skill.workspace, '生成视频', `${title.replace(/[\\/:*?"<>|]+/g, '_')}.mp4`)

      // A human choice made in the composer wins over the built-in default,
      // but an explicit voice argument from the model still overrides it.
      const pickedVoice =
        args.voice && args.voice.name
          ? { engine: args.voice.engine || 'edge', name: args.voice.name }
          : RUNTIME_VOICE || DEFAULT_VOICE

      const script = {
        title,
        visual,
        ratio: args.ratio || '16:9',
        voice: pickedVoice,
        segments,
      }
      writeFileSync(scriptPath, JSON.stringify(script, null, 2), 'utf8')

      const result = await runNode([skill.script, 'render', scriptPath, '--out', outFile], {
        cwd: skill.workspace,
        timeoutMs: DEFAULTS.renderTimeoutMs,
      })
      if (result.code !== 0 || !existsSync(outFile)) {
        throw new Error(`渲染失败：${(result.stderr || result.stdout).slice(-800)}`)
      }
      const parsed = lastJson(result.stdout) || {}
      return {
        ok: true,
        file: outFile,
        durationSec: Number(parsed.durationSec || 0),
        bytes: statSync(outFile).size,
        segments: segments.length,
        voice: script.voice,
      }
    },
  }
}

function buildVoicesTool() {
  return {
    name: 'list_voices',
    description:
      'List every usable text-to-speech voice: online neural voices (14 Chinese) and offline Windows voices. ' +
      'Use it before render_video when the user cares about how the narration sounds.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { edge: { type: 'array' }, local: { type: 'array' } } },
      render: (args, value) => {
        const edge = Array.isArray(value.edge) ? value.edge : []
        const local = Array.isArray(value.local) ? value.local : []
        const lines = [`🗣 在线音色 ${edge.length} 个：`]
        for (const v of edge) lines.push(`  ${v.name} · ${v.locale} · ${v.gender === 'Female' ? '女' : '男'}`)
        lines.push('', `💻 本地离线音色 ${local.length} 个（Windows，机械感明显）：`)
        for (const v of local) lines.push(`  ${v.name} · ${v.locale} · ${v.gender === 'Female' ? '女' : '男'}`)
        lines.push('', '推荐：zh-CN-YunxiNeural（男·百搭）、zh-CN-XiaoyiNeural（女·年轻）、zh-CN-YunxiaNeural（男·少年）、zh-HK-WanLungNeural（粤语男）。')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    timeoutMs: DEFAULTS.voicesTimeoutMs,
    execute: async () => {
      const skill = locateSkill()
      if (!skill) throw new Error(skillProblem())
      const result = await runNode([skill.script, 'voices'], {
        cwd: skill.workspace,
        timeoutMs: DEFAULTS.voicesTimeoutMs,
      })
      const parsed = lastJson(result.stdout)
      if (!parsed) throw new Error(`列举音色失败：${(result.stderr || result.stdout).slice(-400)}`)
      return parsed
    },
  }
}

function buildSamplesTool() {
  return {
    name: 'voice_samples',
    description:
      'Render the same sentence with every available voice into one folder, plus an index listing them, ' +
      'so a human can listen and choose. Takes about a minute. Returns the folder path.',
    parameters: {
      type: 'object',
      properties: {
        out: {
          type: 'string',
          description: 'Output directory. Defaults to <workspace>/音色试听.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          dir: { type: 'string' },
          total: { type: 'number' },
          edge: { type: 'number' },
          local: { type: 'number' },
        },
      },
      render: (args, value) => [
        {
          type: 'text',
          text:
            `🔊 试听包已生成：${value.dir}\n` +
            `共 ${value.total} 个音色（在线 ${value.edge} · 本地 ${value.local}），` +
            '每个都是一段相同的话，另有 00-全部音色预览.mp3 可连续听完。',
        },
      ],
    },
    isConcurrencySafe: () => false,
    timeoutMs: DEFAULTS.samplesTimeoutMs,
    execute: async (args) => {
      const skill = locateSkill()
      if (!skill) throw new Error(skillProblem())
      const outDir = args.out ? path.resolve(String(args.out)) : path.join(skill.workspace, '音色试听')
      mkdirSync(outDir, { recursive: true })
      const result = await runNode([skill.script, 'samples', '--out', outDir], {
        cwd: skill.workspace,
        timeoutMs: DEFAULTS.samplesTimeoutMs,
      })
      const parsed = lastJson(result.stdout)
      if (!parsed || !parsed.ok) {
        throw new Error(`生成试听包失败：${(result.stderr || result.stdout).slice(-600)}`)
      }
      return { dir: parsed.dir || outDir, total: parsed.total || 0, edge: parsed.edge || 0, local: parsed.local || 0 }
    },
  }
}

/* -------------------------------------------------------- composer routes */

const VOICE_ROUTE = '/_dsh/video-remix/voice'
const SAMPLE_ROUTE = '/_dsh/video-remix/sample'
const UPLOAD_ROUTE = '/_dsh/video-remix/upload'

/**
 * Built-in voices, mirroring the skill's own catalogue. Kept static so the
 * composer can render instantly without spawning the CLI on every page load.
 */
const BUILTIN_VOICES = [
  { id: 'zh-CN-YunxiNeural', label: '云希', gender: '男', group: '普通话', engine: 'edge', recommended: true },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊', gender: '女', group: '普通话', engine: 'edge', recommended: true },
  { id: 'zh-CN-YunxiaNeural', label: '云夏', gender: '男', group: '普通话', engine: 'edge', recommended: true },
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓', gender: '女', group: '普通话', engine: 'edge' },
  { id: 'zh-CN-YunyangNeural', label: '云扬', gender: '男', group: '普通话', engine: 'edge' },
  { id: 'zh-CN-YunjianNeural', label: '云健', gender: '男', group: '普通话', engine: 'edge' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', label: '东北小北', gender: '女', group: '方言', engine: 'edge' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', label: '陕西小妮', gender: '女', group: '方言', engine: 'edge' },
  { id: 'zh-HK-WanLungNeural', label: '粤语·雲龍', gender: '男', group: '粤语', engine: 'edge', recommended: true },
  { id: 'zh-HK-HiuGaaiNeural', label: '粤语·曉佳', gender: '女', group: '粤语', engine: 'edge' },
  { id: 'zh-HK-HiuMaanNeural', label: '粤语·曉曼', gender: '女', group: '粤语', engine: 'edge' },
  { id: 'zh-TW-HsiaoChenNeural', label: '台湾·曉臻', gender: '女', group: '台湾', engine: 'edge' },
  { id: 'zh-TW-HsiaoYuNeural', label: '台湾·曉雨', gender: '女', group: '台湾', engine: 'edge' },
  { id: 'zh-TW-YunJheNeural', label: '台湾·雲哲', gender: '男', group: '台湾', engine: 'edge' },
  { id: 'Huihui', label: '慧慧', gender: '女', group: '离线', engine: 'local' },
  { id: 'Yaoyao', label: '瑶瑶', gender: '女', group: '离线', engine: 'local' },
  { id: 'Kangkang', label: '康康', gender: '男', group: '离线', engine: 'local' },
]

const DEFAULT_VOICE = { engine: 'edge', name: 'zh-CN-YunxiNeural' }

/** The voice a human picked in the composer; render_video uses it when unset. */
let RUNTIME_VOICE = null

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

function readBody(req, limit = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJsonBody(req) {
  const buf = await readBody(req)
  if (!buf.length) return null
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    return null
  }
}

function audioDirs(skill) {
  const root = path.join(skill.workspace, '音色试听')
  return { sample: root, custom: path.join(root, 'custom') }
}

/** Sample files are named like `04-晓晓-zh-CN-XiaoxiaoNeural.mp3`. */
function findSample(dir, name) {
  if (!name || !existsSync(dir)) return null
  const files = readdirSync(dir).filter((n) => /\.(mp3|wav|m4a|ogg)$/i.test(n))
  const hit = files.find((n) => n.includes(name))
  return hit ? path.join(dir, hit) : null
}

function voiceState(skill) {
  const { sample, custom } = audioDirs(skill)
  const customFiles = existsSync(custom)
    ? readdirSync(custom).filter((n) => /\.(mp3|wav|m4a|ogg)$/i.test(n)).sort()
    : []
  return {
    ok: true,
    voices: BUILTIN_VOICES,
    custom: customFiles.map((file) => ({
      id: `file:${file}`,
      label: file.replace(/\.[^.]+$/, ''),
      group: '自定义',
      engine: 'file',
      file,
    })),
    selected: RUNTIME_VOICE || DEFAULT_VOICE,
    hasSamples: existsSync(sample),
    sampleDir: sample,
  }
}

/**
 * Mounts three routes: list/select a voice, stream a sample for preview, and
 * accept an uploaded audio file so a human can bring their own voice.
 */
function installVoiceRoutes(ctx) {
  const attach = (webCtx) => {
    const skill = locateSkill()
    if (!skill) return

    webCtx.effect(() =>
      webCtx.webServer.register({
        kind: 'exact',
        path: VOICE_ROUTE,
        handler: async (req, res) => {
          if (req.method === 'GET') {
            sendJson(res, 200, voiceState(skill))
            return
          }
          if (req.method !== 'POST') {
            res.setHeader('Allow', 'GET, POST')
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const body = await readJsonBody(req).catch(() => null)
          if (!body || !body.name) {
            RUNTIME_VOICE = null
            sendJson(res, 200, voiceState(skill))
            return
          }
          RUNTIME_VOICE = { engine: String(body.engine || 'edge'), name: String(body.name) }
          sendJson(res, 200, voiceState(skill))
        },
      }),
    )

    webCtx.effect(() =>
      webCtx.webServer.register({
        kind: 'exact',
        path: SAMPLE_ROUTE,
        handler: async (req, res) => {
          const url = new URL(req.url, 'http://localhost')
          const name = url.searchParams.get('name') || ''
          const { sample, custom } = audioDirs(skill)
          const file = findSample(custom, name) || findSample(sample, name)
          if (!file) {
            sendJson(res, 404, { ok: false, error: 'sample not found; run voice_samples first' })
            return
          }
          const lower = file.toLowerCase()
          res.statusCode = 200
          res.setHeader('content-type', lower.endsWith('.wav') ? 'audio/wav' : lower.endsWith('.m4a') ? 'audio/mp4' : 'audio/mpeg')
          res.setHeader('cache-control', 'public, max-age=3600')
          res.end(readFileSync(file))
        },
      }),
    )

    webCtx.effect(() =>
      webCtx.webServer.register({
        kind: 'exact',
        path: UPLOAD_ROUTE,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            res.setHeader('Allow', 'POST')
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const body = await readJsonBody(req).catch(() => null)
          if (!body || !body.name || !body.data) {
            sendJson(res, 400, { ok: false, error: 'name and data(base64) are required' })
            return
          }
          const { custom } = audioDirs(skill)
          mkdirSync(custom, { recursive: true })
          const safe = String(body.name)
            .replace(/[\\/:*?"<>|]/g, '_')
            .replace(/^\.+/, '')
            .slice(0, 80)
          const ext = path.extname(safe).toLowerCase()
          const fileName = /\.(mp3|wav|m4a|ogg)$/.test(ext) ? safe : `${safe}.mp3`
          const out = path.join(custom, fileName)
          writeFileSync(out, Buffer.from(String(body.data), 'base64'))
          sendJson(res, 200, voiceState(skill))
        },
      }),
    )
  }

  // The browser carrier can mount after this plugin, so wait for the service
  // instead of sampling ctx.get() once (that race left video-eyes' slider dead).
  const current = ctx.get('webServer')
  if (current && typeof current.register === 'function') {
    attach(ctx)
    return
  }
  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], attach)
}

/* -------------------------------------------------------------- activation */

export const inject = ['tools']

export function apply(ctx, config) {
  const settings = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  ctx.effect(() => ctx.tools.register(buildRenderTool(settings)))
  ctx.effect(() => ctx.tools.register(buildVoicesTool()))
  ctx.effect(() => ctx.tools.register(buildSamplesTool()))
  installVoiceRoutes(ctx)
}
