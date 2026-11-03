// qqbot-music 的 DeepSeek Harness 插件：让大肥鱼用你配置的音色唱歌，不会的歌自己去学。
//
// 插件本身不跑模型，只通过 HTTP 调 qqbot-music 的唱歌服务（python -m qqbot_music serve）。
// 服务没开时，如果配置了 startCommand，就用它拉起来；没配置就告诉模型唱不了。
// 工具直接用原始 JSON Schema 注册（ctx.tools.register 接受，MCP 工具也是这样进来的），
// 不 import @deepseek-ai/dsh-tools，所以不用跟着 dsh 的版本号改 peer 依赖。
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-zeroshot-sing'
export const inject = ['tools']

const DEFAULTS = {
  url: 'http://127.0.0.1:8766',
  startCommand: '',
  startCwd: '',
  startSeconds: 120,
  outputDir: '',
  play: true,
  allowFull: true,
  chorusTimeout: 600,
  fullTimeout: 3600,
}

/** 合并用户配置；类型不对的项用默认值。 */
export function resolveConfig(raw = {}) {
  const cfg = { ...DEFAULTS }
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (key in DEFAULTS && typeof value === typeof DEFAULTS[key]) cfg[key] = value
  }
  cfg.url = cfg.url.replace(/\/+$/, '')
  cfg.outputDir ||= path.join(os.homedir(), 'Music', 'qqbot-music')
  return cfg
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function cleanTitle(title) {
  return String(title ?? '').trim().replace(/^[《「"']+|[》」"']+$/g, '').trim()
}

export class Singer {
  constructor(cfg) {
    this.cfg = cfg
    this.starting = null
  }

  async alive() {
    try {
      const r = await fetch(`${this.cfg.url}/ping`, { signal: AbortSignal.timeout(3000) })
      return r.ok
    } catch {
      return false
    }
  }

  /** 服务没开就按配置拉起来；同时来的几次调用共用一次启动。 */
  async ensure() {
    if (await this.alive()) return
    this.starting ??= this.start().finally(() => { this.starting = null })
    await this.starting
  }

  async start() {
    const { startCommand, startCwd, startSeconds } = this.cfg
    if (!startCommand) throw new Error('唱歌服务没开')
    // 独立进程：dsh 重启不带走它，闲置了它自己退
    spawn(startCommand, { cwd: startCwd || undefined, shell: true, detached: true, stdio: 'ignore', windowsHide: true }).unref()
    const deadline = Date.now() + startSeconds * 1000
    while (Date.now() < deadline) {
      await sleep(3000)
      if (await this.alive()) return
    }
    throw new Error('唱歌服务没起来')
  }

  async json(method, route, { query, body, signal } = {}) {
    await this.ensure()
    const url = new URL(`${this.cfg.url}${route}`)
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v)
    const r = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
    })
    const data = await r.json()
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('唱歌服务返回的不是 JSON 对象')
    return data
  }

  async audio(id, full, signal) {
    await this.ensure()
    const seconds = full ? this.cfg.fullTimeout : this.cfg.chorusTimeout
    const r = await fetch(`${this.cfg.url}/sing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, full }),
      signal: AbortSignal.any([AbortSignal.timeout(seconds * 1000), ...(signal ? [signal] : [])]),
    })
    if (!r.ok) throw new Error((await r.text()).slice(0, 120))
    return Buffer.from(await r.arrayBuffer())
  }

  /** 查会不会唱；不会就开始学。 */
  async lookup(title, artist, signal) {
    if (!title) return this.json('GET', '/random', { query: { artist }, signal })
    const found = await this.json('GET', '/find', { query: { title, artist }, signal })
    if (found.status !== 'unknown' && found.status !== 'failed') return found
    return this.json('POST', '/learn', { body: { title, artist }, signal })
  }
}

/** 用系统自带的播放器在本机放出来，不等它放完。 */
export function play(file) {
  const quoted = file.replace(/'/g, "''")
  const [cmd, args] = process.platform === 'win32'
    ? ['powershell', ['-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${quoted}').PlaySync()`]]
    : process.platform === 'darwin'
      ? ['afplay', [file]]
      : ['paplay', [file]]
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.on('error', () => {})
  child.unref()
}

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['sung', 'ready', 'learning', 'failed', 'unknown', 'unavailable'], description: '结果' },
    message: { type: 'string', description: '给模型看的说明' },
    title: { type: 'string', description: '歌名' },
    artist: { type: 'string', description: '原唱' },
    file: { type: 'string', description: '唱好的 WAV 文件路径' },
    lyrics: { type: 'array', items: { type: 'string' }, description: '副歌歌词' },
  },
  required: ['status', 'message'],
  additionalProperties: false,
}

const render = (_args, value) => [{ type: 'text', text: value.message }]

function learnedResult(found, title) {
  if (found.status === 'learning') {
    return { status: 'learning', message: `你还不会唱「${title}」，已经在学了，要几分钟（看显卡），学会后再唱一次就行。` }
  }
  if (found.status === 'failed') {
    return { status: 'failed', message: `「${title}」学不会：${found.error ?? ''}` }
  }
  return null
}

export function singTool(singer) {
  const { cfg } = singer
  return {
    name: 'sing',
    description:
      '用你自己的声音唱歌：唱好后存成 WAV 文件，并在本机放出来。只有用户明确要你唱歌时才用。'
      + '默认只唱副歌；用户明确要整首才把 full 设成 true。用户没指定唱哪首时 title 留空，会从你会唱的歌里随机挑；'
      + '只说了歌手就填 artist、title 留空。不会的歌会先去学，学的时候告诉用户要等几分钟，学会了再唱一次。'
      + '会不会唱只有调用这个工具才知道，不要凭对话里自己说过的话判断。歌名你没听过也原样填，不要自己改成别的歌。'
      + '唱一段副歌要一两分钟，期间耐心等它返回。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '歌名，不带书名号；没指定就留空' },
        artist: { type: 'string', description: '歌手，用户说了才填' },
        full: { type: 'boolean', description: '用户明确要整首时为 true' },
      },
      additionalProperties: false,
    },
    output: { schema: RESULT_SCHEMA, render },
    timeoutMs: (Math.max(cfg.chorusTimeout, cfg.fullTimeout) + cfg.startSeconds + 60) * 1000,
    async execute(args, exec) {
      const title = cleanTitle(args?.title)
      const artist = String(args?.artist ?? '').trim()
      const full = args?.full === true && cfg.allowFull
      let found
      try {
        found = await singer.lookup(title, artist, exec?.signal)
      } catch (err) {
        return { status: 'unavailable', message: `现在唱不了：${err?.message ?? err}` }
      }
      const pending = learnedResult(found, title)
      if (pending) return pending
      if (found.status !== 'ready' || !found.id) {
        return { status: 'unknown', message: title ? `你不会唱「${title}」。` : '你会唱的歌里没有符合要求的。' }
      }
      const song = String(found.title ?? title)
      const singerName = String(found.artist ?? artist)
      let file
      try {
        const wav = await singer.audio(String(found.id), full, exec?.signal)
        await mkdir(cfg.outputDir, { recursive: true })
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
        file = path.join(cfg.outputDir, `${song.replace(/[\\/:*?"<>|]/g, '_')}_${full ? '整首' : '副歌'}_${stamp}.wav`)
        await writeFile(file, wav)
      } catch (err) {
        return { status: 'unavailable', message: `没唱出来：${err?.message ?? err}` }
      }
      if (cfg.play) play(file)
      const lyrics = Array.isArray(found.lyrics) ? found.lyrics.map(String) : []
      return {
        status: 'sung',
        message: `唱好了《${song}》${singerName ? `（${singerName}）` : ''}${full ? '整首' : '副歌'}，`
          + `${cfg.play ? '正在本机播放，' : ''}文件在 ${file}。${lyrics.length && !full ? `副歌歌词：${lyrics.join('／')}` : ''}`,
        title: song,
        artist: singerName,
        file,
        lyrics,
      }
    },
  }
}

export function learnTool(singer) {
  return {
    name: 'learn_song',
    description:
      '去学一首歌：自己找原唱、下载、分离人声和伴奏，学会后就能用 sing 唱。'
      + '用户让你去学某首歌、或者想先把几首歌学好以后再唱时用；用户要你现在就唱时直接用 sing，它会自己去学。'
      + '学一首要几分钟（看显卡），这个工具只负责开始学，马上返回。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '歌名，不带书名号' },
        artist: { type: 'string', description: '歌手，用户说了才填' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    output: { schema: RESULT_SCHEMA, render },
    timeoutMs: (singer.cfg.startSeconds + 60) * 1000,
    async execute(args, exec) {
      const title = cleanTitle(args?.title)
      const artist = String(args?.artist ?? '').trim()
      if (!title) return { status: 'unknown', message: '要学哪首歌？没给歌名。' }
      let found
      try {
        found = await singer.lookup(title, artist, exec?.signal)
      } catch (err) {
        return { status: 'unavailable', message: `现在学不了：${err?.message ?? err}` }
      }
      const pending = learnedResult(found, title)
      if (pending) return pending
      if (found.status === 'ready') {
        return { status: 'ready', message: `「${found.title ?? title}」已经会唱了，想听就用 sing。`, title: String(found.title ?? title), artist: String(found.artist ?? artist) }
      }
      return { status: 'unknown', message: `「${title}」现在学不了。` }
    },
  }
}

export function apply(ctx, rawConfig) {
  const singer = new Singer(resolveConfig(rawConfig))
  ctx.tools.register(singTool(singer))
  ctx.tools.register(learnTool(singer))
}
