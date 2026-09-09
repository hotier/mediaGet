# CLAUDE.md

本文件给在仓库内写代码/改代码的 AI 助手（Claude Code / CodeBuddy 等）提供工作指引。目标：改完代码后 `README.md`、`API.md`、`CLAUDE.md` 中描述的平台、接口、环境变量、目录职责依然与实际实现一致。

## 项目概况

`mediaGet`（品牌「即刻解析」，线上 <https://get.hotier.cc.cd>）是一个 Next.js 15（App Router + React 19）解析下载站，含两大产品模块：

1. **视频/图文/音乐内容解析（首页 `/`）**：支持 **21 个平台**（抖音、快手、微博、哔哩哔哩、小红书、汽水音乐、皮皮虾、皮皮搞笑、西瓜视频、最右、虎牙、AcFun、全民K歌、QQ音乐、六间房、新片场、好看视频、TikTok、X/Twitter、Instagram、YouTube），输入分享链接 / 整段分享文案 /（部分平台）`source+id`，自动识别平台与内容类型并输出无水印直链。
2. **音乐解析中心（`/music`）**：多源聚合搜歌 / 试听 / 播放 / 歌词 / 封面 / 下载——默认 GD 聚合上游（`/api/music`，网易云/酷我/JOOX 等搜索）+ 自研直连搜索（`/api/music/self`，服务器直连腾讯/酷狗/咪咕等五家搜索，独立搜索源 chips）+ 洛雪(lx-music) 自定义音源（`/api/music/lx`）+ 歌曲链接解析（`/api/music/resolve`，网易云 / QQ音乐 / 酷我识别，酷狗与「默认停用播放引擎的 QQ」返回 `engine-missing`）。平台「搜索引擎 / 播放引擎」为部署可配开关（env `MUSIC_PLATFORM_SEARCH` / `MUSIC_PLATFORM_PLAY` 正向覆盖，另有 `MUSIC_PLATFORM_SEARCH_DISABLED` / `MUSIC_PLATFORM_PLAY_DISABLED` 黑名单与整体下线便捷变量 `MUSIC_PLATFORM_OFF` 作最终闸门，默认停用 QQ 搜索与 QQ/酷狗/咪咕播放，见 API.md §12）。

另有静态页：FAQ（`/faq`）、法律页（`/legal/{terms,privacy,dmca}`）、`robots.ts` / `sitemap.ts`；全站 PWA、深浅主题（默认跟随系统）。

技术形态：API 层与核心逻辑多为 **`.js`（ESM import/export）**，页面/组件/工具为 **TS/TSX**；前端是客户端会话式 SPA 页面（会话存 `sessionStorage`），后端是 API Route Handler，**除 `_diag/route.ts` 外全部为 `route.js`，且全部显式 `export const runtime = "nodejs"`**。

## 常用命令

```bash
npm run dev          # 开发（next dev --turbopack）
npm run build        # 生产构建
npm start            # 生产运行
npm run lint
npm test             # 单元测试（vitest run，纯本地无外网）
npm run test:watch
npm run test:live    # 真机解析测试（前缀 RUN_LIVE_PARSE=1，.env 需配 LIVE_URL_*）
npm run build:cf     # OpenNext Cloudflare 构建（产物 .open-next/）
```

单文件测试：`npx vitest run tests/share.test.ts`。真机测试目录 `tests/live/` 里另有音乐链接解析真机测试 `resolve-live.test.ts`（需显式 `RUN_LIVE_RESOLVE=1` 才跑，`npm run test:live` 不会带它）。live 测试都通过 `skipIf` 控制，不配 env 时默认跳过。

## 架构

### 后端（`src/app/api/**`）

**统一路由骨架**：平台/功能路由一律 `export const GET = createApiHandler(parseFn[, options])`；`createApiHandler`（`src/lib/api-middleware.ts`）把一个「纯解析函数」包装成完整 HTTP 接口，职责链依次为：CORS → IP 黑名单蜜罐（`lib/honeypot.ts`）→ IP 级限流 60 次/分（`lib/api-utils.js`）→ 平台级真实抓取节流（`lib/anti-bot.js`，默认 30 次/分/平台）→ URL 校验 + SSRF 白名单 → 解析执行 → `normalizeResult` 归一化统一契约 → 成功结果 5 分钟进程内缓存（`shouldCache`）→ `analytics.recordParse` 行为统计（Turso，可选）→ 统一错误响应；`fmt=text` 也由中间件统一处理。**不要绕过中间件自造轮子**，新增平台解析器只需返回 `{ code, msg, data }`。

**统一入口**：`/api/parse`（GET/POST）与 `/api/parse-text`（纯 `text=` 文案的兼容别名）都是薄壳，真实逻辑在 `src/lib/parse-handler.js`：`unified-parser.js` 识别平台（`lib/platforms.ts` 的 `PLATFORM_INFO` 决定识别与 `source+id` 能力）→ `lib/blockedPlatforms.ts` 黑名单（微信视频号与付费/DRM 平台）→ 按 `lib/platformRoutes.js`（平台 key → route 的唯一映射）动态 import 解析器 → 解析后写入 **24h 共享结果缓存**（`lib/result-cache.js`，Cloudflare Cache API，命中时先探测主直链，404/410 死链自动重解析）。key 与目录名映射：小红书 `redbook` → `/api/xhs`，皮皮虾 `pipixia` → `/api/ppxia`，汽水音乐 `qsmusic` 走特判。

**平台解析器风格**：多数是 route 内独立 async 函数（短链跟随 → 伪装 UA 抓页面/接口 → 提内嵌 JSON），快手是类（`lib/kuaishouCore.js`）。TikTok 走 `lib/tiktokDlp.js`（yt-dlp child_process，**仅 Docker/带二进制环境可用**）；YouTube 为纯 HTTP 多源竞速（`lib/youtube.js`，见下）；Instagram（`lib/instagram.js`）已全面登录墙，需 `IG_COOKIE`。

**音乐接口**：
- `/api/music`（provider=gd）：`lib/gdmusic.js` 按 GD(gdstudio) 契约组装 `types=url/search/pic/lyric` 请求，`getUpstreamBases` 多基址按序回退（8s 总预算）。action 支持 `search/pic/lyric/url(默认)`；另有 `bin=1`（url→音频字节代理下载带音质标签文件名；pic→封面字节同源取色）与 `fmt=text`。搜索 action 仅开放 netease/kuwo/joox。
- `/api/music/self`（自研直连搜索，仅 `action=search`）：`lib/self-search/`（index/errors + netease/tencent/kugou/kuwo/migu 每平台一模块，移植 lx-music musicSdk 并自研签名）服务器直连五家搜索 API，source 沿用 GD 命名，归一为 GD 搜索同契约 SearchItem（line 标注 `kind=self`）。三条价值：(1) tencent/kugou/migu 是 GD 未开放搜索的**独立搜索源 chips**；(2) netease/kuwo 双通道：搜索以本通道为主（自研失败才回退 GD 搜索引擎，并会话置位让后续翻页直接走 GD）；(3) 封面不强求——搜索响应能内嵌的写入 `picUrlDirect` 直接展示，不做二次换取。tencent/netease/kuwo 产物 id 与其 GD 直链通道所需 id 一致，可无缝复用直链/歌词/封面；kugou/migu 无内置直链引擎：前端点播/切音质统一走 music-client `requestPlayDirect`——先试 GD 主通道，失败或无引擎时按「平台→lx 音源 source」映射（默认 netease→wy、tencent→tx、kuwo→kw、kugou→kg、migu→mg，环境变量 `MUSIC_LX_URL_FALLBACKS` 可增改/关闭）自动改由音源脚本同曲取链；映射随 `/api/music/lx?action=sources` 的 urlFallbacks 下发，且仅当脚本确实注册了该 source 才生效。未配置映射/脚本时保持原「该音源自研搜索结果仅供识别，暂未接入试听直链引擎」提示。
- `/api/music/lx`（provider=lx）：洛雪生态自定义音源。`lib/lx-provider.js` 管脚本配置（`MUSIC_LX_SCRIPTS` 的 URL / 本地路径条目 + `MUSIC_LX_SCRIPTS_DIR` 目录扫描 + 进程 cwd 下 `.lxref/scripts/` 默认目录自动加载（目录存在即扫描，仓库不随附脚本），同名 id 保留首份；调度含 TTL 缓存、并发执行、quality 映射），`lib/lx-host.js` 用 `node:vm` 沙箱执行第三方脚本（**脚本视为不可信代码**，只暴露白名单 `fetch` 代理，不得放 Node 原生能力）。action：`sources/search/url/lyric`。仅 Node runtime，无浏览器直连兜底。
- `/api/music/resolve`：`lib/music-link.ts` 纯函数识别链接（SSRF 面收敛：不直接请求用户链接，官方短链 `163cn.tv` / `c.y.qq.com` 等服务端跟随一次重定向）→ 按平台直链引擎补元数据并产出 SearchItem，播放直链由 `/api/music` `action=url` 实时取（不预取）。网易 ready（`lib/netease-meta.js`，官方 song/detail）、QQ音乐 ready（`lib/qqmusic.js` songinfo，songmid 走 GD tencent 源）、酷我 ready（`lib/kuwo-meta.js`，m.kuwo.cn H5 songinfo，rid 走 GD kuwo 源）；各平台详情失败均降级占位标题仍可播（`metadata=fallback`），详情成功各自缓存 5 分钟。酷狗识别成功仍 `engine-missing`（GD 无 kugou source，直链通道未建），无法识别 400。

**资源代理**：`/api/video-proxy`（视频流：按平台补 Referer 防盗链、Range/206、download=1、twitter CDN 特殊处理；超时/重试）与 `/api/image`（图片字节代理，内存 LRU 6h，小红书/微博/快手图床需带 Referer）。前端是否走代理由 `utils/videoProxy.ts` 判定。

**辅助端点**：`/api/health`、`/api/config`（读 `VIDEO_PARSE_ENABLED`）、`/api/stats`（Turso 统计，需 `STATS_API_KEY`）、`/api/rate-limit`（查当前 IP 配额）、`/api/engines`（平台路由体检）、`/api/_diag`（临时诊断）。

### 前端

- 页面：`src/app/page.tsx`（首页解析会话状态机 + 平台网格 + 结果卡 + `failType` 差异化错误展示）、`src/app/music/page.tsx`（MusicExplorer 全屏音乐播放器 + 歌词）、`faq`、`legal/*`。`layout.tsx` 含主题三段脚本与 JSON-LD/PWA manifest。
- 表单与展示：`src/components/VideoParserForm.tsx`（剪贴板、防抖、平台指定）；`src/components/videos/` 每平台一个展示组件，`platform-renderers.tsx` 按平台/content 类型分发（图文图集多选下载、多分P清晰度、在线播放、复制直链）。
- 音乐 UI：`src/components/music/MusicExplorer.tsx`、`MusicViewSeg`、`BrPicker` 等；请求层 `src/lib/music-client.ts`：同源代理优先 + GD 公共源直连兜底（仅 provider=gd 可直连），lx 一律走 `/api/music/lx`，自研直连搜索源 chips（tencent/kugou/migu）与 netease/kuwo 双通道（自研为主、GD 搜索引擎兜底）搜索都经 `/api/music/self` 分派。浏览器端用 **源通道引擎抽象**（`sourceEngineKindFor`/`sourceEngineCapsFor` 把 source 归入 `gd|lx|self`，`trackDownloadSpec`/`coverBinUrl` 决策 bin 字节下载 / 封面取色 URL）——UI 不得自己拼 `/api/music` URL 或读 `isDirectUsed`；搜索引擎注册视图由 `source-meta.ts` 的 `buildSearchChips`（内置 GD 源 + 内置自研直连源 + 动态 lx 目录）统一构建，`MusicExplorer`/各面板只消费 chips 与上述入口。**聚合搜索**：SearchPanel chips 行首「聚合搜索」伪 chip（`aggActive`）开启，一次 `searchAcrossSources`（music-client，平台级限流闸 ≤3 路并发、多次触发叠加也不超 3、逐源失败隔离）拉全部可用源第 1 页，`music-match.ts`（纯函数：文本清洗/关键词相关度打分/跨源同曲判定与去重）合并排序成混合列表；去重与打分规则与播放失败自动换源共用同一套实现。聚合列表无翻页、不落播放快照（来源混合无从恢复），部分源失败以 `pageErr` 尾部提示、全部失败给空态说明。**播放失败自动换源**由 `use-player-engine.ts` 收敛：resolve（取直链失败）与 play（`<audio>` 媒体层报错）双阶段都进入 token 化有界自动换源，只在当前队列内尝试同曲高置信候选（`autoTrying` 期间播放条上方显示进行态 pill），失败收尾时把「尚未自动尝试过」的候选以 `alternatives` 快照暴露给 UI——`MusicExplorer` 据此弹出 `AltSelectDialog` 人工选版（逐行 来源/歌名/歌手/专辑，点行 `playTrack` 重走闭环）。
- `src/components/ui/` 是基于 shadcn/ui 规范生成的基础组件（CVA + tailwind-merge + 少量 radix primitives），改 UI 优先复用其中封装。

### 关键 lib 一览（`src/lib/`）

- 解析基础设施：`api-utils.js`（缓存/限流/URL校验/日志/北京时区/取客户端 IP）、`api-middleware.ts`、`normalize-result.ts`、`result-cache.js`、`parse-handler.js`、`unified-parser.js`、`platformRoutes.js`、`platforms.ts`、`share-text.ts`（服务端抽链接，与前端 `utils/share.ts` 行为对齐）、`blockedPlatforms.ts`、`anti-bot.js`、`honeypot.ts`、`analytics.js` + `turso-client.js`。
- 平台解析：抖音（route 内 + `douyin-extract.js`/`douyinFallback.js`）、`kuaishouCore.js`、bilibili（route 内 + `bilibili-opus.js` 图文、`bilibili-cookie-guard.js` 失效告警）、`instagram.js`、`tiktokDlp.js`、`ytDlpClient.js`（备用封装）、`youtube.js`、`qqmusic.js`/`qqmusic-id.js`/`qqmusic-sign.js`，其余小平台解析内联在各 route。
- 音乐：`gdmusic.js`、`lx-provider.js`、`lx-host.js`、`music-link.ts`、`netease-meta.js`；`self-search/`（自研直连搜索：`netease.js`/`tencent.js`/`kugou.js`/`kuwo.js`/`migu.js` + `index.js` 统一编排 + `errors.js`，配套单测 `tests/self-search.test.ts`、路由单测 `tests/self-route.test.ts`）。
- 前端工具：`utils/share.ts`、`utils/videoProxy.ts`、`utils/downloadImages.ts`、`utils/filename.ts`。

## 环境变量

敏感 Cookie 只进服务端环境变量（平台路由在 Node runtime 读），**不要写入 `wrangler.toml` / 前端可及文件**。完整说明与示例在 `API.md`「限制说明 → 环境变量配置」，此处给速查：

- 抖音：`DOUYIN_COOKIE`（可选，仅增强；UA 轮询已硬编码，**没有 `DOUYIN_USER_AGENT`**）。
- 哔哩哔哩：`BILIBILI_COOKIE`（强烈建议，穿透数据中心/海外出口 -412/-352 WAF；含失效自检告警）、`BILIBILI_USER_AGENT`（已写入 wrangler `[vars]`）。
- 小红书：`XHS_COOKIE`（可选）。微博：自动游客模式，无需 Cookie（`WEIBO_COOKIE` 已废弃）。
- Instagram：`IG_COOKIE`（强烈建议）、`IG_TIMEOUT_MS`（默认 20000）。
- QQ音乐 source+id：`QQMUSIC_COOKIE`（可选，vkey 试听接口）。X/Twitter：`TWITTER_FIXER_SERVICES`（可选，覆盖 fixer 集）。
- YouTube：`YOUTUBE_PIPED_HOSTS`（默认内置 3 个公共 Piped 候选）、`YOUTUBE_INVIDIOUS_HOSTS`（默认**不启用**，需显式配置或自托管）、`YOUTUBE_API_KEY`（Data API v3，仅优先元数据，无直链）、`YOUTUBE_API_TIMEOUT_MS`（默认 5000）、`YOUTUBE_SOURCE_TIMEOUT_MS`（默认 6000）。yt-dlp 已不参与 YouTube。
- 音乐：`MUSIC_API_BASE` / `MUSIC_API_BASES`（GD 契约上游链；公共实例对数据中心出口会被 CF 人机校验拦，线上需自建可直连实例）、`MUSIC_LX_SCRIPTS`（洛雪脚本，URL / file:// / 本地路径，多个逗号/空格分隔或 JSON 数组）、`MUSIC_LX_SCRIPTS_DIR`（可选，脚本目录，目录内每个 *.js 视为一个脚本）、`MUSIC_LX_SCRIPT_TTL_MS`（默认 6h）。未设置 `MUSIC_LX_SCRIPTS_DIR` 时，进程 cwd 下若存在 `.lxref/scripts/` 则自动加载（开发本机“放入即生效”；仓库不随附脚本，Docker 需自行内置或挂载）。自研直连搜索（`/api/music/self`）为代码内直连实现，无需额外环境变量。
- 统计：`TURSO_DB_URL` + `TURSO_AUTH_TOKEN`（未配置静默禁用）、`STATS_API_KEY`（`/api/stats` Bearer，未配置 403）。
- 开关：`VIDEO_PARSE_ENABLED`（`"true"` 才放开视频解析入口，wrangler `[vars]` 已配）。
- 蜜罐：`NEXT_PUBLIC_SITE_URL`（蜜罐页引导 URL 前缀，默认站点）。
- 测试：`RUN_LIVE_PARSE=1`、`RUN_LIVE_RESOLVE=1`、`LIVE_URL_*`（真机分享链接，模板 `tests/live/urls.example.env`，含可选 `LIVE_URL_BILIBILI_OPUS`）、`LIVE_PARSE_TIMEOUT_MS`（默认 120000）。单测内部还会读写 `VITEST=true`、`MUSIC_LX_SCRIPTS`、`MUSIC_LX_SCRIPT_TTL_MS`。
- yt-dlp 备用封装：`YTDLP_BIN`、`YTDLP_TIMEOUT_MS`（默认 25000）。

## 约定

- 语言风格：核心逻辑/API 为 `.js`，页面组件为 `.tsx`，类型集中在 `src/types/`。
- 路径别名 `@/* → ./src/*`（`tsconfig.json` + `vitest.config.mts`）。
- API 统一响应 `{ code, msg, data?, platform? }`；成功 `code:200`；字段契约以 `src/types/api.ts`、`API.md`、`normalize-result.ts` 为准。业务态错误尽量带 `failType`（`bot-gated` / `sources-down` / `source-unavailable` / `script-error` 等），前端据此区分提示与降级。
- 路由一律 `nodejs` runtime（勿引入对 Worker runtime 不兼容的依赖到 route 里）。
- 平台清单保持单一数据源：识别/`source+id` 能力改 `lib/platforms.ts`；解析路由注册改 `lib/platformRoutes.js`；前端平台元数据/排序/图标改 `src/config/video-platforms.ts`。README/API/CLAUDE 中的平台与接口清单由这些配置推导而来，改代码时同步更新文档。
- 请求外部平台遵循“最小打扰”：限流、UA、Referer、Cookie 治理都在中间件/解析器头部完成，新平台照抄既有路由的骨架（短链跟随超时、`AbortSignal.timeout`、UA 常量）。

## 部署

- **Vercel**：导入即用；注意公共 GD 上游对数据中心出口会触发 CF 人机校验，`/api/music` 需 `MUSIC_API_BASE(S)` 指向可直连实例；TikTok（yt-dlp child_process）在 Serverless 不可用。
- **Cloudflare Workers**（OpenNext）：`npm run build:cf` → `.open-next/`；`wrangler.toml` 已配 `[vars]`/`[assets]`；敏感 Cookie 经 GitHub Actions `wrangler secret put` 注入（`.github/workflows/deploy-cloudflare.yaml`）。
- **Docker（当前线上正式运行方式）**：多阶段 `Dockerfile`（standalone 产物）内置 yt-dlp + ffmpeg（TikTok 依赖）并以非 root 运行；`.github/workflows/deploy-to-docker.yaml` 手动触发发布。
- 开发依赖含 `@opennextjs/cloudflare`（`build:cf`）、`vitest`；未配置 prettier/format 脚本，代码风格靠 ESLint（`npm run lint`）约束。改动组件后跑 `npm run lint` 自查。
