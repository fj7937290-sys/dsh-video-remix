#!/usr/bin/env node
/**
 * video-remix — analyze a reference video, then build a new narrated slide video.
 *
 * Three commands, each usable on its own:
 *   voices                      list usable TTS voices (online Edge + offline Windows)
 *   analyze <video>             sample frames (timecoded contact sheets) + transcribe
 *   render <script.json>        synthesize narration, draw cards, concat into one mp4
 *
 * Self-contained: only Node >= 18 and any ffmpeg. Edge voices need the bundled
 * @andresaya/edge-tts dependency; offline voices need Windows.
 *
 * Everything is a plain CLI. It registers no Harness tools, reserves no tool
 * name, and touches no other plugin's state.
 */
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = path.dirname(HERE)
const require = createRequire(import.meta.url)

const DEFAULTS = {
  ffmpegTimeoutMs: 600000,
  cols: 4,
  rows: 4,
  cellWidth: 480,
  jpegQuality: 3,
  maxSheets: 6,
  itingnaoBase: 'https://api.itingnao.com',
}

const FONT_CANDIDATES = [
  'C:/Windows/Fonts/msyh.ttc',
  'C:/Windows/Fonts/msyhbd.ttc',
  'C:/Windows/Fonts/simhei.ttf',
  '/System/Library/Fonts/PingFang.ttc',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
]

const THEME = {
  bg: '0x0B1220',
  accent: '0x4DA3FF',
  title: 'white',
  sub: '0x9FB3C8',
  watermark: '0x3D4F63',
}

/* ------------------------------------------------------------------ utils */

const pad2 = (n) => String(n).padStart(2, '0')

function formatTimestamp(seconds) {
  const total = Math.max(0, Number(seconds) || 0)
  const minutes = Math.floor(total / 60)
  const rest = total - minutes * 60
  return `${pad2(minutes)}:${rest.toFixed(1).padStart(4, '0')}`
}

function formatClock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${pad2(h)}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`
}

function slugify(value) {
  return (
    String(value || 'video')
      .replace(/\.[^.]+$/, '')
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || 'video'
  )
}

function parseArgs(argv) {
  const positional = []
  const options = {}
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]
    if (!item.startsWith('--')) {
      positional.push(item)
      continue
    }
    const key = item.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      options[key] = true
      continue
    }
    options[key] = next
    i += 1
  }
  return { positional, options }
}

function gcd(a, b) {
  let x = Math.abs(Math.round(a))
  let y = Math.abs(Math.round(b))
  while (y) {
    const r = x % y
    x = y
    y = r
  }
  return x || 1
}

function fpsExpression(interval) {
  const den = Math.round(interval * 1000)
  const num = 1000
  const d = gcd(num, den)
  return `${num / d}/${den / d}`
}

function escapeFilterPath(v) {
  return String(v).replace(/\\/g, '/').replace(/:/g, '\\:')
}

function pickFont() {
  for (const f of FONT_CANDIDATES) if (existsSync(f)) return f
  return null
}

/* ----------------------------------------------------------------- ffmpeg */

function findUpwards(startDir, relative) {
  let dir = startDir
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, relative)
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function resolveFfmpeg(explicit) {
  const tried = []
  const candidates = [explicit, process.env.VIDEO_EYES_FFMPEG, process.env.FFMPEG_PATH]
  candidates.push(path.join(SKILL_ROOT, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))

  // A workspace helper copy may live several levels above either the skill or
  // the caller's cwd, so walk up instead of trusting a single relative path.
  const relativeHelper = path.join('_tools', 'pylibs', 'imageio_ffmpeg', 'binaries', 'ffmpeg-win64-v4.2.2.exe')
  for (const start of [SKILL_ROOT, process.cwd()]) {
    const found = findUpwards(start, relativeHelper)
    if (found) candidates.push(found)
  }
  candidates.push('ffmpeg')

  for (const candidate of candidates) {
    if (!candidate) continue
    tried.push(candidate)
    if (candidate === 'ffmpeg') {
      try {
        execFileSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore', timeout: 15000 })
        return 'ffmpeg'
      } catch {
        continue
      }
    }
    if (!existsSync(candidate)) continue
    try {
      execFileSync(candidate, ['-hide_banner', '-version'], { stdio: 'ignore', timeout: 15000 })
      return candidate
    } catch {
      // next
    }
  }
  throw new Error(
    `找不到可用的 ffmpeg。已尝试：${tried.join(' ; ')}。` +
      '请安装 ffmpeg、设置 FFMPEG_PATH，或传 --ffmpeg <路径>。',
  )
}

function run(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
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
          reject(new Error(`${path.basename(bin)} 超时（${options.timeoutMs}ms）`))
        }, options.timeoutMs)
      : null

    child.stdout.on('data', (d) => {
      if (stdout.length < 2_000_000) stdout += d
    })
    child.stderr.on('data', (d) => {
      if (stderr.length < 2_000_000) stderr += d
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

async function probeMedia(ff, file) {
  const { stderr } = await run(ff, ['-hide_banner', '-i', file], { timeoutMs: 60000 })
  const dm = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  const durationSec = dm ? Number(dm[1]) * 3600 + Number(dm[2]) * 60 + Number(dm[3]) : 0
  const vm = /Video:.*?,\s*(\d{2,5})x(\d{2,5})/.exec(stderr)
  const fm = /Video:.*?(\d+(?:\.\d+)?)\s*fps/.exec(stderr)
  return {
    durationSec,
    width: vm ? Number(vm[1]) : null,
    height: vm ? Number(vm[2]) : null,
    fps: fm ? Number(fm[1]) : null,
    hasVideo: /Stream #\d+:\d+.*?Video:/.test(stderr),
    hasAudio: /Stream #\d+:\d+.*?Audio:/.test(stderr),
  }
}

async function probeDuration(ff, file) {
  const { stderr } = await run(ff, ['-hide_banner', '-i', file], { timeoutMs: 60000 })
  const dm = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  if (!dm) return 0
  return Number(dm[1]) * 3600 + Number(dm[2]) * 60 + Number(dm[3])
}

async function extractSheets(ff, source, meta, plan, outDir) {
  const { interval, cols, rows, cellWidth, totalFrames, font } = plan
  const pageSize = cols * rows
  const remainder = totalFrames % pageSize
  const padFrames = remainder === 0 ? 0 : pageSize - remainder
  const pattern = path.join(outDir, 'sheet-%02d.jpg')
  const fontSize = Math.max(14, Math.round(cellWidth / 20))

  const parts = [`fps=${fpsExpression(interval)}`, `scale=${cellWidth}:-2:flags=lanczos`]
  if (font) {
    parts.push(
      [
        `drawtext=fontfile='${escapeFilterPath(font)}'`,
        "text='%{pts\\:hms}'",
        'x=8',
        'y=8',
        `fontsize=${fontSize}`,
        'fontcolor=yellow',
        'box=1',
        'boxcolor=black@0.65',
        'boxborderw=6',
      ].join(':'),
    )
  }
  if (padFrames > 0) {
    parts.push(`tpad=stop_mode=add:stop_duration=${(padFrames * interval).toFixed(3)}:color=black`)
  }
  parts.push(`tile=${cols}x${rows}:padding=6:margin=6:color=black`)

  const result = await run(
    ff,
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', source,
      '-vf', parts.join(','),
      '-vsync', '0',
      '-q:v', String(DEFAULTS.jpegQuality),
      '-f', 'image2',
      pattern,
    ],
    { timeoutMs: DEFAULTS.ffmpegTimeoutMs },
  )
  if (result.code !== 0) {
    throw new Error(`抽帧失败（exit ${result.code}）：${result.stderr.trim().slice(0, 600)}`)
  }
  const names = readdirSync(outDir).filter((n) => /^sheet-\d+\.jpg$/.test(n)).sort()
  return names.map((n) => path.join(outDir, n))
}

async function extractAudio(ff, source, outDir) {
  const target = path.join(outDir, 'audio.mp3')
  const result = await run(
    ff,
    ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', target],
    { timeoutMs: DEFAULTS.ffmpegTimeoutMs },
  )
  if (result.code !== 0 || !existsSync(target)) {
    throw new Error(`抽取音轨失败：${result.stderr.trim().slice(0, 400)}`)
  }
  return target
}

/* --------------------------------------------------------------- itingnao */

function readWindowsUserEnv(name) {
  if (process.platform !== 'win32') return undefined
  try {
    const out = execFileSync('reg.exe', ['query', 'HKCU\\Environment', '/v', name], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const m = new RegExp(`${name}\\s+REG_\\w+\\s+(.+)`, 'i').exec(out || '')
    return m ? m[1].trim() : undefined
  } catch {
    return undefined
  }
}

function resolveItingnaoKey(explicit) {
  return explicit || process.env.ITINGNAO_API_KEY || readWindowsUserEnv('ITINGNAO_API_KEY')
}

async function apiJson(key, { method, apiPath, query, body, signal }) {
  const url = new URL(DEFAULTS.itingnaoBase.replace(/\/+$/, '') + apiPath)
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
  const headers = { Accept: 'application/json, text/plain, */*', Authorization: `Bearer ${key}` }
  const init = { method, headers, signal }
  if (body !== undefined && method !== 'GET') {
    headers['Content-Type'] = 'application/json;charset=UTF-8'
    init.body = JSON.stringify(body)
  }
  const res = await fetch(url, init)
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`听脑返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`)
  }
  if (!res.ok) throw new Error(`听脑请求失败 HTTP ${res.status}：${text.slice(0, 200)}`)
  return json
}

async function transcribeAudio(key, audioPath, durationSec, signal) {
  const sign = await apiJson(key, { method: 'GET', apiPath: '/api/common/sign', query: { oss_dir: '' }, signal })
  if (Number(sign.code) !== 200 || !sign.data) throw new Error('获取上传签名失败')
  const s = sign.data
  const ext = path.extname(audioPath) || '.mp3'
  const key0 = `${s.dir}${Date.now()}-${Math.random().toString(16).slice(2, 10)}${ext}`
  const fileName = path.basename(audioPath)
  const bytes = readFileSync(audioPath)

  const form = new FormData()
  form.append('key', key0)
  form.append('policy', s.policy)
  form.append('OSSAccessKeyId', s.accessid)
  form.append('success_action_status', '200')
  form.append('signature', s.signature)
  form.append('name', fileName)
  form.append('file', new Blob([bytes], { type: 'audio/mpeg' }), fileName)
  const up = await fetch(s.host, { method: 'POST', body: form, signal })
  if (!up.ok) throw new Error(`OSS 上传失败 HTTP ${up.status}`)

  const cr = await apiJson(key, {
    method: 'POST',
    apiPath: '/api/record/create',
    signal,
    body: {
      trans_type: 1, chat_num: 1, style: 2, file_source_type: 1,
      name: `remix-${path.basename(fileName)}`, file_path: key0,
      file_long: formatClock(durationSec), scene_id: 1, source_channel: 2,
      meets_example_id: 0, parent_model: 0, is_knowledge: 0, knowledge_id: 0,
      folder_id: 0, file_oss_source: 0,
    },
  })
  const recordId = Array.isArray(cr.data) ? cr.data[0] && cr.data[0].id : cr.data && cr.data.id
  if (!recordId) throw new Error(`创建转写任务失败：${JSON.stringify(cr).slice(0, 200)}`)

  const deadline = Date.now() + 180000
  let triggered = false
  let detail = null
  while (Date.now() < deadline) {
    detail = (await apiJson(key, { method: 'GET', apiPath: '/api/record/detail', query: { id: recordId, summary_new: '1' }, signal })).data
    const st = Number(detail.status)
    const ds = Number(detail.data_status)
    if (ds === 1 || st === 4 || st === 100 || st === -2) break
    if (st === 90 && !triggered) {
      await apiJson(key, { method: 'POST', apiPath: '/api/record/reset_handle', body: { id: recordId, privilege_type: 1 }, signal })
      triggered = true
    }
    await new Promise((r) => setTimeout(r, 3000))
  }

  const list = Array.isArray(detail && detail.data) ? detail.data : []
  const segs = list
    .map((e) => (typeof e === 'string' ? { text: e } : e))
    .filter((e) => e && (e.text || e.content))
    .map((e) => {
      const begin = Number(e.beginTime ?? e.begin_time ?? e.start ?? NaN)
      return {
        text: String(e.text ?? e.content ?? '').trim(),
        startSec: Number.isFinite(begin) ? begin / 1000 : null,
        speaker: String(e.userName ?? '').trim(),
      }
    })
    .filter((e) => e.text)
  return { recordId: Number(recordId), segments: segs }
}

/* -------------------------------------------------------------------- tts */

let edgeTtsModule
function loadEdgeTts() {
  if (edgeTtsModule !== undefined) return edgeTtsModule
  try {
    edgeTtsModule = require('@andresaya/edge-tts')
  } catch {
    edgeTtsModule = null
  }
  return edgeTtsModule
}

async function ttsEdge(text, voice, outFile) {
  const mod = loadEdgeTts()
  if (!mod || !mod.EdgeTTS) {
    throw new Error('在线语音不可用：缺少 @andresaya/edge-tts（在 skill 目录执行 npm i @andresaya/edge-tts）')
  }
  const tts = new mod.EdgeTTS()
  await tts.synthesize(text, voice)
  const dir = path.dirname(outFile)
  const base = path.basename(outFile)
  await tts.toFile(path.join(dir, base.replace(/\.mp3$/i, '')))
  const produced = path.join(dir, 'audio.mp3')
  if (existsSync(produced) && produced !== outFile) {
    writeFileSync(outFile, readFileSync(produced))
    rmSync(produced, { force: true })
  }
  if (!existsSync(outFile)) throw new Error(`在线语音未产出文件：${outFile}`)
  return outFile
}

async function ttsLocalWindows(text, voiceName, outFile) {
  const ps1 = path.join(SKILL_ROOT, 'scripts', 'tts-windows.ps1')
  if (!existsSync(ps1)) throw new Error('缺少本地语音脚本 scripts/tts-windows.ps1')
  const dir = path.dirname(outFile)
  const textFile = path.join(dir, `tts-${Date.now()}.txt`)
  writeFileSync(textFile, text, 'utf8')
  const wav = outFile.replace(/\.[^.]+$/, '.wav')
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
  const result = await run(
    shell,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-TextFile', textFile, '-OutFile', wav, '-Voice', voiceName || ''],
    { timeoutMs: 120000 },
  )
  rmSync(textFile, { force: true })
  if (result.code !== 0 || !existsSync(wav)) {
    throw new Error(`本地语音合成失败：${(result.stderr || result.stdout).slice(0, 400)}`)
  }
  return wav
}

/* ----------------------------------------------------------------- render */

async function renderSegment(ff, seg, audioFile, duration, outFile, opts, font) {
  // Only a short tail gap: a long lead-in delay made the narration lag the
  // picture, and a long tail was audible as a pause between segments.
  const total = Math.max(1.2, Number(duration) + (opts.gap ?? 0.3))
  const dir = path.dirname(outFile)
  const tag = path.basename(outFile, '.mp4')
  const titleFile = path.join(dir, `${tag}-title.txt`)
  const subFile = path.join(dir, `${tag}-sub.txt`)
  writeFileSync(titleFile, seg.title || '', 'utf8')
  writeFileSync(subFile, seg.sub || '', 'utf8')

  const theme = { ...THEME, ...(opts.theme || {}) }
  const w = opts.width || 1280
  const h = opts.height || 720
  // drawtext's first option is attached with '=' and the rest with ':'
  const fontArg = font ? `fontfile='${escapeFilterPath(font)}':` : ''
  const filters = []

  if (opts.indexText !== false) {
    filters.push(
      `drawtext=${fontArg}text='${pad2(opts.page)} / ${pad2(opts.total)}':x=60:y=56:fontsize=22:fontcolor=${theme.accent}`,
    )
  }
  filters.push(
    `drawtext=${fontArg}textfile=${path.basename(titleFile)}:x=(w-text_w)/2:y=${Math.round(h * 0.37)}:fontsize=${opts.titleSize || 46}:fontcolor=${theme.title}`,
  )
  if (seg.sub) {
    filters.push(
      `drawtext=${fontArg}textfile=${path.basename(subFile)}:x=(w-text_w)/2:y=${Math.round(h * 0.49)}:fontsize=${opts.subSize || 24}:fontcolor=${theme.sub}`,
    )
  }
  if (opts.watermark !== false) {
    filters.push(
      `drawtext=${fontArg}text='${opts.watermarkText || 'video-remix'}':x=w-text_w-50:y=h-56:fontsize=18:fontcolor=${theme.watermark}`,
    )
  }

  const result = await run(
    ff,
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=${theme.bg}:s=${w}x${h}:r=30`,
      '-i', audioFile,
      '-vf', filters.join(','),
      // apad pads silence to -t; no leading delay, so audio and picture start together
      '-af', 'apad',
      '-t', total.toFixed(3),
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-r', '30',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
      path.basename(outFile),
    ],
    { timeoutMs: DEFAULTS.ffmpegTimeoutMs, cwd: dir },
  )
  if (result.code !== 0) {
    throw new Error(`渲染第 ${opts.page} 段失败：${result.stderr.trim().slice(0, 500)}`)
  }
  rmSync(titleFile, { force: true })
  rmSync(subFile, { force: true })
  return outFile
}

async function concatSegments(ff, files, outFile, cwd) {
  const listFile = path.join(cwd, 'concat-list.txt')
  writeFileSync(listFile, files.map((f) => `file '${path.basename(f)}'`).join('\n'), 'utf8')
  // Re-encode audio: copying AAC keeps each segment's encoder-priming samples,
  // which is audible as a click at every join.
  const result = await run(
    ff,
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'concat', '-safe', '0', '-i', 'concat-list.txt',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
      outFile,
    ],
    { timeoutMs: DEFAULTS.ffmpegTimeoutMs, cwd },
  )
  rmSync(listFile, { force: true })
  if (result.code !== 0) throw new Error(`拼接失败：${result.stderr.trim().slice(0, 500)}`)
  return outFile
}

/**
 * Still image + slow push-in + text + narration.
 *
 * This is the fast path: no generation service in the loop, so a 6-segment
 * minute-long video renders in about a minute instead of tens of minutes.
 */
async function renderImageSegment(ff, seg, audioFile, duration, imgFile, outFile, opts, font) {
  const total = Math.max(1.2, Number(duration) + (opts.gap ?? 0.3))
  const dir = path.dirname(outFile)
  const tag = path.basename(outFile, '.mp4')
  const titleFile = path.join(dir, `${tag}-title.txt`)
  const subFile = path.join(dir, `${tag}-sub.txt`)
  writeFileSync(titleFile, seg.title || '', 'utf8')
  writeFileSync(subFile, seg.sub || '', 'utf8')

  const w = opts.width || 1280
  const h = opts.height || 720
  const fontArg = font ? `fontfile='${escapeFilterPath(font)}':` : ''
  const rate = Number(opts.zoomRate ?? 0.0007)
  const maxZoom = Number(opts.zoomMax ?? 1.15)

  const filters = [
    'scale=2560:-2',
    `zoompan=z='min(1+${rate}*on,${maxZoom})':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${w}x${h}:fps=30`,
  ]
  if (seg.title) {
    filters.push(
      `drawtext=${fontArg}textfile=${path.basename(titleFile)}:x=(w-text_w)/2:y=h-190:fontsize=${opts.titleSize || 46}:fontcolor=white:box=1:boxcolor=black@0.45:boxborderw=18`,
    )
  }
  if (seg.sub) {
    filters.push(
      `drawtext=${fontArg}textfile=${path.basename(subFile)}:x=(w-text_w)/2:y=h-120:fontsize=${opts.subSize || 24}:fontcolor=0xD8E4F0:box=1:boxcolor=black@0.35:boxborderw=10`,
    )
  }

  const result = await run(
    ff,
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-loop', '1', '-framerate', '30', '-i', imgFile,
      '-i', audioFile,
      '-vf', filters.join(','),
      '-af', 'apad',
      '-t', total.toFixed(3),
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-r', '30',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
      path.basename(outFile),
    ],
    { timeoutMs: DEFAULTS.ffmpegTimeoutMs, cwd: dir },
  )
  if (result.code !== 0) {
    throw new Error(`渲染第 ${opts.page} 段（图片）失败：${result.stderr.trim().slice(0, 500)}`)
  }
  rmSync(titleFile, { force: true })
  rmSync(subFile, { force: true })
  return outFile
}

/** Pick this segment's picture, falling back to cycling through what exists. */
function resolveSegmentImage(imgDir, available, index) {
  if (available.length === 0) return null
  const wanted = `${pad2(index + 1)}.`
  const own = available.find((n) => n.startsWith(wanted))
  return path.join(imgDir, own || available[index % available.length])
}

/* -------------------------------------------------------------- ai visuals */

/**
 * Real footage comes from the agnes-video skill, invoked as a sibling CLI.
 * Kept optional on purpose: when that skill (or its key) is missing, the card
 * renderer still works, so this never becomes a hard dependency.
 */
function resolveAgnesScript(explicit) {
  const candidates = [
    explicit,
    path.resolve(SKILL_ROOT, '..', 'agnes-video', 'scripts', 'agnes_video.js'),
    path.resolve(process.cwd(), '.dsh', 'skills', 'agnes-video', 'scripts', 'agnes_video.js'),
  ]
  for (const c of candidates) if (c && existsSync(c)) return c
  return null
}

async function generateAiClip(prompt, seconds, ratio, outFile, options) {
  const script = resolveAgnesScript(options && options.agnes)
  if (!script) {
    throw new Error(
      '找不到 agnes-video skill 的脚本（scripts/agnes_video.js）。' +
        '请先安装 agnes-video，或用 --visual cards 渲染文字卡片版。',
    )
  }
  const key = process.env.AGNES_API_KEY || readWindowsUserEnv('AGNES_API_KEY')
  if (!key) {
    throw new Error('缺少 AGNES_API_KEY：AI 画面需要它。设置环境变量后再试，或改用 --visual cards。')
  }
  const env = { ...process.env, AGNES_API_KEY: key }
  const result = await run(
    'node',
    [
      script,
      '--prompt', prompt,
      '--seconds', String(seconds),
      '--ratio', ratio,
      '--out', outFile,
    ],
    { env, timeoutMs: 30 * 60 * 1000 },
  )
  if (result.code !== 0 || !existsSync(outFile)) {
    throw new Error(`AI 画面生成失败：${(result.stderr || result.stdout).slice(-500)}`)
  }
  return outFile
}

/** Mux a looping AI clip under the narration track, sized to the narration. */
async function muxClipWithVoice(ff, clip, audio, outFile, totalSec) {
  const result = await run(
    ff,
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-stream_loop', '-1', '-i', clip,
      '-i', audio,
      '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-r', '30',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
      '-t', totalSec.toFixed(3),
      outFile,
    ],
    { timeoutMs: DEFAULTS.ffmpegTimeoutMs },
  )
  if (result.code !== 0) throw new Error(`画面与配音合成失败：${result.stderr.trim().slice(0, 400)}`)
  return outFile
}

/* --------------------------------------------------------------- commands */

/** Chinese display names so sample filenames are readable at a glance. */
const VOICE_LABELS = {
  'zh-CN-XiaoxiaoNeural': '晓晓',
  'zh-CN-XiaoyiNeural': '晓伊',
  'zh-CN-YunjianNeural': '云健',
  'zh-CN-YunxiNeural': '云希',
  'zh-CN-YunxiaNeural': '云夏',
  'zh-CN-YunyangNeural': '云扬',
  'zh-CN-liaoning-XiaobeiNeural': '东北小北',
  'zh-CN-shaanxi-XiaoniNeural': '陕西小妮',
  'zh-HK-HiuGaaiNeural': '粤语-曉佳',
  'zh-HK-HiuMaanNeural': '粤语-曉曼',
  'zh-HK-WanLungNeural': '粤语-雲龍',
  'zh-TW-HsiaoChenNeural': '台湾-曉臻',
  'zh-TW-HsiaoYuNeural': '台湾-曉雨',
  'zh-TW-YunJheNeural': '台湾-雲哲',
  Huihui: '慧慧',
  Yaoyao: '瑶瑶',
  Kangkang: '康康',
}

const SAMPLE_TEXT =
  '你好，这是语音合成试听。本科生想发第一篇 SCI，记住三步：第一，找导师；第二，拆解论文；第三，先复现，再创新。'

/** Voices picked after listening to the whole set; the samples index stars these. */
const RECOMMENDED_VOICES = new Set([
  'zh-HK-WanLungNeural', // 雲龍，粤语男声
  'zh-CN-XiaoyiNeural', // 晓伊，普通话女声
  'zh-CN-YunxiNeural', // 云希，普通话男声
  'zh-CN-YunxiaNeural', // 云夏，普通话男声
])

async function cmdSamples(options) {
  const outDir = options.out ? path.resolve(String(options.out)) : path.join(process.cwd(), '音色试听')
  mkdirSync(outDir, { recursive: true })

  const edgeVoices = []
  const mod = loadEdgeTts()
  if (mod && mod.EdgeTTS) {
    try {
      const probe = new mod.EdgeTTS()
      const all = await probe.getVoices()
      for (const v of all) {
        const name = v.ShortName || v.shortName
        const locale = v.Locale || v.locale
        if (!/^zh/i.test(String(locale || ''))) continue
        edgeVoices.push({ id: name, locale, gender: v.Gender || v.gender })
      }
    } catch (error) {
      process.stderr.write(`在线音色列举失败：${error instanceof Error ? error.message : String(error)}\n`)
    }
  }

  const localVoices = []
  if (process.platform === 'win32') {
    try {
      const ps1 = path.join(SKILL_ROOT, 'scripts', 'tts-windows.ps1')
      const r = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-List'], { timeoutMs: 60000 })
      for (const line of String(r.stdout || '').split(/\r?\n/)) {
        const parts = line.split('|').map((x) => x.trim())
        if (parts.length < 3 || !parts[0]) continue
        if (!/^zh/i.test(parts[1])) continue
        localVoices.push({ id: parts[0], locale: parts[1], gender: parts[2] })
      }
    } catch (error) {
      process.stderr.write(`本地音色列举失败：${error instanceof Error ? error.message : String(error)}\n`)
    }
  }

  const rows = []
  let index = 0

  for (const voice of edgeVoices) {
    index += 1
    const label = VOICE_LABELS[voice.id] || voice.id
    const file = `${pad2(index)}-${label}-${voice.id}.mp3`
    try {
      await ttsEdge(SAMPLE_TEXT, voice.id, path.join(outDir, file))
      rows.push({ file, id: voice.id, label, locale: voice.locale, gender: voice.gender, engine: 'edge' })
      process.stderr.write(`ok  ${file}\n`)
    } catch (error) {
      rows.push({ file: null, id: voice.id, label, locale: voice.locale, gender: voice.gender, engine: 'edge', error: error instanceof Error ? error.message : String(error) })
      process.stderr.write(`FAIL ${voice.id}: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }

  for (const voice of localVoices) {
    index += 1
    // OneCore reports DisplayName like "Microsoft Huihui"; map bare names too.
    const bare = String(voice.id).replace(/^Microsoft\s+/i, '')
    const label = VOICE_LABELS[voice.id] || VOICE_LABELS[bare] || bare
    const wavName = `${pad2(index)}-${label}-本地.wav`
    try {
      const wav = await ttsLocalWindows(SAMPLE_TEXT, voice.id, path.join(outDir, wavName))
      rows.push({ file: path.basename(wav), id: voice.id, label, locale: voice.locale, gender: voice.gender, engine: 'local' })
      process.stderr.write(`ok  ${path.basename(wav)}\n`)
    } catch (error) {
      rows.push({ file: null, id: voice.id, label, locale: voice.locale, gender: voice.gender, engine: 'local', error: error instanceof Error ? error.message : String(error) })
      process.stderr.write(`FAIL ${voice.id}: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }

  // Human-readable index so the folder can be browsed without decoding filenames.
  const lines = []
  lines.push('# 音色试听')
  lines.push('')
  lines.push(`统一文本：${SAMPLE_TEXT}`)
  lines.push('')
  lines.push('## 推荐（★ 为听过后挑出的）')
  lines.push('')
  lines.push('| # | 音色 | 性别 | 适用 |')
  lines.push('|---|---|---|---|')
  const picks = rows.filter((r) => r.file && RECOMMENDED_VOICES.has(r.id))
  for (const r of picks) {
    const use =
      r.id === 'zh-HK-WanLungNeural'
        ? '粤语男声，面向粤语受众'
        : r.id === 'zh-CN-XiaoyiNeural'
          ? '普通话女声，偏年轻'
          : r.id === 'zh-CN-YunxiNeural'
            ? '普通话男声，自然百搭'
            : '普通话男声，少年感'
    lines.push(`| ${r.file.slice(0, 2)} | ★ ${r.label} | ${r.gender === 'Female' ? '女' : '男'} | ${use} |`)
  }
  lines.push('')
  lines.push('> 听感因人而异，建议先听 `00-全部音色预览.mp3` 再决定。')
  lines.push('')
  lines.push('## 在线音色（神经语音，接近真人）')
  lines.push('')
  lines.push('| # | 音色 | 性别 | 语言 | 文件 |')
  lines.push('|---|---|---|---|---|')
  for (const r of rows.filter((x) => x.engine === 'edge' && x.file)) {
    lines.push(`| ${r.file.slice(0, 2)} | ${r.label} | ${r.gender === 'Female' ? '女' : r.gender === 'Male' ? '男' : '?'} | ${r.locale} | \`${r.file}\` |`)
  }
  lines.push('')
  lines.push('## 本地离线音色（Windows，机械感明显）')
  lines.push('')
  lines.push('| # | 音色 | 性别 | 文件 |')
  lines.push('|---|---|---|---|')
  for (const r of rows.filter((x) => x.engine === 'local' && x.file)) {
    lines.push(`| ${r.file.slice(0, 2)} | ${r.label} | ${r.gender === 'Female' ? '女' : r.gender === 'Male' ? '男' : '?'} | \`${r.file}\` |`)
  }
  const failed = rows.filter((x) => !x.file)
  if (failed.length) {
    lines.push('')
    lines.push('## 生成失败')
    lines.push('')
    for (const r of failed) lines.push(`- ${r.id}：${r.error}`)
  }
  lines.push('')
  lines.push('## 怎么用')
  lines.push('')
  lines.push('选定音色后，在 script.json 里写：')
  lines.push('')
  lines.push('```json')
  lines.push('{ "voice": { "engine": "edge", "name": "zh-CN-XiaoxiaoNeural" } }')
  lines.push('```')
  lines.push('')
  lines.push('本地音色用：')
  lines.push('')
  lines.push('```bash')
  lines.push('node scripts/remix.mjs render script.json --engine local --voice Kangkang')
  lines.push('```')

  writeFileSync(path.join(outDir, 'README.md'), lines.join('\n'), 'utf8')

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        dir: outDir,
        total: rows.filter((r) => r.file).length,
        edge: rows.filter((r) => r.engine === 'edge' && r.file).length,
        local: rows.filter((r) => r.engine === 'local' && r.file).length,
        failed: rows.filter((r) => !r.file).map((r) => ({ id: r.id, error: r.error })),
      },
      null,
      2,
    ) + '\n',
  )
}

async function cmdVoices(options) {
  const out = { edge: [], local: [] }
  const mod = loadEdgeTts()
  if (mod && mod.EdgeTTS) {
    try {
      const tts = new mod.EdgeTTS()
      const all = await tts.getVoices()
      out.edge = all
        .map((v) => ({
          name: v.ShortName || v.shortName,
          locale: v.Locale || v.locale,
          gender: v.Gender || v.gender,
        }))
        .filter((v) => /^zh/i.test(String(v.locale || '')))
    } catch (error) {
      out.edgeError = error instanceof Error ? error.message : String(error)
    }
  } else {
    out.edgeError = '@andresaya/edge-tts 未安装'
  }

  if (process.platform === 'win32') {
    try {
      const ps1 = path.join(SKILL_ROOT, 'scripts', 'tts-windows.ps1')
      const r = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-List'], { timeoutMs: 60000 })
      out.local = String(r.stdout || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && l.includes('|'))
        .map((l) => {
          const [name, lang, gender] = l.split('|').map((x) => x.trim())
          return { name, locale: lang, gender }
        })
    } catch (error) {
      out.localError = error instanceof Error ? error.message : String(error)
    }
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n')
}

async function cmdAnalyze(ff, positional, options) {
  const source = positional[1]
  if (!source) throw new Error('用法：remix.mjs analyze <video> [--interval 2] [--out dir]')
  const file = path.resolve(source)
  if (!existsSync(file)) throw new Error(`文件不存在：${file}`)

  const interval = Math.min(10, Math.max(0.1, Number(options.interval || 2)))
  const outRoot = options.out ? path.resolve(String(options.out)) : path.join(process.cwd(), '.video-remix')
  const workDir = path.join(outRoot, `${slugify(path.basename(file))}-${Date.now().toString(36)}`)
  mkdirSync(workDir, { recursive: true })

  const meta = await probeMedia(ff, file)
  // ffmpeg's fps filter emits round(duration / interval) frames — measured on
  // 8.02s@0.5 (16), 87.33s@10 (9) and 87.33s@9 (10). floor+1 overshoots.
  const totalFrames = meta.hasVideo ? Math.max(1, Math.round(meta.durationSec / interval)) : 0
  const pageSize = DEFAULTS.cols * DEFAULTS.rows
  const sheetCount = meta.hasVideo ? Math.ceil(totalFrames / pageSize) : 0
  if (sheetCount > DEFAULTS.maxSheets) {
    throw new Error(`按 ${interval}s 需要 ${sheetCount} 页，超过上限 ${DEFAULTS.maxSheets}。请把 --interval 调大。`)
  }

  let sheets = []
  if (meta.hasVideo) {
    const font = pickFont()
    const paths = await extractSheets(ff, file, meta, {
      interval,
      cols: DEFAULTS.cols,
      rows: DEFAULTS.rows,
      cellWidth: DEFAULTS.cellWidth,
      totalFrames,
      font,
    }, workDir)
    sheets = paths.map((p, i) => ({
      page: i + 1,
      path: p,
      from: formatTimestamp(i * pageSize * interval),
      to: formatTimestamp(Math.min(meta.durationSec, (i + 1) * pageSize * interval)),
    }))
  }

  let transcript = { status: 'skipped', segments: [], recordId: null }
  if (!options['no-transcribe'] && meta.hasAudio) {
    const key = resolveItingnaoKey(options['api-key'])
    if (!key) {
      transcript = { status: 'unavailable', segments: [], reason: '未配置 ITINGNAO_API_KEY' }
    } else {
      try {
        const audio = await extractAudio(ff, file, workDir)
        const r = await transcribeAudio(key, audio, meta.durationSec)
        transcript = { status: r.segments.length ? 'completed' : 'empty', recordId: r.recordId, segments: r.segments }
      } catch (error) {
        transcript = { status: 'failed', segments: [], reason: error instanceof Error ? error.message : String(error) }
      }
    }
  } else if (!meta.hasAudio) {
    transcript = { status: 'no-audio', segments: [] }
  }

  const analysis = {
    source: file,
    name: path.basename(file),
    video: meta,
    sampling: { interval, totalFrames, cols: DEFAULTS.cols, rows: DEFAULTS.rows, sheetCount, artifactDir: workDir },
    sheets,
    transcript,
    hint: {
      next: '把 sheets 与 transcript 交给模型，让它写 script.json，再执行 render。',
      scriptShape: {
        title: '视频标题',
        voice: { engine: 'edge', name: 'zh-CN-XiaoxiaoNeural' },
        segments: [{ title: '卡片标题', sub: '卡片副标题', narration: '配音文本' }],
      },
    },
  }
  const analysisPath = path.join(workDir, 'analysis.json')
  writeFileSync(analysisPath, JSON.stringify(analysis, null, 2), 'utf8')
  process.stdout.write(JSON.stringify({ ok: true, analysisPath, analysis }, null, 2) + '\n')
}

const DEFAULT_VOICE_NAME = 'zh-CN-YunxiNeural'

/**
 * Custom audio uploaded by a human lives in <cwd>/音色试听/custom/.
 * Preference: a file prefixed with this segment's number, then one matching
 * the requested name, then the first file (so a single recording still works).
 */
function resolveCustomAudio(name, tag) {
  const dir = path.join(process.cwd(), '音色试听', 'custom')
  if (!existsSync(dir)) return null
  const files = readdirSync(dir)
    .filter((n) => /\.(mp3|wav|m4a|ogg)$/i.test(n))
    .sort()
  if (files.length === 0) return null
  const num = tag.replace(/[^0-9]/g, '')
  const byNumber = files.find((n) => n.startsWith(`${num}-`) || n.startsWith(`${num}.`))
  const byName = name ? files.find((n) => n === name || n.includes(name)) : null
  return path.join(dir, byNumber || byName || files[0])
}

async function cmdRender(ff, positional, options) {
  const scriptPath = positional[1]
  if (!scriptPath) throw new Error('用法：remix.mjs render <script.json> [--out file.mp4]')
  const file = path.resolve(scriptPath)
  if (!existsSync(file)) throw new Error(`脚本不存在：${file}`)
  const script = JSON.parse(readFileSync(file, 'utf8'))
  const segments = Array.isArray(script.segments) ? script.segments : []
  if (segments.length === 0) throw new Error('script.segments 为空')

  const voice = {
    engine: String(options.engine || (script.voice && script.voice.engine) || 'edge'),
    name: String(options.voice || (script.voice && script.voice.name) || 'zh-CN-XiaoxiaoNeural'),
  }
  const outFile = options.out
    ? path.resolve(String(options.out))
    : path.join(process.cwd(), '生成视频', `${slugify(script.title || path.basename(file, '.json'))}.mp4`)
  const workDir = path.join(path.dirname(outFile), `_remix-${Date.now().toString(36)}`)
  mkdirSync(workDir, { recursive: true })
  mkdirSync(path.dirname(outFile), { recursive: true })

  const font = pickFont()
  const theme = { ...THEME, ...(script.theme || {}) }
  const visual = String(options.visual || script.visual || 'cards')
  const rendered = []

  // images mode: stills from a directory, no generation service in the loop
  let imgDir = null
  let imgAvailable = []
  if (visual === 'images') {
    imgDir = options.images
      ? path.resolve(String(options.images))
      : path.join(path.dirname(file), String(script.imageDir || 'img'))
    if (!existsSync(imgDir)) {
      throw new Error(
        `visual="images" 需要配图目录，但 ${imgDir} 不存在。用 --images <目录> 指定，或在 script.json 里设 imageDir。`,
      )
    }
    imgAvailable = readdirSync(imgDir).filter((n) => /\.(png|jpe?g|webp)$/i.test(n)).sort()
    if (imgAvailable.length === 0) throw new Error(`配图目录里没有图片：${imgDir}`)
    process.stderr.write(`配图 ${imgAvailable.length} 张（${imgDir}），按段落循环复用\n`)
  }

  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]
    const narration = String(seg.narration || seg.title || '')
    const tag = `seg${pad2(i + 1)}`
    let audioFile
    if (voice.engine === 'file') {
      const custom = resolveCustomAudio(voice.name, tag)
      if (custom) {
        audioFile = custom
      } else {
        process.stderr.write(`${tag} 没有找到自定义音频，回退到 ${voice.name || '默认音色'}\n`)
        audioFile = await ttsEdge(narration, DEFAULT_VOICE_NAME, path.join(workDir, `${tag}.mp3`))
      }
    } else if (voice.engine === 'local') {
      audioFile = await ttsLocalWindows(narration, voice.name, path.join(workDir, `${tag}.wav`))
    } else {
      audioFile = await ttsEdge(narration, voice.name, path.join(workDir, `${tag}.mp3`))
    }
    const dur = seg.duration ? Number(seg.duration) : await probeDuration(ff, audioFile)
    const segOut = path.join(workDir, `${tag}.mp4`)

    if (visual === 'ai') {
      if (!seg.prompt) {
        throw new Error(`第 ${i + 1} 段缺少 prompt：AI 画面模式要求每段都提供画面提示词。`)
      }
      const clipSec = Math.min(12, Math.max(4, Math.round(dur)))
      const clip = path.join(workDir, `${tag}-ai.mp4`)
      process.stderr.write(`${tag} 生成 AI 画面（${clipSec}s）...\n`)
      await generateAiClip(seg.prompt, clipSec, script.ratio || '16:9', clip, options)
      await muxClipWithVoice(ff, clip, audioFile, segOut, dur + Number(script.gap ?? 0.4))
    } else if (visual === 'images') {
      const imgFile = resolveSegmentImage(imgDir, imgAvailable, i)
      await renderImageSegment(ff, seg, audioFile, dur, imgFile, segOut, {
        page: i + 1,
        total: segments.length,
        width: script.width,
        height: script.height,
        titleSize: script.titleSize,
        subSize: script.subSize,
        zoomRate: script.zoomRate,
        zoomMax: script.zoomMax,
        gap: script.gap,
      }, font)
    } else {
      await renderSegment(ff, seg, audioFile, dur, segOut, {
        page: i + 1,
        total: segments.length,
        theme,
        width: script.width,
        height: script.height,
        titleSize: script.titleSize,
        subSize: script.subSize,
        watermarkText: script.watermarkText,
        leadMs: script.leadMs,
        gap: script.gap,
      }, font)
    }
    rendered.push(segOut)
    process.stderr.write(`${tag} ok  ${dur.toFixed(1)}s\n`)
  }

  await concatSegments(ff, rendered, outFile, workDir)
  if (options.keep) process.stderr.write(`中间文件保留在：${workDir}\n`)
  else rmSync(workDir, { recursive: true, force: true })

  const totalDur = await probeDuration(ff, outFile)
  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        file: outFile,
        bytes: statSync(outFile).size,
        durationSec: Number(totalDur.toFixed(2)),
        segments: segments.length,
        voice,
      },
      null,
      2,
    ) + '\n',
  )
}

/* ------------------------------------------------------------------- main */

function usage() {
  console.log(`video-remix — 分析参考视频，生成新的配音卡片视频

用法：
  node remix.mjs voices                         列出可用音色（在线 Edge / 本地 Windows）
  node remix.mjs samples [--out 目录]           为每个音色生成一段试听小样 + 清单
  node remix.mjs analyze <video> [--interval 2] [--out dir] [--no-transcribe]
  node remix.mjs render <script.json> [--out file.mp4] [--engine edge|local] [--voice 音色名] [--visual cards|images|ai]

--visual cards  文字卡片（默认，快，适合教程）
--visual images 静态图 + 缓慢推镜 + 文字 + 配音（最快有画面的方式；配图放 img/ 或 --images 指定）
--visual ai     每段调 agnes-video 生成真实视频（每条几分钟，服务端可能排队）

script.json 形状：
{
  "title": "视频标题",
  "voice": { "engine": "edge", "name": "zh-CN-XiaoxiaoNeural" },
  "theme": { "bg": "0x0B1220", "accent": "0x4DA3FF" },
  "segments": [
    { "title": "卡片标题", "sub": "卡片副标题", "narration": "要念出来的台词" }
  ]
}

环境：
  FFMPEG_PATH            指定 ffmpeg（否则自动探测）
  ITINGNAO_API_KEY       analyze 的语音转写需要
`)
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2))
  const command = positional[0]
  if (!command || command === 'help' || options.help) {
    usage()
    return
  }

  if (command === 'voices') {
    await cmdVoices(options)
    return
  }

  if (command === 'samples') {
    await cmdSamples(options)
    return
  }

  const ff = resolveFfmpeg(options.ffmpeg)
  if (command === 'analyze') {
    await cmdAnalyze(ff, positional, options)
    return
  }
  if (command === 'render') {
    await cmdRender(ff, positional, options)
    return
  }
  throw new Error(`未知命令：${command}（试试 help）`)
}

main().catch((error) => {
  process.stderr.write(`video-remix: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
