#!/usr/bin/env node
/**
 * 随机视频分发 API 启动入口（支持单机 / Hub / 实例上报三种角色）。
 *
 * 角色由环境变量决定：
 *   单机：什么都不配，行为同以前。
 *   Hub ：设置 HUB=1（或 ROLE=hub），启用实例注册表、目录聚合与选点分发。
 *   实例：设置 HUB_URL 指向 Hub，本实例会周期性上报视频清单，同时自身仍可对外分发。
 *   Hub+实例：HUB=1 且 HUB_URL 指向另一个 Hub（多级上报）。
 *
 * 环境变量：
 *   PORT              监听端口，默认 3000
 *   HOST              监听地址，默认 0.0.0.0
 *   API_TOKEN         可选，设置后 /api/* 需要 Bearer Token
 *   INSTANCE_ID       本实例唯一 id，默认 <hostname>-<port>
 *   INSTANCE_URL      本实例对外可访问地址，默认 http://127.0.0.1:<port>
 *   INSTANCE_TOKEN    集群令牌，用于实例上报与 Hub↔实例代理
 *   HUB               1/true 时启用 Hub 能力
 *   HUB_URL           上报目标 Hub 地址（设置后作为实例启动上报）
 *   HUB_REGISTRY_FILE Hub 注册表持久化文件，默认 <plugin>/instances.json
 *   INSTANCE_TTL_MS   实例心跳有效期，默认 90000
 *   REPORT_INTERVAL   上报间隔 ms，默认 30000
 *   DEFAULT_DELIVERY  默认分发方式 redirect|proxy，默认 redirect
 *   DISTRIBUTE_STRATEGY local-first|remote-first|random|round-robin|cached-first
 *   LOCAL_PARSE       是否在本机解析并保存视频；Hub 默认 0，实例/单机默认 1
 *   AUTO_PARSE        Hub 收到未知视频是否自动派发给实例解析保存，默认 1
 *   PREPARE_TIMEOUT_MS Hub 等待实例解析完成的超时，默认 300000
 *   VIDEO_DATA_FILE   视频列表文件，默认 <plugin>/videolist.json（与插件共用）
 *   CACHE_DIR         视频缓存目录，默认 <plugin>/cache
 *   MAX_VIDEO_MB      单个视频大小上限（MB），默认 50
 *   BILI_UA/BILI_COOKIE 自定义 B 站请求头
 *   CORS_ORIGIN       跨域 Origin，默认 *
 */
import os from 'node:os'

import { createApiServer } from './lib/api-server.js'
import { VideoStore, PLUGIN_DIR } from './lib/store.js'
import { InstanceRegistry } from './lib/registry.js'
import { InstanceReporter } from './lib/reporter.js'

const port = Number(process.env.PORT || 3000)
const host = process.env.HOST || '0.0.0.0'

const truthy = (value) => /^(1|true|yes|on)$/i.test(String(value ?? ''))
const hubEnabled = truthy(process.env.HUB) || /^hub$/i.test(process.env.ROLE || '')
const hubUrl = process.env.HUB_URL || ''
const instanceId = process.env.INSTANCE_ID || `${os.hostname()}-${port}`
const instanceUrl = (process.env.INSTANCE_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, '')

const store = new VideoStore()

const registry = hubEnabled
  ? new InstanceRegistry({
      file: process.env.HUB_REGISTRY_FILE || `${PLUGIN_DIR}/instances.json`,
      logger: console
    })
  : null

const server = createApiServer({
  store,
  registry,
  instanceId,
  instanceUrl,
  instanceToken: process.env.INSTANCE_TOKEN || '',
  role: hubEnabled ? 'hub' : hubUrl ? 'node' : 'standalone'
})

const reporter = hubUrl
  ? new InstanceReporter({
      hubUrl,
      instanceId,
      instanceUrl,
      token: process.env.INSTANCE_TOKEN || process.env.API_TOKEN || '',
      store,
      cacheDir: server.cacheDir,
      interval: Number(process.env.REPORT_INTERVAL) || 30_000,
      logger: console
    })
  : null

server.listen(port, host, () => {
  const { address, port: actualPort } = server.address()
  const role = hubEnabled ? 'hub' : hubUrl ? 'node' : 'standalone'
  console.log(`[randomvideo-api] 已启动 http://${address}:${actualPort}（角色: ${role}）`)
  console.log(`[randomvideo-api] 实例 id: ${instanceId}${instanceUrl ? `，对外地址: ${instanceUrl}` : ''}`)
  console.log(`[randomvideo-api] 视频列表: ${store.file}（当前 ${store.count()} 条）`)
  console.log(`[randomvideo-api] 缓存目录: ${server.cacheDir}`)
  if (hubEnabled) {
    registry.startSweeper()
    console.log(
      `[randomvideo-api] Hub 模式：注册表 ${registry.file}，心跳有效期 ${registry.ttl}ms，选点策略 ${server.strategy}`
    )
  }
  if (reporter) reporter.start()
  console.log(
    `[randomvideo-api] 解析模式: ${
      server.localParse ? '本机解析并保存' : `Hub 不解析，交由 bot 实例${server.autoParse ? '（收到未知视频自动派发）' : ''}`
    }`
  )
  if (process.env.API_TOKEN) console.log('[randomvideo-api] 已启用 API_TOKEN 鉴权')
  if (process.env.INSTANCE_TOKEN) console.log('[randomvideo-api] 已启用 INSTANCE_TOKEN 集群鉴权')
  if (/^(1|true|yes|on)$/i.test(String(process.env.REQUIRE_AUTH ?? ''))) {
    console.log('[randomvideo-api] 已启用 REQUIRE_AUTH 严格鉴权（未配置 token 时拒绝匿名访问）')
  }
})

server.on('error', (err) => {
  console.error('[randomvideo-api] 启动失败:', err.message)
  process.exit(1)
})

const shutdown = (signal) => {
  console.log(`\n[randomvideo-api] 收到 ${signal}，正在关闭...`)
  reporter?.stop()
  registry?.stopSweeper()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 5000).unref()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
