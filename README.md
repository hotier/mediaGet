# 即刻解析 · mediaGet

短视频解析 + 音乐解析下载服务：粘贴分享链接 / 整段分享文案，即得无水印直链。

- 在线体验：<https://get.hotier.cc.cd>
- 视频解析：`/`（首页）
- 音乐解析：`/music`

> 免责声明：本项目仅用于技术学习与搜索聚合演示，不存储、不传播任何受版权保护的内容，请勿用于商业或侵权用途。

## 功能特性

### 视频解析（首页 `/`）

- 支持 **21 个平台**的视频 / 图文 / 音频解析与下载：抖音、快手、微博、哔哩哔哩、小红书、汽水音乐、皮皮虾、皮皮搞笑、西瓜视频、最右、虎牙、AcFun、全民K歌、QQ音乐、六间房、新片场、好看视频、TikTok、X（Twitter）、Instagram、YouTube
- 输入方式：分享链接、整段分享文案（自动提取链接）或 `source+id` 直接解析（部分平台）
- 自动识别平台与内容类型（视频 / 图文 / 音乐），统一数据契约输出；支持 `fmt=text` 纯文本输出（iOS 快捷指令等）
- 图文内容图集展示、多选批量下载；哔哩哔哩支持多分 P / 清晰度选择；音乐类内容（汽水音乐 / QQ音乐）直接下载音频
- 解析结果 24h 共享缓存，再次打开秒回；直链失效自动重解析；同链接并发只抓一次
- 部分平台说明：
  - 抖音：匿名解析为主链路，可配 `DOUYIN_COOKIE` 增强
  - 哔哩哔哩：强烈建议配 `BILIBILI_COOKIE`（穿透服务器 / 数据中心出口的 -412/-352 风控）
  - 微博：自动游客模式，无需配置 Cookie
  - 小红书 / Instagram：可选配 `XHS_COOKIE` / `IG_COOKIE`（登录墙平台）
  - YouTube：纯 HTTP 多源（Piped / Invidious，可自托管）竞速解析，源不可用时自动降级为官方嵌入播放（无直链）
  - 微信视频号，以及腾讯视频 / 爱奇艺 / 优酷 / 芒果TV / Netflix / Spotify 等付费或 DRM 平台会直接提示不支持
- 平台可用性依赖各站实时接口，部分平台可能受风控 / 地区影响暂时不可用

### 音乐解析（`/music`）

- 多源聚合在线搜歌 / 试听 / 播放 / 滚动歌词 / 封面 / 下载
- 默认上游覆盖网易云 / 酷我 / JOOX 等曲库（GD 契约，支持多基址回退）；内置腾讯(QQ音乐) / 酷狗 / 咪咕 **自研直连搜索** chips（服务器直连各家搜歌，网易云 / 酷我在 GD 通道不可用时自动回退该通道）；并支持洛雪（lx-music）生态自定义音源扩展；支持**聚合搜索**：一次并发搜索全部可用音源，跨源同曲自动去重、按关键词相关度打分排序展示（单源搜索照旧保留）
- 网易云 / QQ音乐 / 酷我 歌曲链接可一键解析为单曲（元数据 + 播放 / 下载）；酷狗链接已可识别、直链引擎待接入；酷狗 / 咪咕自研搜索结果默认仅搜索识别——配置洛雪聚合音源脚本后，点播 / 切音质会自动改由音源脚本按同曲 hash/id 换直链试听
- **洛雪自定义音源接入**：单文件洛雪协议音源脚本（qdy / qsvip 类）可经 `MUSIC_LX_SCRIPTS`（URL / 本地路径，可多个）、`MUSIC_LX_SCRIPTS_DIR`（脚本目录）或直接放进仓库 `.lxref/scripts/`（本地开发与 Docker“放入即生效”）加载；脚本源码 TTL 内缓存、目录变化下次自动生效，播放失败时也会把这些扩展源纳入“跨源现搜”换源兜底；另支持「平台→音源脚本取直链兜底」：netease/tencent/kuwo/kugou/migu 曲目在自身直链失败（VIP 受限等）或无内置直链时，自动改由已注册的对应音源脚本按同曲 id/hash/songmid 换链（默认映射 wy/tx/kw/kg/mg，可用 `MUSIC_LX_URL_FALLBACKS` 增改或关闭）

### 站点

- SEO：sitemap / robots / JSON-LD；FAQ（`/faq`）与法律页（`/legal/terms`、`/legal/privacy`、`/legal/dmca`）
- 深浅色主题（默认跟随系统，可手动切换）、PWA 可安装（API 响应不做 Service Worker 缓存）
- 移动端友好，解析结果与会话级恢复（刷新不丢）

## 技术栈

- Next.js 15（App Router）+ React 19，TypeScript / JavaScript 混合
- Tailwind CSS；基于 shadcn/ui 规范的基础组件；Lucide 图标
- 测试：Vitest（纯本地单测 + live 真机测试）
- 部署：Vercel / Cloudflare Workers（OpenNext）/ Docker 均支持

## 本地开发

```bash
npm install
npm run dev        # 开发（next dev --turbopack）
npm run build      # 构建
npm start          # 生产运行
npm run lint
npm test           # 单元测试（无需外网）
```

## 真机测试（live，需真实分享链接）

单测不访问外部网络；需要联网验证真实链接的 live 测试另行运行：

1. 复制 `tests/live/urls.example.env` 为项目根目录 `.env`，按模板填入各平台真实分享链接（`LIVE_URL_*`，部分平台可留空跳过）
2. 执行：

```bash
npm run test:live
```

3. 平台 Cookie 按需补充（均为可选）：`BILIBILI_COOKIE`（服务器 / 数据中心出口强烈建议）、`DOUYIN_COOKIE`、`XHS_COOKIE` 等；微博为自动游客模式，**不再需要 `WEIBO_COOKIE`**。详见 `API.md`「限制说明 → 环境变量配置」。

## 部署

- **Vercel**：仓库导入即用。注意：TikTok 解析依赖 yt-dlp（child_process），Serverless 不可用；`/api/music` 的公共上游对数据中心出口会触发 CF 人机校验，需配置 `MUSIC_API_BASE(S)` 指向可直连的兼容实例（详见 `API.md`）。
- **Cloudflare Workers**（OpenNext）：`npm run build:cf` 生成 `.open-next/`，`wrangler.toml` 已就绪；敏感 Cookie 在 Worker Settings → Variables and Secrets 配置（CI 已接入自动 `wrangler secret put`）。
- **Docker**（当前线上正式运行方式）：多阶段 `Dockerfile` 已内置 yt-dlp + ffmpeg（TikTok 解析需要），镜像以非 root 运行：

```bash
docker build -t mediaget:latest .
docker run -d -p 3000:3000 --env-file .env mediaget:latest
```

需要启用洛雪自定义音源时，把脚本（如 `qdy.js`）放进仓库根目录 `.lxref/scripts/` 再 `docker build`，镜像即内置并在启动后自动加载（构建上下文默认包含该目录）；也可以运行时用 `MUSIC_LX_SCRIPTS_DIR` 挂载目录覆盖。

## 许可证

本项目仓库未附开源许可证文件（`package.json` 声明 `private: true`、`license: ISC`），不授权对外分发。
