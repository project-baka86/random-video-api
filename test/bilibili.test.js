import test from 'node:test'
import assert from 'node:assert/strict'

import { getVideoInfo, getPlayUrl, BilibiliError, HEADER_PROFILES } from '../lib/bilibili.js'

test('遇到 412 风控会自动切换请求头组合', async () => {
  const calls = []
  const fakeFetch = async (_url, { headers }) => {
    calls.push(headers)
    if (headers['User-Agent']) {
      return { ok: false, status: 412, json: async () => ({}) }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: 0, data: { bvid: 'BV1xx411c7mD', cid: 42, title: '抽象' } })
    }
  }

  const info = await getVideoInfo('BV1xx411c7mD', { fetchImpl: fakeFetch, retries: 0 })
  assert.equal(info.cid, 42)
  assert.ok(calls.length >= 2, `应至少尝试两组请求头，实际 ${calls.length}`)
  assert.equal(calls.at(-1)['User-Agent'], undefined, '最后一组应为不带 UA 的组合')
  assert.ok(HEADER_PROFILES.some((p) => !p.headers['User-Agent']))
})

test('B站业务错误码映射为 404', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ code: -404, message: '啥都木有' })
  })
  await assert.rejects(
    () => getVideoInfo('BV1xx411c7mD', { fetchImpl: fakeFetch, retries: 0 }),
    (err) => err instanceof BilibiliError && err.status === 404 && /啥都木有/.test(err.message)
  )
})

test('playurl 解析 durl 中的 url 与 size', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      code: 0,
      data: { quality: 32, format: 'mp4', durl: [{ url: 'https://cdn.test/a.mp4', size: 123, length: 10 }] }
    })
  })
  const play = await getPlayUrl('BV1xx411c7mD', 42, { fetchImpl: fakeFetch, retries: 0 })
  assert.equal(play.url, 'https://cdn.test/a.mp4')
  assert.equal(play.size, 123)
})

test('playurl 缺少 durl 时抛出错误', async () => {
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ code: 0, data: {} }) })
  await assert.rejects(
    () => getPlayUrl('BV1xx411c7mD', 42, { fetchImpl: fakeFetch, retries: 0 }),
    (err) => err instanceof BilibiliError && /播放地址为空/.test(err.message)
  )
})
