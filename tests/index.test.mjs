// 用一个假的唱歌服务测两个工具；不需要 dsh、显卡和真的 qqbot-music。
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

import { apply, resolveConfig } from '../lib/index.js'

const WAV = Buffer.from('RIFF....WAVEfake')
const songs = { 晴天: { status: 'ready', id: 's1', title: '晴天', artist: '周杰伦', lyrics: ['刮风这天', '我试过握着你手'] } }
const learning = new Set()
let server, url, dir

before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const json = (obj) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)) }
      if (u.pathname === '/ping') return res.end('ok')
      if (u.pathname === '/find') {
        const t = u.searchParams.get('title')
        return json(songs[t] ?? { status: learning.has(t) ? 'learning' : 'unknown' })
      }
      if (u.pathname === '/random') return json(songs.晴天)
      if (u.pathname === '/learn') {
        learning.add(JSON.parse(body).title)
        return json({ status: 'learning' })
      }
      if (u.pathname === '/sing') {
        assert.equal(JSON.parse(body).id, 's1')
        res.setHeader('content-type', 'audio/wav')
        return res.end(WAV)
      }
      res.statusCode = 404
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${server.address().port}`
  dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-zeroshot-sing-'))
})

after(async () => {
  server.close()
  await rm(dir, { recursive: true, force: true })
})

function load(config) {
  const tools = {}
  apply({ tools: { register: (t) => { tools[t.name] = t } } }, { url, outputDir: dir, play: false, ...config })
  return tools
}

test('配置：类型不对的项用默认值，地址去掉末尾斜杠', () => {
  const cfg = resolveConfig({ url: 'http://a:1/', play: 'yes', chorusTimeout: 5 })
  assert.equal(cfg.url, 'http://a:1')
  assert.equal(cfg.play, true)
  assert.equal(cfg.chorusTimeout, 5)
})

test('注册 sing 和 learn_song，结构是 dsh 要求的', () => {
  const tools = load()
  assert.deepEqual(Object.keys(tools).sort(), ['learn_song', 'sing'])
  for (const t of Object.values(tools)) {
    assert.equal(typeof t.output.render, 'function')
    assert.equal(t.parameters.additionalProperties, false)
    assert.ok(t.timeoutMs > 0)
  }
})

test('会唱：存成文件并返回歌词', async () => {
  const r = await load().sing.execute({ title: '《晴天》' }, { signal: AbortSignal.timeout(5000) })
  assert.equal(r.status, 'sung')
  assert.equal(r.title, '晴天')
  assert.deepEqual(await readFile(r.file), WAV)
  assert.match(r.message, /刮风这天／我试过握着你手/)
})

test('不会：开始学，再问就是在学', async () => {
  const { sing, learn_song } = load()
  assert.equal((await sing.execute({ title: '小幸运' }, {})).status, 'learning')
  assert.equal((await learn_song.execute({ title: '小幸运' }, {})).status, 'learning')
  assert.equal((await learn_song.execute({ title: '晴天' }, {})).status, 'ready')
})

test('服务没开也没配启动命令：告诉模型唱不了', async () => {
  const tools = load({ url: 'http://127.0.0.1:9' })
  const r = await tools.sing.execute({ title: '晴天' }, {})
  assert.equal(r.status, 'unavailable')
  assert.match(r.message, /唱歌服务没开/)
})
