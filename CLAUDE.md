# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ParseShort is a short video parsing and download service built with **Next.js 15** (App Router, React 19). It parses video links from 20+ social media platforms (Douyin, Kuaishou, Weibo, Bilibili, Xiaohongshu, etc., plus TikTok, X, Instagram and YouTube). The frontend is a single-page app; the backend is a collection of API route handlers.

## Commands

```bash
npm run dev       # Dev server with Turbopack
npm run build     # Production build
npm start         # Start production server
npm run lint      # ESLint (next lint)
npm test          # Unit tests via Vitest (no network)
npm run test:watch # Vitest in watch mode
npm run test:live  # Live integration tests (requires RUN_LIVE_PARSE=1 + URLs in .env)
```

Run a single test file: `npx vitest run tests/share.test.ts`

## Architecture

### Backend: Middleware + Per-Platform Parsers

All platform API routes (`src/app/api/{platform}/route.js`) follow the same pattern:

```
export const GET = createApiHandler(parseFunction)
```

`createApiHandler()` (in `src/lib/api-middleware.js`) wraps each parser with: optional Basic Auth, IP-based rate limiting (60 req/min), URL validation, SSRF protection, 5-minute in-memory cache, CORS, and error handling. The unified entry `/api/parse` additionally passes `sharedCache` — a 24-hour Cloudflare Cache API result cache (`src/lib/result-cache.js`) storing the platform-supplemented normalized result; on hit it probes the direct URL and re-parses when the cached link is definitively dead (404/410).

Platform parsers are standalone async functions (not classes). They typically: follow short URL redirects → fetch HTML with spoofed User-Agents → extract video IDs → parse embedded JSON (`window._ROUTER_DATA`, `__APOLLO_STATE__`, etc.) → return structured JSON. The Kuaishou parser (`src/lib/kuaishouCore.js`) is the exception — it's a class with multi-strategy parsing.

The unified endpoint `/api/parse` auto-detects the platform from a URL and dynamically imports the correct parser. It runs on Edge runtime. Most routes use Edge runtime; the Douyin route explicitly uses Node.js runtime for Docker compatibility.

The proxy route (`/api/proxy/route.ts`) forwards media requests with appropriate Referer/Cookie headers, with special handling for Bilibili and Douyin CDNs.

### Frontend: Single Page App

- `src/components/VideoParserForm.tsx` — Main form: auto-reads clipboard, extracts URLs with debounce, auto-detects platform, caches results in sessionStorage
- `src/components/videos/` — Platform-specific result display components, barrel-exported from `index.ts`
- `src/utils/share.ts` — URL extraction from Chinese social media share text, platform detection
- `src/config/video-platforms.ts` — Platform metadata (name, color, emoji) for UI
- `src/lib/platforms.ts` — Platform registry with domain mapping (used server-side)

### Key Lib Files

- `src/lib/api-utils.js` — Cache, rate-limit, SSRF protection, response helpers
- `src/lib/redirect-location.ts` — Follow 3xx redirects for short URLs

## Environment Variables

Configure in `.env` for full functionality:

- `DOUYIN_COOKIE`, `DOUYIN_USER_AGENT` — Douyin parsing
- `BILIBILI_COOKIE` — Bilibili parsing（建议配置：浏览器登录态完整 Cookie，必含 SESSDATA；规避数据中心出口的 -412/-352 风控。含失效自检：连续 5 次风控日志告警「BILIBILI_COOKIE 疑似失效」，成功自动复位，获取步骤见 `API.md`）
- `XHS_COOKIE` — Xiaohongshu parsing（数据中心/海外出口被风控时强烈建议配置）
- `WEIBO_COOKIE` — Weibo parsing
- `IG_COOKIE` — Instagram parsing（Instagram 对匿名访客开启登录墙，公开内容也需服务端配置登录态 Cookie；缺失时解析器返回明确提示）
- YouTube parsing is pure HTTP (serverless-friendly)：oEmbed 元数据 + 并发竞速多个 Piped/Invidious 公共实例取直链，**不依赖 yt-dlp**。2026-09 实测：官方登记 Invidious 实例（docs.invidious.io/instances）匿名 API 已全部被拒（403/401/反爬页），Piped 尚存可用社区实例，公共源整体波动大——稳定使用请配置下面两个自托管解析源环境变量
- `YOUTUBE_PIPED_HOSTS` — 逗号分隔的 Piped 解析服务（默认内置若干公共实例）。支持裸域名或完整 `https://...`（可填自托管实例，请求 `<base>/streams/{videoId}`）
- `YOUTUBE_INVIDIOUS_HOSTS` — 逗号分隔的 Invidious 解析服务（请求 `<base>/api/v1/videos/{videoId}`）
- `YOUTUBE_SOURCE_TIMEOUT_MS` — YouTube 单源请求超时（默认 6000）；注：yt-dlp 仅剩 TikTok 路由使用（`src/lib/tiktokDlp.js`）；YouTube 失败结果不会写入共享缓存（24h），瞬时故障重试即重新解析
- `TURSO_DB_URL`, `TURSO_AUTH_TOKEN` — Turso (libsql) database for parse analytics; when unset, analytics is silently disabled
- `STATS_API_KEY` — Bearer key protecting `GET /api/stats`; when unset, the stats endpoint returns 403
- `LIVE_URL_*` (21 variables) — Real share URLs for live tests (see `tests/live/urls.example.env`)

## Conventions

- **Mixed JS/TS**: Core lib files are plain JS (`src/lib/*.js`), API routes are JS, components are TSX, types in `src/types/`
- **Path alias**: `@/*` maps to `./src/*` (configured in tsconfig + vitest)
- **npm** is the package manager
- Test files use `@ts-nocheck` for flexibility
- API response format: `{ code: 200, msg: "...", data: {...}, platform: "..." }`

## Deployment

Three targets: Vercel (one-click), Cloudflare Workers (`wrangler.toml`), Docker (GHCR + Docker Hub via GitHub Actions). The Docker CI workflow runs unit tests before building.
