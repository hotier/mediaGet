# 即刻解析 短视频解析站点

一个短视频解析服务，支持 24+ 平台的视频解析与下载。

在线体验：<https://get.hotier.cc.cd>

> 免责声明：本项目仅用于技术学习与搜索聚合演示，不存储、不传播任何受版权保护的内容。请勿用于商业或侵权用途。

## 支持平台

抖音、快手、微博、哔哩哔哩、小红书、皮皮虾、皮皮搞笑、汽水音乐、绿洲、火山、微视、西瓜视频、最右、度小视、梨视频、虎牙、AcFun、美拍、逗拍、全民K歌、六间房、新片场、好看视频、X（Twitter）。

> 注：平台解析能力依赖各站实时接口，部分平台可能受风控/地区影响暂时不可用。

## 特点

- 高转化着陆页：简洁表单、即贴即得，降低用户流失
- 多平台覆盖：抖音/快手/B站/微博/小红书/西瓜/虎牙/X 等 24+ 平台
- 轻维护低成本：静态资源+Serverless/容器均可部署
- SEO 友好：Next.js 架构，天然利于索引与收录
- 可私有化：独立域名与数据可控

## 部署

### Vercel（推荐）

1. 将本仓库导入 Vercel（Import Git Repository）
2. 框架预设选择 **Next.js**，其余保持默认
3. 部署后在项目 Settings → Domains 绑定域名 `yourdomain.com`

### Cloudflare（Workers / OpenNext）

本仓库通过 [OpenNext](https://opennext.js.org/cloudflare) 适配器部署到 Cloudflare Workers，使用 `npm run build:cf` 构建，`wrangler.toml` 已就绪。

### Docker

```bash
docker build -t mediaget .
docker run --name mediaget -p 3000:3000 -d mediaget
```

## 本地开发

```bash
npm install
npm run dev      # 本地开发（next dev --turbopack）
npm run build    # 本地构建
npm test         # 单元测试
```

## 测试

### 单元测试（默认，无需外网）

```bash
npm test
```

包含 URL 提取 / 平台识别、`api-utils` 等本地逻辑，**不访问**各视频平台。

### 真机解析测试（直连上游，必配分享链接）

解析依赖各站实时页面与接口，**必须用真实分享链接**才能验证整条链路。

1. 复制模板并按平台填入你从 App 分享得到的链接（短链或详情页均可，失效后需更换）：

   - 模板文件：[`tests/live/urls.example.env`](tests/live/urls.example.env)
   - 将其中变量写入项目根目录的 `.env`（已加入 `.gitignore` 时不要提交真实链接）。

2. 执行：

   ```bash
   npm run test:live
   ```

3. 可选：`LIVE_PARSE_TIMEOUT_MS`（默认 `120000`）用于单条用例超时（毫秒）。

4. 抖音 / 微博 / 哔哩哔哩等若解析失败，请检查 `.env` 中是否按需配置了 `DOUYIN_COOKIE`、`WEIBO_COOKIE`、`BILIBILI_COOKIE`（与 `API.md` 一致）。

说明：真机测试受地区、风控、Cookie 与链接失效影响，失败时请更换有效分享链或网络环境后重试。

## 许可证

MIT License
