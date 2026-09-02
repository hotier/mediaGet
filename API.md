# API 文档

短视频解析服务 API 文档

## 基础信息

- **Base URL**: `https://get.hotier.cc.cd` 或本地 `http://localhost:3000`
- **响应格式**: JSON
- **跨域支持**: 所有接口均支持 CORS

## 通用响应格式

### 成功响应
```json
{
  "code": 200,
  "msg": "解析成功",
  "data": { ... },
  "platform": "douyin"
}
```

### 统一响应模型

所有平台的**成功响应**（`code` 恒为 `200`）在出口统一归一化，`data` 遵循同一套字段契约，前端与调用方只需消费以下字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `title` | string | 标题 |
| `desc` | string | 描述 |
| `author` | string | 作者昵称 |
| `authorId` | string | 作者 ID |
| `avatar` | string | 作者头像 |
| `cover` | string | 封面图 |
| `url` | string | 主媒体直链（视频/音乐/单图） |
| `audioUrl` | string | 音频直链（背景音乐/原声） |
| `images` | string[] | 图集（图文内容） |
| `type` | string | 内容类型：`video` / `image` |
| `duration` | number | 视频时长（毫秒） |
| `videos` | array | 多分P/多清晰度列表（bilibili） |
| `name` / `lyrics` / `core` / `copyright` | string | 音乐类扩展字段（汽水音乐） |

> 兼容说明：归一化**保留**各平台原始字段（如快手的 `photoUrl`、`caption` 等），同时新增上述统一字段，外部旧调用方不受影响。
>
> 历史变更：此前 bilibili 成功返回 `code: 1`、字段散落在顶层（`title`/`imgurl`/`user`）且 `data` 为分P数组——现已统一为 `code: 200` + 顶层字段移入 `data` + 分P 列表放入 `data.videos`。
>
> 补充：bilibili 归一化后 `data.url` 已补齐为第一分P直链，统一契约下消费方无需再取 `data.videos[0].url`。

### 纯文本模式（fmt=text）

适用于 iOS 快捷指令等轻量调用方，免去 JSON 解析。在任意解析接口 URL 后追加 `&fmt=text`：

- **成功**：返回两行纯文本 `标题\n直链`（直链优先级：`data.url` → `data.videos[0].url`（B 站）→ `data.images[0]`（小红书图文））
- **失败**：返回错误信息文本

**示例**：
```
GET /api/parse?url=https://v.douyin.com/xxx/&fmt=text
```
```
视频标题
https://v.douyin.com/xxxx/xxx.mp4
```

### 错误响应
```json
{
  "code": 400,
  "msg": "错误描述信息"
}
```

### 状态码说明

| 状态码 | 含义 |
|--------|------|
| 200 | 解析成功 |
| 400 | 请求参数错误或解析失败 |
| 429 | 请求过于频繁（含 IP 级限流与平台级上游节流，见「限制说明」） |
| 500 | 服务器内部错误 |

---

## API 接口

### 0. 统一解析入口（推荐）

**接口**: `GET /api/parse`（**同时支持 `POST`**：body 为 JSON `{"url"|"text": "…"}` 或表单 `url=/text=…`，用于超长分享文案，不受 GET URL 长度限制）

**说明**: 自动识别链接所属平台并调用对应解析器，所有平台共用这一个接口。**新调用方推荐统一使用 `url=` 一个参数**：纯分享链接与整段分享文案（分享码）均可直接传入，服务端自动提取文案中的链接（提取逻辑与前端共用）；`text=` 是同一能力的「严格面孔」（仅收文案、提取失败报错更明确），作为兼容别名保留（见 0.1），新调用方无需区分两者。分享链接被好友/他人再次打开时，24 小时内直接命中共享缓存（Cloudflare Cache API，跨实例共享），不会全量重新解析；缓存命中后还会探测主直链，明确死链自动重新解析，避免拿到过期直链。

**参数**（`url`、`text`、`source+id` 任选其一）:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | string | 方式1（推荐） | **全场景通用**：任意平台分享链接，或直接粘贴整段分享文案（分享码，如「【标题】…复制打开抖音，看看 https://v.douyin.com/xxx/ …」），服务端自动识别平台并提取文案中的链接（提取逻辑与前端共用） |
| text | string | 方式1b（兼容别名） | 仅接收整段分享文案（含标题/引导语），提取其中第一个 http(s) 链接。解析行为与 `url=` 传文案一致，差别仅在提取失败时返回精确的「未能从分享文案中提取到有效链接」；沿用旧 `/api/parse-text` 语义的调用方使用即可 |
| source + id | string | 方式2 | 平台名 + 视频 ID（仅部分平台支持，见下方响应） |

**示例请求**:
```
# 方式1（推荐）：url= 一个参数全场景通用——纯链接或整段分享码均可
GET /api/parse?url=https://v.douyin.com/kB9dI20w7vk/
GET /api/parse?url=https://www.bilibili.com/video/BV1xx411c7mD
GET /api/parse?url=【标题】…复制打开抖音，看看 https://v.douyin.com/xxx/ …
GET /api/parse?source=douyin&id=7212345678901234567

# 兼容别名（可选）：text= 仅收整段分享文案，语义更严格
GET /api/parse?text=【标题】…复制打开抖音，看看 https://v.douyin.com/xxx/ …

# 超长分享码走 POST（JSON 或表单均可；body 的 url=/text= 均支持）
POST /api/parse
Content-Type: application/json
{"url": "【标题】…复制打开抖音，看看 https://v.douyin.com/xxx/ …"}
```

**响应**: 与各平台专用接口一致（`code: 200` + 统一 `data` 字段契约）。

**注意**:
- 付费/DRM 平台（腾讯视频、爱奇艺、优酷、Netflix 等）会直接返回 `400` 并提示不支持，不消耗解析流量
- 支持 `&fmt=text` 纯文本模式（见上文「纯文本模式」）
- 并发保护：同一链接同时被多人打开时只真实抓取一次，其余请求复用同一次解析（进程内，缓存之外的补充）
- `url` / `text` / `source+id` 均缺失时返回 `400`，并附 `usage`（各调用方式示例）与 `supportedPlatforms`（支持 ID 解析的平台列表）

---

### 0.1 分享文案解析（兼容别名）

**接口**: `GET /api/parse-text`（也支持 `POST`，JSON body: `{"text": "…"}` 或表单 `text=…`）

**说明**: 文案解析的**兼容别名**——与 `/api/parse` 共用同一份实现（`src/lib/parse-handler.js`），只接收 `text=` 整段分享文案（含标题、引导语）并提取其中第一个 http(s) 链接，平台识别、解析、缓存、直链验证、限流等行为与 `/api/parse` 完全一致。**新调用方请直接使用 `/api/parse`**，推荐统一传 `url=`（一个参数覆盖纯链接与整段分享文案）；本入口保留给既有调用方（如 iOS 快捷指令）与偏好严格 `text=` 语义的场景。提取逻辑与前端共用同一份实现（`src/lib/share-text.ts`），保证网页表单与 API 行为一致。

**参数**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| text | string | 是 | 整段分享文案，如「【标题】…复制打开抖音，看看 https://v.douyin.com/xxx/ …」，服务端自动提取其中链接 |

**示例请求**:
```
GET /api/parse-text?text=【这个视频太有意思了】复制打开抖音，看看 https://v.douyin.com/xxx/ 的作品
GET /api/parse-text?text=https://v.kuaishou.com/Ku1rFvu1 你的新版奶爸来了唷…该作品在快手被播放过49.6万次，点击链接，打开【快手】直接观看！
POST /api/parse-text
Content-Type: application/json
{"text": "【标题】…复制打开抖音，看看 https://v.douyin.com/xxx/ …"}
```

**响应**: 与 `/api/parse` 一致（`code: 200` + 统一 `data` 字段契约；提取不到链接返回 `400`）。同样支持 `&fmt=text` 纯文本模式、共享缓存与并发保护。

---

### 1. 抖音视频解析

**接口**: `GET /api/douyin`

**参数**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | string | 是 | 抖音视频链接 |

**支持的链接格式**:
- `https://v.douyin.com/xxx/`
- `https://www.iesdouyin.com/share/video/xxx/`
- `https://www.douyin.com/video/xxx`

**示例请求**:
```
GET /api/douyin?url=https://v.douyin.com/kB9dI20w7vk/
```

**响应示例**:
```json
{
  "code": 200,
  "msg": "解析成功",
  "platform": "douyin",
  "data": {
    "author": "作者昵称",
    "uid": "用户ID",
    "avatar": "头像URL",
    "like": 12345,
    "time": 1703980800,
    "title": "视频标题",
    "cover": "封面URL",
    "url": "视频播放地址",
    "music": {
      "author": "音乐作者",
      "avatar": "音乐封面"
    }
  }
}
```

---

### 2. 哔哩哔哩视频解析

**接口**: `GET /api/bilibili`

**参数**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | string | 是 | 哔哩哔哩视频链接 |

**支持的链接格式**:
- `https://b23.tv/xxx`
- `https://www.bilibili.com/video/BVxxx`
- `https://m.bilibili.com/video/BVxxx`
- `https://www.bilibili.com/opus/<id>` / `https://m.bilibili.com/opus/<id>`（图文动态，返回 `type: "image"` + `images[]`；专栏文章等非纯图文会返回错误提示）

**示例请求**:
```
GET /api/bilibili?url=https://b23.tv/abcDEFg
```

**响应示例**:
```json
{
  "code": 200,
  "msg": "解析成功！",
  "platform": "bilibili",
  "data": {
    "title": "视频标题",
    "desc": "视频描述",
    "cover": "封面URL",
    "author": "UP主名称",
    "avatar": "UP主头像",
    "videos": [
      {
        "title": "P1",
        "url": "视频播放地址",
        "duration": 180,
        "durationFormat": "00:02:59",
        "accept": ["高清 1080P+", "高清 720P"]
      }
    ]
  }
}
```

> 注：已统一为 `code: 200`；分P 列表在 `data.videos`，作者信息在 `data.author` / `data.avatar`。

**图文动态响应补充**：图文动态为纯图片内容，无 `videos`/`url`；图片直链在 `data.images`（原图，已统一 https），`data.cover` 为首图，`data.desc` 为动态文案，`data.type` 为 `"image"`。前端展示为图集卡片并支持一键下载全部图片。

> 注：图文动态解析内部使用现代浏览器 User-Agent 访问 detail 接口——旧 UA 会被 B 站风控拦截（`-352`），该实现细节与接口可用性相关，调用方无需自行处理。

---

### 3. 快手视频解析

**接口**: `GET /api/kuaishou`

**参数**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | string | 是 | 快手视频链接 |

**支持的链接格式**:
- `https://v.kuaishou.com/xxx`
- `https://www.kuaishou.com/short-video/xxx`
- `https://www.kuaishou.com/photo/xxx`

**示例请求**:
```
GET /api/kuaishou?url=https://v.kuaishou.com/abcdEF
```

**响应示例**:
```json
{
  "code": 200,
  "msg": "解析成功",
  "platform": "kuaishou",
  "data": {
    "url": "视频播放地址",
    "title": "视频标题",
    "cover": "封面URL",
    "author": "作者名称"
  }
}
```

> 注：已统一为 `url` / `title` / `cover` / `author` 字段契约（原始 `photoUrl` / `caption` / `coverUrl` / `authorName` 字段仍保留）。

---

### 4. 微博视频解析

**接口**: `GET /api/weibo`

**参数**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | string | 是 | 微博视频链接 |

**支持的链接格式**:
- `https://weibo.com/tv/show/xxx`
- `https://video.weibo.com/show?fid=xxx`

**示例请求**:
```
GET /api/weibo?url=https://weibo.com/tv/show/1034:4912345678901234
```

**响应示例**:
```json
{
  "code": 200,
  "msg": "解析成功",
  "data": {
    "author": "作者名称",
    "avatar": "头像URL",
    "time": "发布时间",
    "title": "视频标题",
    "cover": "封面URL",
    "url": "视频播放地址"
  }
}
```

---

### 5. 小红书内容解析

**接口**: `GET /api/xhs`

**参数**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | string | 是 | 小红书内容链接 |

**支持的链接格式**:
- `https://www.xiaohongshu.com/explore/xxx`
- `http://xhslink.com/xxx`

**示例请求**:
```
GET /api/xhs?url=https://www.xiaohongshu.com/explore/66f8f8f8f8f8f8f8f8f8f8f8
```

**响应示例 (视频)**:
```json
{
  "code": 200,
  "msg": "解析成功",
  "data": {
    "author": "作者昵称",
    "authorID": "用户ID",
    "title": "内容标题",
    "desc": "内容描述",
    "avatar": "头像URL",
    "cover": "封面URL",
    "url": "视频播放地址",
    "type": "video"
  }
}
```

**响应示例 (图片)**:
```json
{
  "code": 200,
  "msg": "解析成功",
  "data": {
    "author": "作者昵称",
    "authorID": "用户ID",
    "title": "内容标题",
    "desc": "内容描述",
    "avatar": "头像URL",
    "cover": "封面URL",
    "images": ["图片1URL", "图片2URL"],
    "type": "image"
  }
}
```

---

### 6. 汽水音乐解析

**接口**: `GET /api/qsmusic`

**参数**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | string | 是 | 汽水音乐链接 |

**示例请求**:
```
GET /api/qsmusic?url=https://music.douyin.com/qishui/share/track?track_id=xxx
```

---

### 7. 皮皮虾视频解析

**接口**: `GET /api/pipigx`

**参数**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | string | 是 | 皮皮虾视频链接 |

---

### 8. 皮皮虾视频解析

**接口**: `GET /api/ppxia`

**参数**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | string | 是 | 皮皮虾视频链接 |

---

### 9. 健康检查

**接口**: `GET /api/health`

**说明**: 用于监控服务状态

**示例请求**:
```
GET /api/health
```

**响应示例**:
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "responseTime": 5
}
```

---

## 10. 解析行为统计

**接口**: `GET /api/stats`

**鉴权**: 需携带 `Authorization: Bearer <STATS_API_KEY>`；未配置 `STATS_API_KEY` 时返回 `403`。

**说明**: 返回所有解析记录（**成功与失败**）的分析结果——平台分布（含失败数）、近 14 天每日解析量、总量/成功/失败/独立访客（IP 匿名哈希）/独立链接数。数据由 `createApiHandler` 在每次解析结束（成功或失败）时异步写入 Turso（`parse_events` 表，`status` 区分 `success`/`failed`，`reason` 记录失败原因）。

**响应示例**:
```json
{
  "code": 200,
  "msg": "ok",
  "data": {
    "totals": { "total": 120, "success": 100, "failed": 20, "users": 34, "unique_links": 88 },
    "byPlatform": [
      { "platform": "douyin", "total": 50, "success": 45, "failed": 5 }
    ],
    "byDay": [
      { "day": "2024-01-01", "total": 10, "success": 8, "failed": 2 }
    ]
  }
}
```

> 提示：`failed` 数高的平台说明当前解析成功率偏低或存在未支持的内容类型，可针对性优化（查看失败 `reason` 需直接查询数据库 `parse_events` 表）。

---

## 11. 功能开关配置

**接口**: `GET /api/config`

**说明**: 返回客户端功能开关（供小程序等客户端远程读取）。当前主要用于小程序审核：`videoParseEnabled` 为 `false` 时客户端隐藏视频解析入口，审核通过后将环境变量 `VIDEO_PARSE_ENABLED` 设为 `"true"` 重新部署即可放开（未配置时默认关闭）。响应禁止缓存（`Cache-Control: no-store`），开关改动实时生效。

**响应示例**（默认，解析入口隐藏）:
```json
{
  "code": 200,
  "msg": "ok",
  "data": {
    "videoParseEnabled": false
  }
}
```

---

## 限制说明

### 速率限制
- **IP 级**：每个 IP 每分钟最多 **60** 次请求（单次解析会触发多次上游请求，故阈值较高），超出返回 `429`（msg 为「请求过于频繁」）
- **平台级（上游抓取保护）**：每个平台每分钟最多 **30** 次「真实抓取」——只统计缓存未命中的解析，缓存命中不消耗配额；同一链接的并发请求共享一次配额。超出返回 `429`（msg 为「该平台解析请求较多」）。目的：把对目标平台（抖音/快手/B 站等）的请求频率压在不触发其风控的区间，保护服务出口 IP

### 缓存机制
- **统一入口 `/api/parse`**：成功解析的结果缓存 **24 小时**（Cloudflare Cache API，跨实例共享），好友/他人再打开同一分享链接时直接返回缓存结果，不再全量重新解析；命中时服务端会先探测主直链，明确死链（404/410，如抖音签名直链过期）自动重新解析并回写，避免拿到过期直链打不开
- **平台专用接口**（`/api/douyin` 等）：进程内存缓存 **5 分钟**（单实例内有效）
- **并发去重**：同一链接在解析进行中被多人同时请求时，只真实抓取一次，其余请求复用同一次解析（与缓存互补：缓存针对「已完成」的解析，去重针对「进行中」的解析）
- 失败结果不缓存（可能是瞬时反爬），相同链接立即重试解析

### 环境变量配置

如需完整功能，需配置以下环境变量：

```env
# 抖音
# DOUYIN_COOKIE 失效自检：配置后若连续 5 次解析都命中抖音风控，服务会在日志中
# 打出「DOUYIN_COOKIE 疑似失效」告警提示更新，成功解析后自动复位
DOUYIN_COOKIE=your_cookie
DOUYIN_USER_AGENT=your_user_agent

# 哔哩哔哩
# BILIBILI_COOKIE 强烈建议配置：服务器为数据中心/海外出口时，匿名请求会被 B 站 WAF
# 风控（-412/-352，表现为解析失败）。填入浏览器登录态的完整 Cookie（必含 SESSDATA）
# 即可穿透，且登录态下 B 站基本不拦数据中心 IP。
# 获取：浏览器登录 bilibili.com（务必勾选「记住我」，有效期可达一年以上，到期才需
# 再配一次）→ F12 → Application → Cookies → https://www.bilibili.com →
# 复制全部 Cookie 字符串作为该环境变量值。
# 失效自检（低维护）：Cookie 过期后服务会自动降级并告警——连续 5 次带 Cookie 请求
# 仍被风控时日志打出「BILIBILI_COOKIE 疑似失效」，任一次成功解析自动复位；解析失败
# 的提示文案也会区分「服务器 Cookie 失效」与「临时风控」，便于定位是换 Cookie 还是重试。
BILIBILI_COOKIE=your_cookie
BILIBILI_USER_AGENT=your_user_agent

# 微博（已改为自动游客模式，无需配置 Cookie；见下方说明）
# WEIBO_COOKIE=your_cookie

# 解析行为统计（Turso/libsql；未配置时记录功能自动禁用）
TURSO_DB_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=your_token
STATS_API_KEY=your_stats_key

# 功能开关：视频解析入口（/api/config 读取；仅值为 "true" 时放开，未配置默认关闭）
# VIDEO_PARSE_ENABLED=true
```

> Cloudflare Workers 部署时：`BILIBILI_USER_AGENT` 已写入 `wrangler.toml` 的 `[vars]`；Cookie 类敏感值在 CI 中由 GitHub Secrets 自动 `wrangler secret put` 注入，无需手动配置。

---

## 错误处理

### 常见错误

| 错误信息 | 原因 | 解决方案 |
|----------|------|----------|
| url为空 | 未传入 url 参数 | 检查请求参数 |
| 无效的URL格式 | URL 格式错误 | 检查链接是否完整 |
| 请求过于频繁 | 当前 IP 超出速率限制 | 等待后重试 |
| 该平台解析请求较多 | 平台级上游节流触发（该平台 1 分钟内真实抓取超过 30 次） | 稍等片刻再试；如持续触发请反馈，可能需要调高配额 |
| 解析失败 | 平台接口变化或内容不可用 | 检查链接是否有效 |
| 服务器错误 | 服务器内部异常 | 稍后重试或联系管理员 |

---

## 使用示例

### JavaScript/TypeScript

```javascript
// 抖音解析示例
const response = await fetch('/api/douyin?url=' + encodeURIComponent('https://v.douyin.com/xxx/'));
const data = await response.json();

if (data.code === 200) {
  console.log('视频地址:', data.data.url);
} else {
  console.error('解析失败:', data.msg);
}
```

### cURL

```bash
# 抖音解析
curl "https://get.hotier.cc.cd/api/douyin?url=https://v.douyin.com/xxx/"

# 健康检查
curl "https://get.hotier.cc.cd/api/health"
```
