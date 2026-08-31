# mediaGet 二次开发路线图

> 部署目标：**Vercel**（Node.js runtime，无平台限制）
> 开发方向：前端 UI 改版（品牌 / 主题 / 多语言 / 移动端）+ 功能增强（批量解析 / 收藏夹 / 下载管理 / 音频提取 / 历史记录）

---

## 一、现状基线

### 技术栈
- Next.js 15（App Router）+ React 19 + Tailwind 3 + TypeScript/JS 混合
- 测试：Vitest（`npm test` 纯本地单测，`npm run test:live` 真机解析）
- 包管理：npm

### 关键架构
| 模块 | 位置 | 说明 |
|---|---|---|
| 平台 API 路由 | `src/app/api/{platform}/route.js` | 30+ 平台，`GET = createApiHandler(parser)` |
| 统一解析入口 | `src/app/api/parse/` | 自动识别平台，动态导入解析器 |
| 中间件 | `src/lib/api-middleware.ts` | Basic Auth、IP 限流、SSRF 防护、缓存、CORS |
| 统一数据契约 | `src/types/api.ts` | `ApiResponse` / `ParseData`（含 `audioUrl`、`images`、`videos`） |
| 品牌配置 | `src/config/site.ts` | 全站品牌唯一数据源 |
| 平台元数据 | `src/config/video-platforms.ts` | 平台名/色板/logo，UI 渲染依赖 |
| URL 提取/识别 | `src/utils/share.ts` | `extractUrl` 只取第一个 URL、`detectPlatform` |
| 前端中枢 | `src/app/page.tsx` | 状态管理 + 平台结果分发（switch case） |
| 解析表单 | `src/components/VideoParserForm.tsx` | 剪贴板读取、防抖、缓存、重试 |
| 结果组件 | `src/components/videos/` | 8 个平台专属 + `GenericParsedVideo` 兜底 |

### 现状问题（改造动因）
1. **品牌绑定**：全站"神族九帝/shenzjd.com"品牌 + 微信关注验证 + 外部 Web Components（`site-navbar`、`floating-qr`，依赖 unpkg）
2. **批量解析未真正实现**：README/FAQ 宣称多链接，代码一次只解析第一个 URL
3. **无持久化**：仅 5 分钟 sessionStorage 缓存，无历史 / 收藏
4. **无 i18n**：中文硬编码（`page.tsx`、`VideoParserForm`、`Footer`、`legal` 页）
5. **主题**：仅跟随系统 `prefers-color-scheme`，无手动切换
6. **微信登录强依赖**：`showWxAuth()` 在解析主流程强制调用

---

## 二、路线图（按依赖顺序 7 个阶段）

### Phase 0 — 品牌与依赖剥离（地基，必须最先做）✅ 已完成
**目标**：去除"神族九帝"品牌与外部依赖，换成自有品牌「即刻解析 / get.hotier.cc.cd」。
- [x] `src/config/site.ts`：品牌名 → 即刻解析，域名 → hotier.cc.cd，URL → https://get.hotier.cc.cd
- [x] 移除 `wx-auth-sdk` 全套（`layout.tsx` script、`wx-auth-client.ts`、`wx-auth-guard.ts`、`api-middleware.ts` 认证块、`VideoParserForm` 中 `showWxAuth` 调用、`tests/wx-auth-guard.test.ts`）
- [x] 移除 `site-navbar` / `floating-qr` 外部组件，自研 `src/components/SiteHeader.tsx` 替换
- [x] 清理 `page.tsx` / `platform/[key]` / `seo-platforms.ts` / `honeypot.ts` 硬编码品牌文案
- [x] 品牌资源：手写 `public/icon.svg` + AI 生成 `icon.png` / `og-image.png`，manifest / robots / sitemap / API.md / README 全更新
- [x] 后端去品牌：CORS 白名单 → `.hotier.cc.cd`、内部 UA / 缓存 key 同步更换
- [x] 验收：全站扫描无残留，`npm run build` 通过，115 个单元测试全过

### Phase 1 — 主题系统与品牌 UI 改版 ✅ 已完成
**目标**：可配置的品牌视觉（配色 / 字体 / 组件风格）+ 手动深浅色切换。
- [x] `globals.css` 重构设计令牌：`:root`（浅色）+ `.dark`（深色）双主题，`darkMode: "class"`
- [x] `layout.tsx` head 内联脚本初始化主题（无 FOUC）+ 全站 `aurora-grid` AI 网格背景层
- [x] 新增 `ThemeToggle`（localStorage 持久化，导航栏切换按钮）
- [x] 品牌渐变主色板（indigo→purple→pink），保留各平台色作为动态强调色（`--accent`）
- [x] Hero 重构：AI 状态徽章 + 超大渐变标题 + 带图标卖点 pills
- [x] 表单重构：`gradient-border` 渐变描边卡 + 发光输入框 + 渐变粘贴按钮
- [x] 结果卡 / 三步教程 / FAQ 卡片升级（渐变徽章、步骤渐变小图标）
- [x] Footer 品牌徽章；logo / favicon / OG 图（Phase 0 已产）

**验收**：一键切换浅 / 深色，品牌视觉统一，首页 200 + 主题脚本/网格/按钮全部生效。

### Phase 2 — 多语言 i18n
**目标**：中英双语（可扩展），覆盖页面与 SEO。
- [ ] 引入 `next-intl`（App Router 原生支持）
- [ ] 语言切换器（URL 前缀 `/`、`/en`）
- [ ] 文案抽离：`page.tsx`、`VideoParserForm`、`Footer`、`legal` 页
- [ ] SEO 多语言：`hreflang`、`sitemap`

**验收**：切换语言全站生效，英文版 SEO 正常。

### Phase 3 — 批量解析
**目标**：一次粘贴多行链接，排队解析，逐条展示。
- [ ] `src/utils/share.ts`：新增 `extractAllUrls`（提取全部 URL）
- [ ] `VideoParserForm`：多链接队列 + 并发控制（2~3 并发）+ 逐条状态
- [ ] `page.tsx`：结果数组状态，每条独立渲染（复用现有平台组件）
- [ ] 批量下载：逐条下载优先，可选 `jszip` 打包

**验收**：10 条链接一次粘贴，全部解析并逐条展示。

### Phase 4 — 历史记录与收藏夹
**目标**：本地持久化的解析历史 + 收藏。
- [ ] `src/lib/storage.ts`：封装 IndexedDB（`history` / `favorites` 两个 store）
- [ ] 历史记录：解析成功后自动写入（去重，限制条数）
- [ ] 收藏夹：结果卡片"收藏"按钮
- [ ] 新增"历史 / 收藏"页面或弹层（复用结果组件）

**注意**：Vercel 无状态，本地存储是正确方案；跨设备同步可后续接 Turso（依赖已可选引入）。

### Phase 5 — 下载管理与音频提取
**目标**：统一下载中心 + 音频提取。
- [ ] 下载中心（基于历史 / 收藏数据）
- [ ] "提取音频"：基于 `ParseData.audioUrl` 直链下载（已有字段）
- [ ] 多分 P（B 站）批量下载

**技术约束**：Vercel serverless **无 FFmpeg**，视频转码 / 音频分离不可行；音频提取仅限平台接口返回的 `audioUrl` 直链。

### Phase 6 — 移动端体验优化与 PWA
**目标**：移动端打磨 + 可安装 PWA。
- [ ] 移动端触控优化、结果卡片移动布局、底部操作栏
- [ ] PWA 完善（已有 `@ducanh2912/next-pwa` + manifest：补图标、离线缓存、安装提示）
- [ ] Lighthouse 性能优化

**验收**：移动端 Lighthouse PWA 达标。

### Phase 7 — 质量保障与上线
- [ ] Vitest 单测覆盖（`share.ts`、`storage.ts` 等纯逻辑）
- [ ] `npm run build` 通过
- [ ] Vercel 部署 + 环境变量配置
- [ ] 上线监控（`/api/health`；可选 `/api/stats` + Turso）

---

## 三、技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 主题切换 | CSS 变量 + `class` 策略 + localStorage | 轻量、无额外依赖 |
| i18n | `next-intl` | App Router 原生支持、体积小 |
| 本地存储 | IndexedDB（`idb`） | 历史可积累大量数据 |
| 批量下载 | 逐条下载优先，zip 可选 | 避免过度设计 |
| 音频提取 | 平台 `audioUrl` 直链 | Vercel 无 FFmpeg，无法转码 |
| 部署 | Vercel Node runtime | 无 Edge 限制，抖音路由已是 Node runtime |

---

## 四、风险与注意事项

- **平台风控**：解析成功率依赖各站实时接口，UI 改版不影响解析核心；如遇失败属正常波动
- **Vercel 限制**：无 FFmpeg、函数时长上限、文件系统只读——所有增强功能必须纯前端或纯 API 实现
- **版权合规**：保留免责声明与 `legal/` 页面
- **微信登录移除后**：如仍需防滥用，可用现有 IP 限流，或后续加轻量 API Key

---

## 五、实施顺序建议

```
Phase 0（品牌剥离）→ Phase 1（主题/UI）→ Phase 2（i18n）→ Phase 3（批量解析）
→ Phase 4（历史/收藏）→ Phase 5（下载/音频）→ Phase 6（移动端/PWA）→ Phase 7（质量/上线）
```

Phase 0、1 是地基，必须先完成；Phase 3~5 相互独立，可按需插队。
