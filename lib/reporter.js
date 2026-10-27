import fs from 'node:fs'
import path from 'node:path'

/**
 * 实例上报器（Node 侧）：周期性把本地视频清单与缓存情况推送到 Hub。
 * 独立于 HTTP 服务运行，可用 start()/stop() 控制。
 */
export class InstanceReporter {
  /**
   * @param {object} options
   * @param {string} options.hubUrl Hub 地址，如 http://hub:3000
   * @param {string} options.instanceId 本实例唯一 id
   * @param {string} options.instanceUrl 本实例对外可访问地址（供分发直链使用）
   * @param {string} [options.token] 集群令牌 INSTANCE_TOKEN
   * @param {import('./store.js').VideoStore} options.store
   * @param {string} [options.cacheDir]
   * @param {number} [options.interval] 上报间隔（ms），默认 30s
   * @param {string} [options.name]
   * @param {object} [options.logger]
   * @param {typeof fetch} [options.fetchImpl]
   */
  constructor(options = {}) {
    this.hubUrl = String(options.hubUrl ?? '').replace(/\/+$/, '')
    this.instanceId = options.instanceId
    this.instanceUrl = String(options.instanceUrl ?? '').replace(/\/+$/, '')
    this.token = options.token ?? ''
    this.store = options.store
    this.cacheDir = options.cacheDir
    this.name = options.name || this.instanceId
    this.intervalMs = Number(options.interval) || 30_000
    this.logger = options.logger ?? console
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timer = null
    this.lastResult = null
    this.lastError = null
    this.reportCount = 0
  }

  /** 生成本次上报内容：bvid + 标题 + 本地是否已缓存。 */
  buildPayload() {
    const videos = (this.store?.list?.() ?? [])
      .filter((item) => item?.bvid)
      .map((item) => ({
        bvid: item.bvid,
        title: item.title ?? '',
        cached: Boolean(this.cacheDir && fs.existsSync(path.join(this.cacheDir, `${item.bvid}.mp4`)))
      }))
    return {
      instance_id: this.instanceId,
      url: this.instanceUrl,
      name: this.name,
      videos,
      reported_at: Date.now()
    }
  }

  /** 上报一次，失败不抛异常（返回 null），由调用方按需处理。 */
  async reportOnce() {
    if (!this.hubUrl) throw new Error('未配置 HUB_URL，无法上报')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      const res = await this.fetchImpl(`${this.hubUrl}/api/instances/report`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // 同时携带两种凭据：Hub 配 INSTANCE_TOKEN 或 API_TOKEN 都能通过
          ...(this.token
            ? { 'X-Instance-Token': this.token, Authorization: `Bearer ${this.token}` }
            : {})
        },
        body: JSON.stringify(this.buildPayload()),
        signal: controller.signal
      })
      if (!res.ok) throw new Error(`Hub 返回 HTTP ${res.status}`)
      const data = await res.json()
      this.lastResult = data
      this.lastError = null
      this.reportCount += 1
      return data
    } catch (err) {
      this.lastError = err
      this.logger.warn?.(`[reporter] 上报 ${this.hubUrl} 失败: ${err.message}`)
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /** 立即上报一次并启动定时上报。 */
  start() {
    if (!this.hubUrl) throw new Error('未配置 HUB_URL，无法启动上报')
    if (this.timer) return this
    void this.reportOnce()
    this.timer = setInterval(() => void this.reportOnce(), this.intervalMs)
    this.timer.unref?.()
    this.logger.info?.(
      `[reporter] 已启动：实例 ${this.instanceId} -> ${this.hubUrl}，每 ${Math.round(this.intervalMs / 1000)}s 上报一次`
    )
    return this
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    return this
  }
}

export default InstanceReporter
