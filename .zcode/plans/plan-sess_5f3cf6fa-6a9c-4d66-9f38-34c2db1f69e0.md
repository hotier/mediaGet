# QQ音乐解析接入实现计划

## 目标

新增「QQ音乐」平台（统一 key：`qqmusic`，前后端一致，域名 `y.qq.com` / `c6.y.qq.com`），按项目现有平台接入模式落地，分两层交付：

- **M1（必成）**：链接识别 + 歌曲元数据/封面解析
- **M2（best effort）**：免费歌曲 128k 试听音频（zzc 签名 + `QQMUSIC_COOKIE`）；VIP/付费歌曲拿不到完整音频，用 failType 差异化提示

**已实测依据（2026-09-08）**：
- `https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?songmid=<mid>&format=json` 免签名可用，返回歌名/歌手/专辑/albummid/时长/格式列表
- 经典 `music.vkey.GetVkeyServerBase` 无签名已被拒（code 500003），需 zzc 签名（SHA1 重排，非旧版 MD5/zzb），参考 [jixunmoe/qmweb-sign](https://github.com/jixunmoe/qmweb-sign)（TS 实现，端口进本项目，不新增 npm 依赖）
- 元数据响应内嵌 `ws.stream.qqmusic.qq.com/C100<mid>.m4a`（无 vkey）大概率失效，仅作兜底尝试

## 支持的链接形态

1. `https://y.qq.com/n/ryqq/songDetail/<songmid>`（现网歌曲页）
2. `https://y.qq.com/n/yqq/song/<songmid>.html`（旧版歌曲页）
3. `https://i.y.qq.com/v8/playsong.html?songid=...&songmid=...`（App 分享 webview，query 提取）
4. `https://c6.y.qq.com/base/fcgi-bin/u?__=<token>`（App 分享短链，`fetch redirect:"follow"` 解析，参考 qsmusic 现有写法；若返回 200+JS 跳转则解析响应体）

非目标：歌单/专辑/电台页面解析；VIP 歌曲完整音频（DRM 硬限制，不做破解）；明确在 API.md 写明「试听链接有时效（vkey 过期）」。

## 文件改动清单

### 后端
1. **`src/lib/platforms.ts`**：`PLATFORMS.QQ_MUSIC = "qqmusic"`；`PLATFORM_INFO` 加条目（name「QQ音乐」，domains `["y.qq.com"]`，shortDomains `["c6.y.qq.com"]`，supportsIdParse: true）；`ALL_DOMAINS` 补两个域名
2. **`src/lib/qqmusic-sign.js`**（新）：zzc 签名纯函数（node:crypto sha1 + 位置重排，参照 bilibili wbi md5 的内联端口先例），带已知向量注释
3. **`src/lib/qqmusic.js`**（新）：纯逻辑模块（参照 youtube.js 模式）——URL 归一化/songmid 提取、元数据 API 请求构建与响应解析、封面 URL 拼接（`y.gtimg.cn/music/photo_new/T002R500x500M000<albummid>.jpg`）、musicu.fcg 请求体构建 + sign、失败分类 `classifyQqmusicFailure` → failType（`not-found` / `sign-stale` / `need-cookie` / `vip-only` / `sources-down`）
4. **`src/app/api/qqmusic/route.js`**（新）：`export const GET = createApiHandler(...)`、`runtime = "nodejs"`；短链 resolve → 调 lib → 返回 `{ code, msg, data: { name, author(singer), cover, url?, lyrics?, core: "QQ音乐", type: "music" } }`（对齐 qsmusic 契约）；`QQMUSIC_COOKIE` 模块级 `process.env` 读取并注入 Cookie 头（照抄 BILIBILI_COOKIE 模式）；精简版 cookie 守卫（连续失败阈值 warn-once、成功复位，纯函数便于单测）；导出 `parseVideoId` 支持 source+id 模式；音频失败时退化为元数据结果 + failType（code 201，复用 youtube 模式）
5. **`src/lib/platformRoutes.js`**：注册 `qqmusic: () => import("@/app/api/qqmusic/route.js")`（engines 体检自动生效）
6. **`src/lib/api-middleware.ts`**：`ROUTE_DOMAIN_MAP` 加 `qqmusic: { name: "QQ音乐", hosts: ["y.qq.com"] }`

### 前端（key 前后端统一为 `qqmusic`，VideoParserForm 无需映射）
7. **`src/config/video-platforms.ts`**：qqmusic 条目（name/color/logo），驱动首页平台格子、FAQ、sitemap、`/platform/qqmusic`
8. **`public/logos/qqmusic.svg`**（新）：手绘简洁 logo（绿色圆底 + 音符）
9. **`src/components/PlatformIcon.tsx`**：MONOGRAM 加 `qqmusic: "Q"`
10. **`src/utils/share.ts`**：`detectPlatform` 加 `y.qq.com` 分支；`hasValidVideoUrl` 白名单补域名
11. **`src/components/videos/QymusicVideo.tsx`**（新）：音乐卡片（参照 QsMusicVideo：封面 + 歌名 + 歌手 + 下载按钮 + 歌词折叠）
12. **`src/components/videos/platform-renderers.tsx`**：注册 `qqmusic → QymusicVideo`，index.ts 导出
13. **`src/components/videos/ParseInfoPanel.tsx`**：`PLATFORM_FIELDS.qqmusic`（歌曲/歌手/来源/类型）
14. **`src/config/seo-platforms.ts`**：SEO 条目（否则 `/platform/qqmusic` 404）

### 测试与文档
15. **`tests/qqmusic.test.ts`**（新）：URL 提取四形态、sign 纯函数向量、元数据响应解析（fixture）、失败分类、cookie 守卫
16. **`tests/share.test.ts`**：补 y.qq.com 分享用例
17. **`README.md`**：支持平台行 + 平台数计数
18. **`API.md`**：新增「QQ音乐解析」编号小节（接口/链接示例/响应 JSON/`QQMUSIC_COOKIE` 环境变量/VIP 与时效限制说明），统一入口清单同步
19. **`wrangler.toml` 不改**（cookie 类 secret 走 Dashboard，沿用 BILIBILI_COOKIE 约定）

## 实施顺序

1. **M1**：1→6 后端元数据链路 + 15/16 单测 → 本地实测四种链接
2. **M2**：2/3/4 的音频部分（sign 端口 + GetVkeyServerBase + cookie 守卫 + failType）+ 兜底 ws.stream 链接探测
3. **M3**：7–14 前端 + 17/18 文档

## 验证方式

- `npx vitest run` 全绿
- 本地 dev 实测：四种链接形态、统一入口 `/api/parse` 自动识别、`/api/engines` 体检显示 qqmusic、`/platform/qqmusic` 页面
- 风险预案：sign 算法若再变，独立模块便于热替换；Workers 出口 IP 被风控时由 `QQMUSIC_COOKIE` 缓解（若海外出口整体被拒需自建国内代理，超出本期范围，记入 API.md 已知限制）