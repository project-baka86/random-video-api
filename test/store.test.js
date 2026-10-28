import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { VideoStore, normalizeBvid, resolveDataFile, formatLocalTime, describeSource } from '../lib/store.js'

test('formatLocalTime 输出本地时间，非法输入返回空串', () => {
  assert.equal(formatLocalTime(new Date(2026, 9, 28, 21, 0, 5)), '2026-10-28 21:00:05')
  assert.equal(formatLocalTime('not-a-date'), '')
})

test('describeSource 组装上传者/群聊/时间标注', () => {
  assert.equal(
    describeSource({
      added_by: '甲',
      qq: 10001,
      group_name: '抽象群',
      group_id: 123456,
      time: '2026-10-28 21:00:00'
    }),
    '来源：甲(10001)｜抽象群(123456)｜2026-10-28 21:00:00'
  )
  // 只有群号
  assert.equal(describeSource({ group_id: 999 }), '来源：群 999')
  // 私聊
  assert.equal(describeSource({ added_by: '乙', group_id: '私聊' }), '来源：乙｜私聊')
  // 缺 field 时用 time_iso 兜底
  assert.match(
    describeSource({ qq: 7, time_iso: '2026-10-28T06:00:00.000Z' }),
    /^来源：QQ 7｜\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
  )
  // 自定义前缀 / 无信息
  assert.equal(describeSource({ qq: 7 }, { prefix: '上传者' }), '上传者：QQ 7')
  assert.equal(describeSource({}), '')
  assert.equal(describeSource(null), '')
})

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
