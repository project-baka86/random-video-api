import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { InstanceReporter } from '../lib/reporter.js'
import { VideoStore } from '../lib/store.js'

const silent = { info() {}, warn() {}, error() {} }

function makeCtx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-reporter-'))
  const cacheDir = path.join(dir, 'cache')
  fs.mkdirSync(cacheDir, { recursive: true })
  const store = new VideoStore({ file: path.join(dir, 'videolist.json') })
  return { dir, cacheDir, store }
}

test('buildPayload 标记本地缓存状态', () => {
  const { cacheDir, store } = makeCtx()
  store.add({ bvid: 'BV1xx411c7mD', title: '已缓存' })
  store.add({ bvid: 'BV1GJ411x7h7', title: '未缓存' })
  fs.writeFileSync(path.join(cacheDir, 'BV1xx411c7mD.mp4'), 'x')

  const reporter = new InstanceReporter({
    hubUrl: 'http://hub:3000',
    instanceId: 'node-a',
    instanceUrl: 'http://node-a:3000',
    store,
    cacheDir,
    logger: silent
  })
  const payload = reporter.buildPayload()
  assert.equal(payload.instance_id, 'node-a')
  assert.equal(payload.url, 'http://node-a:3000')
  assert.equal(payload.videos.length, 2)
  assert.equal(payload.videos.find((v) => v.bvid === 'BV1xx411c7mD').cached, true)
  assert.equal(payload.videos.find((v) => v.bvid === 'BV1GJ411x7h7').cached, false)
})

test('reportOnce 上报到 Hub 并携带集群令牌', async () => {
  const { cacheDir, store } = makeCtx()
  store.add({ bvid: 'BV1xx411c7mD', title: '抽象' })

  const calls = []
  const reporter = new InstanceReporter({
    hubUrl: 'http://hub:3000/',
    instanceId: 'node-a',
    instanceUrl: 'http://node-a:3000',
    token: 'cluster-secret',
    store,
    cacheDir,
    logger: silent,
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return { ok: true, status: 200, json: async () => ({ instance_count: 1, catalog_size: 1 }) }
    }
  })

  const result = await reporter.reportOnce()
  assert.equal(result.instance_count, 1)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://hub:3000/api/instances/report')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['X-Instance-Token'], 'cluster-secret')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer cluster-secret')
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.instance_id, 'node-a')
  assert.equal(body.videos[0].bvid, 'BV1xx411c7mD')
})

test('reportOnce 失败返回 null 并记录错误，不抛异常', async () => {
  const { cacheDir, store } = makeCtx()
  const reporter = new InstanceReporter({
    hubUrl: 'http://hub:3000',
    instanceId: 'node-a',
    instanceUrl: 'http://node-a:3000',
    store,
    cacheDir,
    logger: silent,
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) })
  })
  assert.equal(await reporter.reportOnce(), null)
  assert.match(reporter.lastError.message, /500/)
})

test('start/stop 管理定时上报', async () => {
  const { cacheDir, store } = makeCtx()
  const reporter = new InstanceReporter({
    hubUrl: 'http://hub:3000',
    instanceId: 'node-a',
    instanceUrl: 'http://node-a:3000',
    interval: 60_000,
    store,
    cacheDir,
    logger: silent,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) })
  })
  reporter.start()
  assert.ok(reporter.timer)
  assert.throws(() => new InstanceReporter({ store, cacheDir, logger: silent }).start(), /HUB_URL/)
  reporter.stop()
  assert.equal(reporter.timer, null)
})
