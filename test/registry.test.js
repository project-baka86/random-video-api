import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { InstanceRegistry, normalizeInstanceUrl, validateReport } from '../lib/registry.js'

const silent = { info() {}, warn() {}, error() {} }

function tmpRegistry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-registry-'))
  return path.join(dir, 'instances.json')
}

const report = (overrides = {}) => ({
  instance_id: 'node-a',
  url: 'http://10.0.0.5:3000/',
  name: '群一机器人',
  videos: [
    { bvid: 'BV1xx411c7mD', title: '抽象一', cached: true },
    'BV1GJ411x7h7',
    { bvid: 'bv1xx411c7mD', title: '重复项应被忽略' }
  ],
  ...overrides
})

test('normalizeInstanceUrl 去掉末尾斜杠', () => {
  assert.equal(normalizeInstanceUrl('http://a:3000/'), 'http://a:3000')
  assert.equal(normalizeInstanceUrl('http://a:3000///'), 'http://a:3000')
  assert.equal(normalizeInstanceUrl(''), '')
  assert.equal(normalizeInstanceUrl(null), '')
})

test('validateReport 规范化并去重视频列表', () => {
  const parsed = validateReport(report())
  assert.equal(parsed.id, 'node-a')
  assert.equal(parsed.url, 'http://10.0.0.5:3000')
  assert.equal(parsed.videos.length, 2)
  assert.deepEqual(parsed.videos[0], { bvid: 'BV1xx411c7mD', title: '抽象一', cached: true })
  assert.deepEqual(parsed.videos[1], { bvid: 'BV1GJ411x7h7', title: '', cached: false })
})

test('validateReport 拒绝非法上报', () => {
  assert.throws(() => validateReport(null), /JSON 对象/)
  assert.throws(() => validateReport({ url: 'http://a' }), /instance_id/)
  assert.throws(() => validateReport({ instance_id: 'a' }), /url/)
  assert.throws(() => validateReport(report({ url: 'ftp://a' })), /http/)
})

test('report 是 upsert：保留 firstSeen、累加 reports、隐藏 token', () => {
  let now = 1000
  const registry = new InstanceRegistry({ ttl: 100, logger: silent, now: () => now })
  const first = registry.report(report({ token: 'secret' }))
  assert.equal(first.instance_count, 1)
  assert.equal(first.instance.reports, 1)
  assert.equal(first.instance.video_count, 2)
  assert.equal(first.instance.token, undefined, '对外不应暴露实例 token')

  now = 2000
  const second = registry.report(report({ videos: [{ bvid: 'BV1GJ411x7h7', cached: true }] }))
  assert.equal(second.instance.reports, 2)
  assert.equal(second.instance.firstSeen, 1000)
  assert.equal(second.instance.lastSeen, 2000)
  assert.equal(second.instance.video_count, 1)
  assert.equal(registry.size(), 1)
})

test('心跳超时后实例不健康并被 prune 清理', () => {
  let now = 10_000
  const registry = new InstanceRegistry({ ttl: 100, logger: silent, now: () => now })
  registry.report(report())
  assert.equal(registry.list({ healthyOnly: true }).length, 1)
  assert.equal(registry.providers('BV1xx411c7mD').length, 1)

  now += 101
  assert.equal(registry.list({ healthyOnly: true }).length, 0)
  assert.equal(registry.providers('BV1xx411c7mD').length, 0, '不健康实例不应参与分发')
  assert.deepEqual(registry.prune(), ['node-a'])
  assert.equal(registry.size(), 0)
})

test('catalog 聚合多个实例，providers 携带可直链地址', () => {
  const registry = new InstanceRegistry({ ttl: 10_000, logger: silent })
  registry.report(report())
  registry.report({ instance_id: 'node-b', url: 'http://10.0.0.6:3000', videos: [{ bvid: 'BV1xx411c7mD', title: '抽象B', cached: false }] })

  const catalog = registry.catalog()
  assert.equal(catalog.size, 2)
  const entry = catalog.get('BV1xx411c7mD')
  assert.equal(entry.providers.length, 2)
  assert.equal(entry.providers[0].streamUrl, 'http://10.0.0.5:3000/api/video/BV1xx411c7mD')

  const providers = registry.providers('BV1GJ411x7h7')
  assert.equal(providers.length, 1)
  assert.equal(providers[0].id, 'node-a')
  assert.equal(registry.providers('BV1zz411c7mQ').length, 0)
  assert.equal(registry.providers('not-a-bvid').length, 0)
})

test('注册表可持久化并在重启后恢复，remove/prune 会写回文件', () => {
  const file = tmpRegistry()
  const registry = new InstanceRegistry({ ttl: 10_000, file, logger: silent })
  registry.report(report())

  const reloaded = new InstanceRegistry({ ttl: 10_000, file, logger: silent })
  assert.equal(reloaded.size(), 1)
  assert.equal(reloaded.get('node-a').video_count, 2)

  assert.equal(reloaded.remove('node-a'), true)
  assert.equal(reloaded.remove('node-a'), false)
  assert.equal(new InstanceRegistry({ ttl: 10_000, file, logger: silent }).size(), 0)
})

test('损坏的注册表文件不会导致崩溃', () => {
  const file = tmpRegistry()
  fs.writeFileSync(file, '{ 坏文件', 'utf-8')
  const registry = new InstanceRegistry({ ttl: 10_000, file, logger: silent })
  assert.equal(registry.size(), 0)
  registry.report(report())
  assert.equal(registry.size(), 1)
})

test('markCached 立即更新实例缓存标记，无需等下一次心跳', () => {
  const registry = new InstanceRegistry({ ttl: 10_000, logger: silent })
  registry.report(report({ videos: [{ bvid: 'BV1xx411c7mD', cached: false }] }))
  assert.equal(registry.providers('BV1xx411c7mD')[0].cached, false)

  assert.equal(registry.markCached('node-a', 'BV1xx411c7mD', true), true)
  assert.equal(registry.providers('BV1xx411c7mD')[0].cached, true)

  // 未知实例 / 非法 bvid
  assert.equal(registry.markCached('nope', 'BV1xx411c7mD'), false)
  assert.equal(registry.markCached('node-a', 'not-a-bvid'), false)

  // 新视频会被加入该实例的目录
  assert.equal(registry.markCached('node-a', 'BV1GJ411x7h7', true), true)
  assert.equal(registry.providers('BV1GJ411x7h7').length, 1)
  assert.equal(registry.providers('BV1GJ411x7h7')[0].cached, true)
})
