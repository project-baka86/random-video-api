# random-video-plugin

B 站抽象视频随机插件，内置一套**可多实例上报分发的视频 API**：

- 插件（Yunzai）在 QQ 群里维护视频列表；
- 每个实例（可部署在多台机器 / 多个机器人上）周期性把自己的视频清单**上报**给中心 Hub；
- Hub 聚合出全局目录，对外提供随机**分发**：默认 302 直链到健康实例，也可由 Hub 反向代理流量，实例故障自动转移；
- **解析与下载只发生在 bot 端**：Hub 不调 B 站、不缓存视频。收到未保存过的视频时，Hub 会把
  「解析 + 下载 + 保存」派发给一个 bot 实例，bot 解析 B 站地址并**把视频文件保存在自己的缓存目录**，
  之后 Hub 及全局目录都以该实例作为来源。

```
                  ┌─────────────────────────────┐
                  │        Hub (HUB=1)          │
  客户端 ───────▶ │  注册表 / 全局目录 / 选点分发 │
                  └───────┬───────────┬─────────┘
        ▲                 │ 心跳上报   │ 心跳上报
        │ 302 直链 / Hub 代理 │           │
        │                  │           │
   ┌────┴─────┐      ┌─────┴────┐ ┌────┴─────┐
   │ 实例 A    │      │ 实例 B   │ │ 实例 C    │
   │ 插件+API  │      │ 插件+API │ │ 插件+API  │
   └──────────┘      └──────────┘ └──────────┘
```

```
.
├── index.js             # Yunzai 插件（#添加抽象视频 / #来个抽象视频）
├── server.js            # 分发 API 启动入口（单机 / Hub / 实例三种角色）
├── lib/
│   ├── store.js         # videolist.json 读写（插件与 API 共用）
│   ├── bilibili.js      # B 站 view / playurl / 视频流封装（零依赖，含风控降级）
│   ├── api-server.js    # HTTP 服务：列表、分发、Hub 注册表端点
│   ├── registry.js      # 多实例注册表：心跳、TTL、目录聚合、选点
│   └── reporter.js      # 实例上报器：定时把清单推给 Hub
└── test/                # node:test 单元 + 多实例集成测试
```

## 一、配套的 Yunzai 插件

QQ 群里的视频列表由插件维护，插件在独立仓库：

**https://github.com/project-baka86/random-video-plugin**

- `#添加抽象视频BV1xxxxxxxxx` — 校验并添加视频
- `#来个抽象视频` — 随机抽一个发到群里（超过 50MB 自动拦截并移除）

两者共用同一份 `videolist.json`（本仓库 `lib/store.js` 与插件完全一致）。
API 部署时用 `VIDEO_DATA_FILE` 指向插件的 `videolist.json`，插件加的视频下一次心跳就会进入全局目录。

## 二、三种运行角色

要求 Node.js >= 18.17（依赖全局 `fetch`），**零第三方依赖**，`node server.js` 即可。

| 角色 | 启动方式 | 能力 |
| --- | --- | --- |
| 单机 | `node server.js` | 保留原有列表 + 随机分发 |
| Hub | `HUB=1 node server.js` | 接收实例上报、聚合目录、按策略选点分发 |
| 实例 | `HUB_URL=http://hub:3000 node server.js` | 周期性上报清单，同时自身仍可对外分发 |

角色可叠加：既做 Hub 又向另一个上级 Hub 上报。

### 启动 Hub

```bash
HUB=1 INSTANCE_TOKEN=cluster-secret PORT=3000 node server.js
```

### 启动实例（每台机器 / 每个机器人一份）

```bash
INSTANCE_ID=bot-shanghai-1 \
INSTANCE_URL=http://10.0.0.5:3001 \
INSTANCE_TOKEN=cluster-secret \
HUB_URL=http://hub.internal:3000 \
PORT=3001 node server.js
```

- `INSTANCE_URL` 必须是 Hub 或客户端**能访问到**的地址，用于返回直链。
- 实例也会读取同一个 `videolist.json`，插件加的 BV 号下一次心跳就会出现在全局目录里。
- 实例上报里带 `cached` 标记，Hub 可据此优先选已缓存该视频的实例。

## 三、环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | 监听端口 / 地址 |
| `API_TOKEN` | 空 | 公开接口令牌：下载、列表、随机分发都需要它（或用 `INSTANCE_TOKEN`） |
| `INSTANCE_ID` | `<hostname>-<port>` | 本实例唯一 id |
| `INSTANCE_URL` | `http://127.0.0.1:<port>` | 本实例对外地址（直链用） |
| `INSTANCE_TOKEN` | 空 | 集群令牌：实例上报、注册表、实例间代理/下载鉴权 |
| `REQUIRE_AUTH` | 空 | `1`/`true` 时为严格模式：一个 token 都没配时直接 `503`，而不是放行匿名 |
| `HUB` | 空 | `1`/`true` 启用 Hub 能力 |
| `HUB_URL` | 空 | 上级 Hub 地址，设置后本进程作为实例上报 |
| `HUB_REGISTRY_FILE` | `<plugin>/instances.json` | Hub 注册表持久化文件 |
| `INSTANCE_TTL_MS` | `90000` | 心跳有效期，超时实例不再参与分发 |
| `REPORT_INTERVAL` | `30000` | 实例上报间隔 ms |
| `DEFAULT_DELIVERY` | `redirect` | 默认分发方式：`redirect`（302 直链）或 `proxy`（Hub 代理） |
| `DISTRIBUTE_STRATEGY` | Hub `remote-first`；单机 `local-first` | 选点策略：`local-first` / `remote-first` / `random` / `round-robin` / `cached-first` |
| `LOCAL_PARSE` | Hub `0`；实例/单机 `1` | 是否允许本机解析（调 B 站）并保存视频。Hub 默认关闭，解析交给 bot 实例 |
| `AUTO_PARSE` | `1` | Hub 收到未保存过的视频时，是否自动派发给实例解析并保存 |
| `PREPARE_TIMEOUT_MS` | `300000` | Hub 等待实例解析+下载完成的超时 |
| `VIDEO_DATA_FILE` | `<plugin>/videolist.json` | 视频列表文件 |
| `CACHE_DIR` | `<plugin>/cache` | 视频缓存目录 |
| `MAX_VIDEO_MB` | `50` | 单视频大小上限 |
| `MAX_VIDEO_MINUTES` | `10` | 单视频时长上限（分钟），`0` 表示不限制 |
| `BILI_UA` / `BILI_COOKIE` | 内置 | 覆盖 B 站请求头 / Cookie（降低 412 风控） |
| `CORS_ORIGIN` | `*` | 跨域 Origin |

## 四、API 一览

### 公开接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 健康检查（含角色、实例数、列表数） |
| `GET` | `/api` | 接口索引 |
| `GET` | `/api/videos` | 本机视频列表 |
| `POST` | `/api/videos` | 添加视频，body `{ "bvid": "BV1xx411c7mD" }`，也接受 URL |
| `GET` | `/api/videos/:bvid` | 单条记录 |
| `POST` | `/api/videos/:bvid/prepare` | **解析 + 下载 + 保存**：实例在本机执行；Hub 派发给 bot 实例 |
| `DELETE` | `/api/videos/:bvid` | 删除 |
| `GET` | `/api/random` | 随机抽一个视频（全局目录） |
| `GET` | `/api/video/:bvid` | 分发指定视频 |

`POST /api/videos` 支持一并标注上传来源（缺省时 `added_by='api'`、时间为当前本地时间）：

```json
{
  "bvid": "BV1xx411c7mD",
  "added_by": "群友甲",
  "qq": 10001,
  "group_id": 123456,
  "group_name": "抽象交流群",
  "time": "2026-10-28 21:00:00"
}
```

字段也接受 `user` / `nickname` / `uploader` 作为 `added_by` 的别名，以及 `user_id` 作为 `qq`；
也可以用查询串传 `?group_id=...&group_name=...`。记录会写入 `videolist.json`，包含
`time`、`time_iso`、`group_id`、`group_name`、`qq`、`added_by`，供分发与界面展示 provenance。

`POST /api/videos/:bvid/prepare` 返回示例（在实例上调用 / Hub 派发成功后）：

```json
{
  "bvid": "BV1xx411c7mD",
  "title": "抽象一",
  "size": 10516124,
  "size_mb": 10.03,
  "cached": true,
  "saved": true,
  "instance_id": "bot-shanghai-1",
  "dispatched": true,
  "stream_url": "/api/video/BV1xx411c7mD"
}
```

### 解析/保存流程

1. 客户端请求 Hub 的 `/api/video/:bvid`（或 `POST /api/videos`）；
2. 若目录中已有实例保存过该视频，直接按选点策略分发（302 直链 / Hub 代理）；
3. 若**没有任何实例**持有该视频，Hub 按 `AUTO_PARSE=1` 选一个健康实例，调用它的
   `POST /api/videos/:bvid/prepare`；
4. bot 实例在本机解析 B 站地址、下载视频、写入自己的 `CACHE_DIR`（**文件留在 bot 上**），
   并把该 bvid 记入本地列表；
5. Hub 立即把该实例的 `cached` 标记回写注册表，随后正常分发；下一次心跳也会带上该视频。
6. Hub 自身 `LOCAL_PARSE=0`：既不调 B 站，也不在本机缓存；`redirect=1`/`cache=1` 这类需要
   本机解析的旧参数在 Hub 上会返回 `409`。

`?local=1` 可让 Hub 强制在本机解析（需 `LOCAL_PARSE=1`，适合 Hub 同时也是一个 bot 的场景）。

### Hub 注册表接口（需 `INSTANCE_TOKEN` 或 `API_TOKEN`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/instances/report` | 实例心跳上报（见下方报文格式） |
| `GET` | `/api/instances` | 已注册实例（含 `healthy` 标记） |
| `GET` | `/api/instances/:id` | 单个实例详情 |
| `DELETE` | `/api/instances/:id` | 注销实例 |
| `GET` | `/api/catalog` | 聚合后的全局目录：bvid → 可用实例 |

### 鉴权规则

- **下载/列表/随机**（`/api/video/*`、`/api/random`、`/api/videos*`）：只要配置了 `API_TOKEN` **或**
  `INSTANCE_TOKEN`，就必须携带其一，否则返回 `401`。三种携带方式等价：
  `Authorization: Bearer <token>`、`?token=<token>`、`X-Instance-Token: <token>`。
- **实例上报/注册表**：只认集群凭据（`INSTANCE_TOKEN`，或作为 `API_TOKEN` 的 Bearer）。
  未携带时返回 `401`。
- **Hub → 实例代理下载**：Hub 自动带上 `X-Instance-Token` 与 `Authorization`，实例无需额外配置。
- **`/health` 始终开放**，方便负载均衡探活。
- 一个 token 都没配置时，为兼容单机使用默认放行并在日志告警；生产环境请配置
  `INSTANCE_TOKEN`（和/或 `API_TOKEN`），或设置 `REQUIRE_AUTH=1` 让缺失 token 直接 `503` 拒绝。

上报报文：

```json
{
  "instance_id": "bot-shanghai-1",
  "url": "http://10.0.0.5:3001",
  "name": "上海群机器人",
  "videos": [
    { "bvid": "BV1xx411c7mD", "title": "抽象一", "cached": true }
  ]
}
```

### 分发的三种形态

在 `/api/random` 和 `/api/video/:bvid` 上通用：

| 参数 | 效果 |
| --- | --- |
| `delivery=redirect`（默认） | 选中远端实例时返回 `302` 直链；选中本机则直接出流，避免重定向到自己 |
| `delivery=proxy` | 由 Hub 反向代理实例流量，客户端只访问 Hub，实例无需公网可达 |
| `format=json` | 只返回元信息：`provider`、`direct_url`、`stream_url` 等 |
| `format=stream` | 等价于 `delivery=proxy`，直接返回视频字节 |
| `format=redirect` 或 `redirect=1` | 随机后 302 到本轮分发的地址 |
| `cache=1` | 本机先完整缓存再返回 |
| `redirect=1`（`/api/video/:bvid`） | 兼容旧行为：302 到 B 站 CDN 源地址 |

分发特性：

- **选点策略**：`remote-first`（Hub 默认，把流量交给实例）、`local-first`、`random`、`round-robin`、`cached-first`。
- **故障转移**：`proxy` 模式下若选中实例连接失败，自动尝试下一个候选来源，直到成功。
- **心跳与摘除**：超过 `INSTANCE_TTL_MS` 未上报的实例自动从目录中剔除，后台定时清理。
- **Range 透传**：Hub 代理会把 `Range` 原样转发给实例，`206 Partial Content` 与 `Content-Range` 原样返回，支持拖动进度条。
- **失效自愈**：只有本地来源时会回源校验并移除失效视频；有实例上报则交给故障转移处理。

### 示例

```bash
# 实例上报（等价于 reporter 的行为）
curl -X POST http://hub:3000/api/instances/report \
  -H 'Content-Type: application/json' -H 'X-Instance-Token: cluster-secret' \
  -d '{"instance_id":"bot-1","url":"http://10.0.0.5:3001","videos":[{"bvid":"BV1xx411c7mD"}]}'

# 查看全局目录与实例健康状态
curl http://hub:3000/api/catalog
curl http://hub:3000/api/instances

# 随机拿元信息，再让 Hub 代理播放
curl http://hub:3000/api/random
curl -o random.mp4 'http://hub:3000/api/random?format=stream'

# 强制走实例直链
curl -i 'http://hub:3000/api/video/BV1xx411c7mD?delivery=redirect'
```

网页播放器（Hub 代理，客户端只依赖 Hub）：

```html
<video src="http://hub:3000/api/random?format=stream" controls></video>
```

## 五、测试

```bash
npm test
```

全部离线（假 B 站 + 临时端口），覆盖 57 个用例：存储、B 站风控降级、单机分发、
Range、大小限制、令牌鉴权（含只配 `INSTANCE_TOKEN` 时下载必须带令牌、严格模式 `503`）、
注册表心跳/TTL/持久化/`markCached`、实例上报器，以及 Hub + 双实例的端到端集成
（目录聚合、302 直链、Hub 代理、Range 透传、故障转移、心跳过期摘除、集群鉴权、
实例下载鉴权、**Hub 派发 bot 解析保存、未知视频自动派发、Hub 本地不落盘**）。
