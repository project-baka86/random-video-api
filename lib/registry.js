import fs from 'node:fs'
import path from 'node:path'

import { normalizeBvid } from './store.js'

const MAX_INSTANCES = 1000
const MAX_VIDEOS_PER_INSTANCE = 5000

/** 去掉末尾斜杠，保证拼接 stream 路径时不会出现双斜杠。 */
export function normalizeInstanceUrl(url) {
  if (typeof url !== 'string') return ''
  const trimmed = url.trim().replace(/\/+$/, '')
  return trimmed
}

/**
 * 校验实例上报的 payload。
 * @returns {{ id: string, url: string, name: string, token: string, videos: Array<{bvid:string,title:string,cached:boolean}> }}
 */
export function validateReport(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('上报内容必须是 JSON 对象')
  }
  const id = String(payload.instance_id ?? payload.id ?? '').trim()
  if (!id || id.length > 64) throw new Error('instance_id 必填且不超过 64 字符')

  const url = normalizeInstanceUrl(payload.url ?? payload.instance_url)
  if (!/^https?:\/\/.+/i.test(url)) throw new Error('url 必须是 http(s) 地址')

  const rawVideos = Array.isArray(payload.videos) ? payload.videos : []
  if (rawVideos.length > MAX_VIDEOS_PER_INSTANCE) {
    throw new Error(`videos 数量超过上限 ${MAX_VIDEOS_PER_INSTANCE}`)
  }
  const seen = new Set()
  const videos = []
  for (const raw of rawVideos) {
    const source = typeof raw === 'string' ? { bvid: raw } : raw
    const bvid = normalizeBvid(source?.bvid)
    if (!bvid || seen.has(bvid)) continue
    seen.add(bvid)
    videos.push({
      bvid,
      title: typeof source?.title === 'string' ? source.title : '',
      cached: Boolean(source?.cached)
    })
  }

  return {
    id,
    url,
    name: String(payload.name ?? id).slice(0, 64),
    token: String(payload.token ?? '').slice(0, 256),
    videos
  }
}

/**
 * 多实例注册表（Hub 侧）。
 * 实例通过心跳上报自己的视频清单，Hub 据此聚合全局目录并做选点分发。
 */
export class InstanceRegistry {
  /**
   * @param {object} [options]
   * @param {number} [options.ttl] 心跳有效期（ms），超过即视为不健康
   * @param {string|null} [options.file] 可选的持久化文件
   * @param {object} [options.logger]
   * @param {() => number} [options.now] 便于测试注入时间
   */
  constructor(options = {}) {
    this.ttl = Number(options.ttl ?? process.env.INSTANCE_TTL_MS) || 90_000
    this.file = options.file ? path.resolve(options.file) : null
    this.logger = options.logger ?? console
    this._now = options.now ?? (() => Date.now())
    /** @type {Map<string, any>} */
    this.instances = new Map()
    this._sweeper = null
    if (this.file) this.load()
  }

  load() {
    try {
      if (!this.file || !fs.existsSync(this.file)) return
      const data = JSON.parse(fs.readFileSync(this.file, 'utf-8') || '[]')
      if (Array.isArray(data)) {
        for (const item of data) {
          if (item?.id) this.instances.set(item.id, item)
        }
      }
      this.prune()
    } catch (err) {
      this.logger.error?.('[registry] 读取注册表失败:', err.message)
    }
  }

  persist() {
    if (!this.file) return
    try {
      const dir = path.dirname(this.file)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`
      fs.writeFileSync(tmp, JSON.stringify([...this.instances.values()], null, 2), 'utf-8')
      fs.renameSync(tmp, this.file)
    } catch (err) {
      this.logger.error?.('[registry] 写入注册表失败:', err.message)
    }
  }

  /**
   * 接收一次心跳上报（upsert）。
   * @returns {{ instance: any, instance_count: number, catalog_size: number, ttl: number }}
   */
  report(payload) {
    const parsed = validateReport(payload)
    const now = this._now()
    const prev = this.instances.get(parsed.id)
    if (!prev && this.instances.size >= MAX_INSTANCES) {
      throw new Error(`实例数量超过上限 ${MAX_INSTANCES}`)
    }
    const record = {
      id: parsed.id,
      name: parsed.name,
      url: parsed.url,
      token: parsed.token,
      videos: parsed.videos,
      firstSeen: prev?.firstSeen ?? now,
      lastSeen: now,
      reports: (prev?.reports ?? 0) + 1
    }
    this.instances.set(record.id, record)
    this.persist()
    return {
      instance: this.sanitize(record),
      instance_count: this.instances.size,
      catalog_size: this.catalog().size,
      ttl: this.ttl
    }
  }

  /** 对外输出时隐藏实例返回的集群令牌。 */
  sanitize(record) {
    const { token, ...safe } = record
    return { ...safe, video_count: record.videos?.length ?? 0, healthy: this.isHealthy(record) }
  }

  isHealthy(record, now = this._now()) {
    return now - (record.lastSeen ?? 0) <= this.ttl
  }

  get(id, { now = this._now() } = {}) {
    const record = this.instances.get(String(id))
    if (!record) return null
    return { ...this.sanitize(record), lastSeen: record.lastSeen, now }
  }

  remove(id) {
    const removed = this.instances.delete(String(id))
    if (removed) this.persist()
    return removed
  }

  /**
   * 更新某实例对某视频的缓存状态（Hub 派发解析成功后立即回写，无需等下一次心跳）。
   * @returns {boolean} 实例是否存在且 bvid 合法
   */
  markCached(id, bvid, cached = true) {
    const record = this.instances.get(String(id))
    if (!record) return false
    const normalized = normalizeBvid(bvid)
    if (!normalized) return false
    const videos = record.videos ?? []
    const existing = videos.find((v) => v.bvid === normalized)
    if (existing) existing.cached = Boolean(cached)
    else videos.push({ bvid: normalized, title: '', cached: Boolean(cached) })
    record.videos = videos
    this.persist()
    return true
  }

  /** 清理超时实例，返回被清理的 id 列表。 */
  prune({ now = this._now() } = {}) {
    const dead = []
    for (const [id, record] of this.instances) {
      if (!this.isHealthy(record, now)) {
        this.instances.delete(id)
        dead.push(id)
      }
    }
    if (dead.length) this.persist()
    return dead
  }

  list({ now = this._now(), healthyOnly = false } = {}) {
    const result = []
    for (const record of this.instances.values()) {
      const healthy = this.isHealthy(record, now)
      if (healthyOnly && !healthy) continue
      result.push({ ...this.sanitize(record), lastSeen: record.lastSeen, healthy, now })
    }
    return result.sort((a, b) => b.lastSeen - a.lastSeen)
  }

  /** 聚合全局目录：bvid -> { bvid, title, providers[] } */
  catalog({ now = this._now(), healthyOnly = true } = {}) {
    const catalog = new Map()
    for (const record of this.instances.values()) {
      if (healthyOnly && !this.isHealthy(record, now)) continue
      for (const video of record.videos ?? []) {
        const entry = catalog.get(video.bvid) ?? { bvid: video.bvid, title: '', providers: [] }
        if (!entry.title && video.title) entry.title = video.title
        entry.providers.push({
          kind: 'remote',
          id: record.id,
          name: record.name,
          url: record.url,
          token: record.token,
          cached: Boolean(video.cached),
          title: video.title || entry.title,
          streamUrl: `${record.url}/api/video/${video.bvid}`,
          lastSeen: record.lastSeen
        })
        catalog.set(video.bvid, entry)
      }
    }
    return catalog
  }

  /** 某个 bvid 的所有可用远端实例（默认只含健康实例）。 */
  providers(bvid, { now = this._now(), healthyOnly = true } = {}) {
    const normalized = normalizeBvid(bvid)
    if (!normalized) return []
    const entry = this.catalog({ now, healthyOnly }).get(normalized)
    return entry ? entry.providers : []
  }

  size({ now, healthyOnly = false } = {}) {
    return this.list({ now, healthyOnly }).length
  }

  /** 启动后台清理定时器（unref，不阻塞进程退出）。 */
  startSweeper(interval = Math.max(this.ttl / 2, 10_000)) {
    if (this._sweeper) return this._sweeper
    this._sweeper = setInterval(() => {
      const dead = this.prune()
      if (dead.length) this.logger.info?.(`[registry] 已清理超时实例: ${dead.join(', ')}`)
    }, interval)
    this._sweeper.unref?.()
    return this._sweeper
  }

  stopSweeper() {
    if (this._sweeper) clearInterval(this._sweeper)
    this._sweeper = null
  }
}

export default InstanceRegistry
