import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { VideoStore, normalizeBvid, resolveDataFile } from '../lib/store.js'

function tmpFile(name = 'videolist.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-store-'))
  return path.join(dir, name)
}

test('normalizeBvid 提取并统一 BV 前缀大小写', () => {
  assert.equal(normalizeBvid('BV1xx411c7mD'), 'BV1xx411c7mD')
  assert.equal(normalizeBvid('bv1xx411c7mD'), 'BV1xx411c7mD')
  assert.equal(normalizeBvid('看看这个 https://www.bilibili.com/video/BV1xx411c7mD 很抽象'), 'BV1xx411c7mD')
  assert.equal(normalizeBvid('#添加抽象视频BV1xx411c7mD'), 'BV1xx411c7mD')
  assert.equal(normalizeBvid('BV123'), null)
  assert.equal(normalizeBvid(''), null)
  assert.equal(normalizeBvid(null), null)
})

test('resolveDataFile 支持环境变量但显式参数优先', () => {
  const explicit = '/tmp/explicit.json'
  assert.equal(resolveDataFile(explicit), explicit)
  const old = process.env.VIDEO_DATA_FILE
  process.env.VIDEO_DATA_FILE = '/tmp/from-env.json'
  try {
    assert.equal(resolveDataFile(), '/tmp/from-env.json')
    assert.equal(resolveDataFile(explicit), explicit)
  } finally {
    if (old === undefined) delete process.env.VIDEO_DATA_FILE
    else process.env.VIDEO_DATA_FILE = old
  }
})

test('VideoStore 初始化、增删查与持久化', () => {
  const file = tmpFile()
  const store = new VideoStore({ file })
  assert.ok(fs.existsSync(file))
  assert.deepEqual(store.list(), [])
  assert.equal(store.count(), 0)

  const { added, item } = store.add({ bvid: 'bv1xx411c7mD', title: '抽象一' })
  assert.equal(added, true)
  assert.equal(item.bvid, 'BV1xx411c7mD')
  assert.equal(store.count(), 1)
  assert.equal(store.has('BV1xx411c7mD'), true)
  assert.equal(store.find('BV1xx411c7mD').title, '抽象一')

  // 重复添加不覆盖
  const second = store.add({ bvid: 'BV1xx411c7mD', title: '被覆盖' })
  assert.equal(second.added, false)
  assert.equal(store.count(), 1)
  assert.equal(store.find('BV1xx411c7mD').title, '抽象一')

  // 重新打开仍是同一份数据
  const reopened = new VideoStore({ file })
  assert.equal(reopened.count(), 1)

  // upsert 覆盖字段
  store.upsert('BV1xx411c7mD', { title: '新标题' })
  assert.equal(store.find('BV1xx411c7mD').title, '新标题')

  assert.equal(store.remove('BV1xx411c7mD'), true)
  assert.equal(store.remove('BV1xx411c7mD'), false)
  assert.equal(store.count(), 0)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), [])
})

test('VideoStore 遇到损坏的 JSON 返回空列表而不是抛错', () => {
  const file = tmpFile()
  fs.writeFileSync(file, '{ 这不是 json', 'utf-8')
  const store = new VideoStore({ file })
  assert.deepEqual(store.list(), [])
  // 仍然可以正常写入修复
  store.add({ bvid: 'BV1xx411c7mD', title: 'ok' })
  assert.equal(store.count(), 1)
})

test('VideoStore.add 拒绝非法 BV 号', () => {
  const store = new VideoStore({ file: tmpFile() })
  assert.throws(() => store.add({ bvid: 'not-a-bvid' }), /无效的 BV 号/)
})
