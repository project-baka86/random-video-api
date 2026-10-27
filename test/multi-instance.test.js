import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { createApiServer } from '../lib/api-server.js'
import { VideoStore } from '../lib/store.js'
import { InstanceRegistry } from '../lib/registry.js'
import { InstanceReporter } from '../lib/reporter.js'
import { BilibiliError } from '../lib/bilibili.js'

const VALID_BVID = 'BV1xx411c7mD'
const VIDEO = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256))
const CLUSTER_TOKEN = 'cluster-secret'
const CLUSTER_HEADERS = { 'X-Instance-Token': CLUSTER_TOKEN }

function makeMockBilibili() {
  return {
    async getVideoInfo(bvid) {
      if (bvid !== VALID_BVID) throw new BilibiliError('视频不存在', { code: -404, status: 404 })
      return { bvid, cid: 123456, title: '抽象测试视频', duration: 12, pic: 'http://pic.test/c.jpg' }
    },
    async getPlayUrl(bvid, cid) {
      return { url: `https://upstream.test/${bvid}.mp4?cid=${cid}`, size: VIDEO.length, length: 12 }
    },
    async openVideoStream() {
      return {
        status: 200,
        ok: true,
        headers: new Headers({ 'content-length': String(VIDEO.length) }),
        body: Readable.toWeb(Readable.from([VIDEO])),
        abort() {}
      }
    },
    BilibiliError
  }
}

/** Hub 自身不直连 B 站，用于验证分发确实走了实例。 */
const hubBilibili = {
  async getVideoInfo() {
    throw new BilibiliError('hub 未直连 B 站', { status: 502 })
  },
  async getPlayUrl() {
    throw new BilibiliError('hub 未直连 B 站', { status: 502 })
  },
  async openVideoStream() {
    throw new BilibiliError('hub 未直连 B 站', { status: 502 })
  },
  BilibiliError
}

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)))

async function setup({
  strategy,
  ttl,
  hubApiToken = '',
  hubInstanceToken = CLUSTER_TOKEN,
  nodeInstanceToken = CLUSTER_TOKEN,
  reporterToken = CLUSTER_TOKEN
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-multi-'))
  const warnings = []
  const captureLogger = { info() {}, warn: (m) => warnings.push(String(m)), error() {} }
  const silent = { info() {}, warn() {}, error() {} }

  const registry = new InstanceRegistry({ ttl: ttl ?? 60_000, logger: silent })
  const hubCache = path.join(dir, 'hub-cache')
  const hubServer = createApiServer({
    store: new VideoStore({ file: path.join(dir, 'hub-list.json') }),
    registry,
    bilibili: hubBilibili,
    cacheDir: hubCache,
    instanceId: 'hub',
    instanceToken: hubInstanceToken,
    token: hubApiToken,
    strategy,
    logger: captureLogger
  })
  const hubBase = await listen(hubServer)

  const nodeCache = path.join(dir, 'node-cache')
  const nodeStore = new VideoStore({ file: path.join(dir, 'node-list.json') })
  nodeStore.add({ bvid: VALID_BVID, title: '抽象测试视频' })
  const nodeServer = createApiServer({
    store: nodeStore,
    bilibili: makeMockBilibili(),
    cacheDir: nodeCache,
    instanceId: 'node-a',
    instanceToken: nodeInstanceToken,
    logger: silent
  })
  const nodeBase = await listen(nodeServer)

  const reporter = new InstanceReporter({
    hubUrl: hubBase,
    instanceId: 'node-a',
    instanceUrl: nodeBase,
    token: reporterToken,
    store: nodeStore,
    cacheDir: nodeCache,
    logger: silent
  })

  return {
    dir,
    hubBase,
    nodeBase,
    hubCacheDir: hubCache,
    nodeCacheDir: nodeCache,
    registry,
    warnings,
    reporter,
    async close() {
      reporter.stop()
      registry.stopSweeper()
      await new Promise((r) => nodeServer.close(r))
      await new Promise((r) => hubServer.close(r))
    }
  }
}

test('实例上报后 Hub 聚合目录，并支持刷新分发为直链与代理', async () => {
  const ctx = await setup()
  try {
    const ack = await ctx.reporter.reportOnce()
    assert.equal(ack.instance_count, 1)
    assert.equal(ack.catalog_size, 1)

    const health = await (await fetch(`${ctx.hubBase}/health`)).json()
    assert.equal(health.role, 'hub')
    assert.equal(health.instances, 1)

    const catalog = await (await fetch(`${ctx.hubBase}/api/catalog`, { headers: CLUSTER_HEADERS })).json()
    assert.equal(catalog.total, 1)
    assert.equal(catalog.videos[0].bvid, VALID_BVID)
    assert.equal(catalog.videos[0].providers[0].id, 'node-a')
    assert.equal(catalog.videos[0].providers[0].url, ctx.nodeBase)

    const instances = await (await fetch(`${ctx.hubBase}/api/instances`, { headers: CLUSTER_HEADERS })).json()
    assert.equal(instances.total, 1)
    assert.equal(instances.instances[0].healthy, true)

    // JSON：返回远端实例直链
    const random = await (await fetch(`${ctx.hubBase}/api/random`, { headers: CLUSTER_HEADERS })).json()
    assert.equal(random.bvid, VALID_BVID)
    assert.equal(random.provider.kind, 'remote')
    assert.equal(random.direct_url, `${ctx.nodeBase}/api/video/${VALID_BVID}`)

    // redirect：302 到实例
    const redirected = await fetch(`${ctx.hubBase}/api/video/${VALID_BVID}?delivery=redirect`, {
      headers: CLUSTER_HEADERS,
      redirect: 'manual'
    })
    assert.equal(redirected.status, 302)
    assert.equal(redirected.headers.get('location'), `${ctx.nodeBase}/api/video/${VALID_BVID}`)

    // proxy：Hub 反向代理实例流量
    const proxied = await fetch(`${ctx.hubBase}/api/video/${VALID_BVID}?delivery=proxy`, {
      headers: CLUSTER_HEADERS
    })
    assert.equal(proxied.status, 200)
    assert.equal(proxied.headers.get('content-type'), 'video/mp4')
    const buf = Buffer.from(await proxied.arrayBuffer())
    assert.ok(buf.equals(VIDEO), '代理内容应与实例返回一致')
  } finally {
    await ctx.close()
  }
})

test('Hub 代理分发支持 Range 断点续传透传', async () => {
  const ctx = await setup()
  try {
    await ctx.reporter.reportOnce()
    const res = await fetch(`${ctx.hubBase}/api/video/${VALID_BVID}?delivery=proxy`, {
      headers: { ...CLUSTER_HEADERS, Range: 'bytes=10-19' }
    })
    assert.equal(res.status, 206)
    assert.equal(res.headers.get('content-range'), `bytes 10-19/${VIDEO.length}`)
    const slice = Buffer.from(await res.arrayBuffer())
    assert.ok(slice.equals(VIDEO.subarray(10, 20)))
  } finally {
    await ctx.close()
  }
})

test('代理分发遇到故障实例会自动故障转移', async () => {
  const ctx = await setup({ strategy: 'cached-first' })
  try {
    // 上线一个「已缓存」但地址打不通的实例，排序上会排在真实实例前面
    const dead = await fetch(`${ctx.hubBase}/api/instances/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Instance-Token': CLUSTER_TOKEN },
      body: JSON.stringify({
        instance_id: 'node-dead',
        url: 'http://127.0.0.1:1',
        videos: [{ bvid: VALID_BVID, title: '坏实例', cached: true }]
      })
    })
    assert.equal(dead.status, 200)
    await ctx.reporter.reportOnce()

    const res = await fetch(`${ctx.hubBase}/api/video/${VALID_BVID}?delivery=proxy`, {
      headers: CLUSTER_HEADERS
    })
    assert.equal(res.status, 200)
    const buf = Buffer.from(await res.arrayBuffer())
    assert.ok(buf.equals(VIDEO), '应回退到健康实例')
    assert.ok(
      ctx.warnings.some((m) => m.includes('node-dead')),
      `应记录故障实例告警，实际告警: ${ctx.warnings.join(' | ')}`
    )
  } finally {
    await ctx.close()
  }
})

test('实例心跳超时后不再参与分发', async () => {
  const ctx = await setup({ ttl: 100 })
  try {
    await ctx.reporter.reportOnce()
    assert.equal((await (await fetch(`${ctx.hubBase}/api/catalog`, { headers: CLUSTER_HEADERS })).json()).total, 1)

    // 模拟心跳过期
    ctx.registry.instances.get('node-a').lastSeen = Date.now() - 10_000
    assert.equal((await (await fetch(`${ctx.hubBase}/api/catalog`, { headers: CLUSTER_HEADERS })).json()).total, 0)
    const instances = await (await fetch(`${ctx.hubBase}/api/instances`, { headers: CLUSTER_HEADERS })).json()
    assert.equal(instances.instances[0].healthy, false)

    const res = await fetch(`${ctx.hubBase}/api/video/${VALID_BVID}?delivery=redirect`, {
      headers: CLUSTER_HEADERS,
      redirect: 'manual'
    })
    // 没有健康实例可派发，且 Hub 不在本机解析 -> 409（而不是回源 B 站）
    assert.equal(res.status, 409)
    assert.match((await res.json()).error, /本机未保存/)
  } finally {
    await ctx.close()
  }
})

test('上报接口需要集群令牌，注销实例后目录同步移除', async () => {
  const ctx = await setup()
  try {
    const body = JSON.stringify({
      instance_id: 'node-x',
      url: 'http://127.0.0.1:9',
      videos: [{ bvid: VALID_BVID }]
    })

    const noToken = await fetch(`${ctx.hubBase}/api/instances/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    })
    assert.equal(noToken.status, 401)

    const wrongToken = await fetch(`${ctx.hubBase}/api/instances/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Instance-Token': 'nope' },
      body
    })
    assert.equal(wrongToken.status, 401)

    const ok = await fetch(`${ctx.hubBase}/api/instances/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Instance-Token': CLUSTER_TOKEN },
      body
    })
    assert.equal(ok.status, 200)

    const badPayload = await fetch(`${ctx.hubBase}/api/instances/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Instance-Token': CLUSTER_TOKEN },
      body: JSON.stringify({ instance_id: 'no-url' })
    })
    assert.equal(badPayload.status, 400)

    const removed = await fetch(`${ctx.hubBase}/api/instances/node-x`, {
      method: 'DELETE',
      headers: CLUSTER_HEADERS
    })
    assert.equal(removed.status, 200)
    const again = await fetch(`${ctx.hubBase}/api/instances/node-x`, {
      method: 'DELETE',
      headers: CLUSTER_HEADERS
    })
    assert.equal(again.status, 404)
  } finally {
    await ctx.close()
  }
})

test('random?format=stream 在 Hub 上直接代理实例视频', async () => {
  const ctx = await setup()
  try {
    await ctx.reporter.reportOnce()
    const res = await fetch(`${ctx.hubBase}/api/random?format=stream`, { headers: CLUSTER_HEADERS })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'video/mp4')
    const buf = Buffer.from(await res.arrayBuffer())
    assert.ok(buf.equals(VIDEO))
  } finally {
    await ctx.close()
  }
})

test('实例下载默认需要令牌，Hub 代理会自带集群令牌', async () => {
  const ctx = await setup()
  try {
    // 匿名直接下载实例 -> 拒绝
    const anon = await fetch(`${ctx.nodeBase}/api/video/${VALID_BVID}`)
    assert.equal(anon.status, 401)
    const anonRandom = await fetch(`${ctx.nodeBase}/api/random`)
    assert.equal(anonRandom.status, 401)

    // 带集群令牌直接下载 -> 允许
    const authorized = await fetch(`${ctx.nodeBase}/api/video/${VALID_BVID}`, {
      headers: { 'X-Instance-Token': CLUSTER_TOKEN }
    })
    assert.equal(authorized.status, 200)
    await authorized.arrayBuffer()

    // Hub 代理到实例时自动携带令牌，无需人工干预
    await ctx.reporter.reportOnce()
    const proxied = await fetch(`${ctx.hubBase}/api/video/${VALID_BVID}?delivery=proxy`, {
      headers: CLUSTER_HEADERS
    })
    assert.equal(proxied.status, 200)
    await proxied.arrayBuffer()
  } finally {
    await ctx.close()
  }
})

test('Hub 只配置 API_TOKEN 时 reporter 仍能上报，下载需 API_TOKEN', async () => {
  const ctx = await setup({
    hubApiToken: 'api-secret',
    hubInstanceToken: '',
    nodeInstanceToken: '',
    reporterToken: 'api-secret'
  })
  try {
    const ack = await ctx.reporter.reportOnce()
    assert.equal(ack.instance_count, 1, 'reporter 应能用 Authorization: Bearer 上报')

    const anon = await fetch(`${ctx.hubBase}/api/video/${VALID_BVID}?delivery=proxy`)
    assert.equal(anon.status, 401)

    const authorized = await fetch(`${ctx.hubBase}/api/video/${VALID_BVID}?delivery=proxy`, {
      headers: { Authorization: 'Bearer api-secret' }
    })
    assert.equal(authorized.status, 200)
    const buf = Buffer.from(await authorized.arrayBuffer())
    assert.ok(buf.equals(VIDEO))
  } finally {
    await ctx.close()
  }
})

test('Hub 把「解析+保存」派发给 bot 实例，Hub 本地不落盘', async () => {
  const ctx = await setup()
  try {
    await ctx.reporter.reportOnce()
    const res = await fetch(`${ctx.hubBase}/api/videos/${VALID_BVID}/prepare`, {
      method: 'POST',
      headers: CLUSTER_HEADERS
    })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.dispatched, true, 'Hub 应标记为派发')
    assert.equal(data.instance_id, 'node-a')
    assert.equal(data.saved, true)
    assert.equal(data.size, VIDEO.length)

    // 视频保存在 bot 实例上
    assert.ok(
      fs.existsSync(path.join(ctx.nodeCacheDir, `${VALID_BVID}.mp4`)),
      'bot 实例应保存了视频文件'
    )
    // Hub 本地不保存
    assert.equal(
      fs.existsSync(path.join(ctx.hubCacheDir, `${VALID_BVID}.mp4`)),
      false,
      'Hub 不应自己保存视频'
    )
    // 目录 cached 状态立即更新
    const catalog = await (await fetch(`${ctx.hubBase}/api/catalog`, { headers: CLUSTER_HEADERS })).json()
    assert.equal(catalog.videos[0].providers[0].id, 'node-a')
    assert.equal(catalog.videos[0].providers[0].cached, true)
  } finally {
    await ctx.close()
  }
})

test('Hub 对未知视频自动派发实例解析保存后再分发', async () => {
  const ctx = await setup()
  try {
    // 实例上报空清单：Hub 目录里没有该视频
    const rep = await fetch(`${ctx.hubBase}/api/instances/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...CLUSTER_HEADERS },
      body: JSON.stringify({ instance_id: 'node-a', url: ctx.nodeBase, videos: [] })
    })
    assert.equal(rep.status, 200)
    assert.equal((await (await fetch(`${ctx.hubBase}/api/catalog`, { headers: CLUSTER_HEADERS })).json()).total, 0)

    // Hub 上没有来源 -> 自动派发实例解析保存，再代理返回
    const res = await fetch(`${ctx.hubBase}/api/video/${VALID_BVID}?delivery=proxy`, {
      headers: CLUSTER_HEADERS
    })
    assert.equal(res.status, 200)
    const buf = Buffer.from(await res.arrayBuffer())
    assert.ok(buf.equals(VIDEO))
    assert.ok(
      fs.existsSync(path.join(ctx.nodeCacheDir, `${VALID_BVID}.mp4`)),
      'bot 实例应已保存视频'
    )
    assert.equal((await (await fetch(`${ctx.hubBase}/api/catalog`, { headers: CLUSTER_HEADERS })).json()).total, 1)
  } finally {
    await ctx.close()
  }
})

test('实例的 prepare 接口在本机解析并保存到缓存', async () => {
  const ctx = await setup()
  try {
    // 匿名调用实例 prepare 被拒绝
    const anon = await fetch(`${ctx.nodeBase}/api/videos/${VALID_BVID}/prepare`, { method: 'POST' })
    assert.equal(anon.status, 401)

    const res = await fetch(`${ctx.nodeBase}/api/videos/${VALID_BVID}/prepare`, {
      method: 'POST',
      headers: CLUSTER_HEADERS
    })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.dispatched, false)
    assert.equal(data.instance_id, 'node-a')
    assert.equal(data.cached, true)
    assert.ok(fs.existsSync(path.join(ctx.nodeCacheDir, `${VALID_BVID}.mp4`)))
  } finally {
    await ctx.close()
  }
})
