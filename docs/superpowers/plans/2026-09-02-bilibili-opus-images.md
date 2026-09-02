# B 站图文动态（/opus/）解析与图集下载 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 B 站图文动态链接（`www.bilibili.com/opus/<id>` / b23.tv 短链跳转）可解析出全部原图 + 动态文案 + 作者信息，前端以图集卡片展示并支持一键下载。

**架构：** 在现有 `/api/bilibili` route 内按最终 URL 路径分流：`/opus/<id>` 走新增的图文解析（detail 接口无 cookie 即可访问），非纯图文类型（专栏文章等）明确拒绝；解析结果输出统一契约 `data`（`type:"image"`），经 normalizeResult 通用分支透传（不新增平台/归一化特例）。图文分类逻辑抽为纯函数 `src/lib/bilibili-opus.js` 以便单元测试。前端 `BilibiliVideo` 按 `type==="image"` 渲染图集分支（复用小红书图集的单图大图/多图网格/一键下载模式，B 站蓝主题）。

**技术栈：** Next.js 15（App Router + Route Handler，nodejs runtime）、Vitest、React 19、Tailwind；B 站 `x/polymer/web-dynamic/v1/detail` 接口。

**范围：** 仅 `/opus/<id>` 图文动态；`DYNAMIC_TYPE_DRAW` / `DYNAMIC_TYPE_OPUS` 两种纯图文类型；专栏文章（`DYNAMIC_TYPE_ARTICLE`，正文图接口已风控）明确拒绝。视频解析零回归。

**前置已确认（实测，勿重复探测）：**
- detail 接口 `GET https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=<id>&features=itemOpusStyle` 无 cookie/wbi 即可返回（浏览器 UA + Referer 兜底），海外出口亦可
- 图片位于 `detail.data.item.modules.module_dynamic.major.opus.pics[].url`（http 开头需转 https 防混合内容拦截），hdslb 图床无防盗链
- 作者 `module_author`：`name`/`mid`/`face`/`pub_ts`；统计 `module_stat`：`like`/`comment`/`forward` 各带 `count`
- 文案 `major.opus.summary.text`（保留换行/话题/#tag#/emoji 名）；标题 `major.opus.title`
- 样例：纯图文 `https://www.bilibili.com/opus/1162034214051250177`（DYNAMIC_TYPE_DRAW，作者「EWEADN前行者」）；专栏文章 `https://www.bilibili.com/opus/935868030912561161`（DYNAMIC_TYPE_ARTICLE）

---

## 文件结构

| 操作 | 文件 | 职责 |
|---|---|---|
| 创建 | `src/lib/bilibili-opus.js` | 纯函数：detail 响应 → 分类结果（ok + 统一 data / 拒绝 msg），无网络依赖 |
| 修改 | `src/app/api/bilibili/route.js` | 分流 `/opus/<id>` + 网络请求封装 `parseBilibiliOpus` |
| 创建 | `tests/bilibili-opus.test.ts` | `classifyOpusDetail` 单元测试（DRAW/OPUS/ARTICLE/纯文字/其它类型） |
| 修改 | `src/components/videos/ParseInfoPanel.tsx` | 新增 `bilibiliOpus` 字段集（避免图文复用视频表时标签错误） |
| 修改 | `src/components/videos/BilibiliVideo.tsx` | `type==="image"` 图集卡片分支 + 文案/信息面板标题条件 |
| 修改 | `tests/live/parse-live.test.ts` | 新增可选 `bilibili-opus` live case（复用 `GETBilibili`） |
| 修改 | `tests/live/urls.example.env` | 增加 `LIVE_URL_BILIBILI_OPUS` |
| 修改 | `API.md` | 补充 bilibili 接口支持的图文动态链接格式与 `type:"image"` 响应 |

数据流：`/api/parse`（unifiedParser）或 `/api/bilibili` 直连 → `getBilibiliVideoInfo(url)` → pathname 含 `/opus/<id>` → `parseBilibiliOpus(url, id)`（网络 fetch）→ `classifyOpusDetail(detail)`（纯分类）→ `{code:200, data:{type:"image", …}}` → normalizeResult 通用分支透传 → 前端 `platformRenderers.bilibili` → `BilibiliVideo` 图集分支。

---

### 任务 1：图文分类纯函数 + 单元测试

**文件：**
- 创建：`src/lib/bilibili-opus.js`
- 创建：`tests/bilibili-opus.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `tests/bilibili-opus.test.ts`，内容如下（fixture 结构与真实接口字段一致；`mid`/统计取自已探测的 EWEADN前行者 样例）：

```ts
// @ts-nocheck
import { describe, expect, it } from "vitest";
import { classifyOpusDetail } from "@/lib/bilibili-opus.js";

/** 用图文 item 组装完整 detail 响应（与真实接口外层一致） */
function wrapDetail(item) {
  return { code: 0, data: { item, res: { code: 0 } } };
}

/** 纯图文 item：EWEADN前行者 鼠标垫宣发动态（DYNAMIC_TYPE_DRAW，默认单图） */
function drawItem(pics = [{ url: "http://i0.hdslb.com/bfs/new_dyn/pic1" }]) {
  return {
    type: "DYNAMIC_TYPE_DRAW",
    modules: {
      module_author: {
        mid: 3493259242375305,
        name: "EWEADN前行者",
        face: "http://i1.hdslb.com/bfs/face/avatar.jpg",
        pub_ts: 1769395574,
      },
      module_dynamic: {
        major: {
          opus: {
            title: "经典设计美学——前行者ES98",
            pics,
            summary: { text: "以精工细作，雕琢每一处光影与弧度" },
          },
        },
      },
      module_stat: {
        like: { count: 1129 },
        comment: { count: 1936 },
        forward: { count: 1645 },
      },
    },
  };
}

describe("classifyOpusDetail：图文动态分类与归一", () => {
  it("DYNAMIC_TYPE_DRAW 纯图文 → ok，图片 http 转 https 且全量归入 images", () => {
    const out = classifyOpusDetail(
      wrapDetail(
        drawItem([
          { url: "http://i0.hdslb.com/bfs/new_dyn/pic1" },
          { url: "http://i0.hdslb.com/bfs/new_dyn/pic2" },
        ])
      )
    );
    expect(out.ok).toBe(true);
    expect(out.data.type).toBe("image");
    expect(out.data.images).toEqual([
      "https://i0.hdslb.com/bfs/new_dyn/pic1",
      "https://i0.hdslb.com/bfs/new_dyn/pic2",
    ]);
    expect(out.data.cover).toBe("https://i0.hdslb.com/bfs/new_dyn/pic1");
    expect(out.data.title).toBe("经典设计美学——前行者ES98");
    expect(out.data.desc).toBe("以精工细作，雕琢每一处光影与弧度");
    expect(out.data.author).toBe("EWEADN前行者");
    expect(out.data.authorId).toBe("3493259242375305");
    expect(out.data.authorUrl).toBe("https://space.bilibili.com/3493259242375305");
    expect(out.data.avatar).toBe(
      `/api/image?url=${encodeURIComponent(
        "https://i1.hdslb.com/bfs/face/avatar.jpg"
      )}`
    );
    expect(out.data.time).toBe(1769395574);
    expect(out.data.stat).toEqual({ like: 1129, reply: 1936, share: 1645 });
  });

  it("DYNAMIC_TYPE_OPUS（新版图文）同样支持", () => {
    const out = classifyOpusDetail(
      wrapDetail({ ...drawItem(), type: "DYNAMIC_TYPE_OPUS" })
    );
    expect(out.ok).toBe(true);
    expect(out.data.images.length).toBeGreaterThan(0);
  });

  it("DYNAMIC_TYPE_ARTICLE（专栏文章）→ 拒绝并提示专栏", () => {
    const out = classifyOpusDetail(
      wrapDetail({ ...drawItem(), type: "DYNAMIC_TYPE_ARTICLE" })
    );
    expect(out.ok).toBe(false);
    expect(out.msg).toContain("专栏");
  });

  it("纯文字动态（DRAW 无 pics）→ 拒绝并提示不包含图片", () => {
    const out = classifyOpusDetail(wrapDetail(drawItem([])));
    expect(out.ok).toBe(false);
    expect(out.msg).toContain("不包含图片");
  });

  it("视频/其它动态类型 → 拒绝并提示不是图文内容", () => {
    const out = classifyOpusDetail(
      wrapDetail({ ...drawItem(), type: "DYNAMIC_TYPE_AV" })
    );
    expect(out.ok).toBe(false);
    expect(out.msg).toContain("不是图文内容");
  });

  it("detail 缺失 item（接口异常）→ 解析失败", () => {
    expect(classifyOpusDetail({ code: -352, message: "风控" })).toEqual({
      ok: false,
      msg: "解析失败！",
    });
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run tests/bilibili-opus.test.ts`
预期：FAIL（`Cannot find module '@/lib/bilibili-opus.js'`），确认测试文件自身加载正常。

- [ ] **步骤 3：实现分类纯函数**

创建 `src/lib/bilibili-opus.js`，内容如下：

```js
/**
 * B 站图文动态（/opus/<id>）detail 响应分类与归一 —— 纯函数，不发起网络请求，
 * 供 route.js 调用与单元测试直接 import。
 *
 * 输入：x/polymer/web-dynamic/v1/detail 的 JSON（code 应为 0）
 * 输出：
 *   - 纯图文（DYNAMIC_TYPE_DRAW / DYNAMIC_TYPE_OPUS 且 pics 非空）
 *     → { ok: true, data: { type:"image", title, desc, cover, images, author,
 *        authorId, authorUrl, avatar, time, stat } }（data 即统一 ParseData 形状）
 *   - 其余 → { ok: false, msg }
 *
 * 实测结构：detail.data.item = {
 *   type: "DYNAMIC_TYPE_DRAW" | "DYNAMIC_TYPE_OPUS" | "DYNAMIC_TYPE_ARTICLE" | ...,
 *   modules: {
 *     module_author: { mid, name, face, pub_ts },
 *     module_dynamic: { major: { opus: { title, pics: [{ url }], summary: { text } } } },
 *     module_stat: { like: {count}, comment: {count}, forward: {count} },
 *   },
 * }
 * 边界：ARTICLE（专栏文章）pics 只是封面入口图，正文图需走已风控的专栏接口，明确拒绝。
 */

/** http → https：hdslb 图床图片 http 直链在 https 页面会被混合内容拦截破图 */
function toHttps(url) {
  if (typeof url !== "string") return "";
  return url.replace(/^http:\/\//i, "https://");
}

/** 空串 / "-" / 纯空白视为无文案（与视频 desc 归一行为一致） */
function cleanText(text) {
  if (typeof text !== "string") return "";
  const t = text.trim();
  if (!t || t === "-") return "";
  return text;
}

/** B 站头像 face 可能为 http 直链，统一走站内图片代理（同源返回 + 防盗链兜底） */
function proxifyImage(url) {
  const httpsUrl = toHttps(url);
  if (!httpsUrl) return "";
  return `/api/image?url=${encodeURIComponent(httpsUrl)}`;
}

/** 统计计数：仅保留正数，缺失/异常返回 undefined（前端该行自动隐藏） */
function positiveCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function classifyOpusDetail(detail) {
  const item = detail?.data?.item;
  if (!item) return { ok: false, msg: "解析失败！" };

  const type = item.type || "";
  const modules = item.modules || {};
  const opus = modules.module_dynamic?.major?.opus || {};
  const pics = (Array.isArray(opus.pics) ? opus.pics : [])
    .map((pic) => toHttps(pic?.url))
    .filter(Boolean);

  // 白名单之外的类型一律拒绝（专栏文章封面图只是入口图，正文需另走已风控接口）
  if (!/^(DYNAMIC_TYPE_DRAW|DYNAMIC_TYPE_OPUS)$/.test(type)) {
    const msg =
      type === "DYNAMIC_TYPE_ARTICLE"
        ? "该动态是B站专栏文章，非图文动态，暂不支持解析正文图片"
        : "该动态不是图文内容，仅支持图文动态（/opus/ 链接）";
    return { ok: false, msg };
  }
  // 发图文不带图（纯文字动态）时 major.opus 无 pics
  if (pics.length === 0) {
    return { ok: false, msg: "该动态不包含图片（纯文字动态），仅支持图文动态" };
  }

  const author = modules.module_author || {};
  const stat = modules.module_stat || {};
  const mid = author.mid;
  const pubTs = Number(author.pub_ts);
  const time = Number.isFinite(pubTs) && pubTs > 0 ? pubTs : undefined;

  return {
    ok: true,
    data: {
      type: "image",
      title: opus.title || undefined,
      desc: cleanText(opus.summary?.text) || undefined,
      cover: pics[0],
      images: pics,
      author: author.name || undefined,
      authorId: mid != null ? String(mid) : undefined,
      authorUrl: mid != null ? `https://space.bilibili.com/${mid}` : undefined,
      avatar: proxifyImage(author.face),
      time,
      stat: {
        like: positiveCount(stat.like?.count),
        reply: positiveCount(stat.comment?.count),
        share: positiveCount(stat.forward?.count),
      },
    },
  };
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run tests/bilibili-opus.test.ts`
预期：PASS（6 个用例全绿）。

- [ ] **步骤 5：Commit**

```bash
git add tests/bilibili-opus.test.ts src/lib/bilibili-opus.js
git commit -m "feat: 新增 bilibili 图文动态分类纯函数与单元测试"
```

---

### 任务 2：bilibili route 接入图文解析（分流 + 网络封装）

**文件：**
- 修改：`src/app/api/bilibili/route.js`

- [ ] **步骤 1：引入分类函数**

在 `route.js` 顶部 import 区（第 3 行 `import crypto from "crypto";` 之后）追加：

```js
import { classifyOpusDetail } from "@/lib/bilibili-opus";
```

- [ ] **步骤 2：主解析函数开头分流**

在 `getBilibiliVideoInfo` 中，将（当前约 253-255 行）：

```js
    if (!bvid.includes("/video/")) {
      return { code: -1, msg: "好像不是视频链接" };
    }
```

替换为（`bvid` 此时已是路径，b23.tv 分支为重定向后 pathname，两者都可能为 `/opus/<id>` 形态）：

```js
    // 图文动态（/opus/<id>）：先于视频校验分流；非纯图文类型（专栏文章/视频动态等）
    // 由 classifyOpusDetail 给出针对性提示
    const opusMatch = bvid.match(/\/(?:opus|dynamic)\/(\d+)/);
    if (opusMatch) {
      return parseBilibiliOpus(url, opusMatch[1]);
    }

    if (!bvid.includes("/video/")) {
      return { code: -1, msg: "好像不是视频链接" };
    }
```

> `bvid` 变量名保留原样（多分支沿用），避免大范围改名；`/dynamic/<id>` 一并支持（detail 接口同构，社区仍存在该形态分享）。

- [ ] **步骤 3：新增图文解析网络封装**

在 `getBilibiliVideoInfo` 函数结束（第 432 行 `}`）之后、`export const GET`（第 434 行）之前，插入：

```js
/**
 * 图文动态（/opus/<id>）解析：detail 接口无 cookie 即可访问（带上 buvid 通行证更稳）。
 * 纯图文返回统一契约 { code:200, data:{ type:"image", ... } }，
 * 走 normalizeResult 通用分支透传（不新增特例）；非纯图文返回 code:0 + 明确 msg。
 */
async function parseBilibiliOpus(url, opusId) {
  try {
    // 数据中心/海外出口无 Cookie 直调会被 WAF 拦成 HTML，先取 buvid 写入 Cookie 池
    await getBuvid();
    const headers = { "Content-Type": "application/json;charset=UTF-8" };
    const detail = await bilibiliRequest(
      `https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=${opusId}&features=itemOpusStyle`,
      headers
    );
    if (!detail || detail.code !== 0 || !detail.data?.item) {
      logger.warn("Failed to fetch opus detail, response:", detail);
      return { code: 0, msg: "解析失败！" };
    }
    const outcome = classifyOpusDetail(detail);
    if (!outcome.ok) return { code: 0, msg: outcome.msg };
    logger.log(`Successfully parsed bilibili opus ${opusId}, images: ${outcome.data.images.length}`);
    return { code: 200, msg: "解析成功！", data: outcome.data };
  } catch (error) {
    logger.error("Error parsing bilibili opus:", error.message);
    return { code: 0, msg: "解析失败！" };
  }
}
```

> 步骤 2 的 `parseBilibiliOpus` 为函数声明（function declaration），存在提升，顺序无碍。

- [ ] **步骤 4：分类器单测回归**

运行：`npx vitest run tests/bilibili-opus.test.ts`
预期：PASS（分类纯函数不受 route 修改影响）。

- [ ] **步骤 5：冒烟验证（dev server + 真实链接）**

启动 dev：`npm run dev`（独立终端，确认 `http://localhost:3000` 可访问）后运行：

```
node -e "const u='http://localhost:3000/api/bilibili?url='+encodeURIComponent('https://www.bilibili.com/opus/1162034214051250177');fetch(u).then(r=>r.json()).then(j=>console.log('code',j.code,'type',j.data&&j.data.type,'img',(j.data&&j.data.images||[]).length,'author',j.data&&j.data.author,'msg',j.msg))"
```

预期：`code 200 type image img 1 author EWEADN前行者 msg 解析成功！`

```
node -e "const u='http://localhost:3000/api/bilibili?url='+encodeURIComponent('https://www.bilibili.com/opus/935868030912561161');fetch(u).then(r=>r.json()).then(j=>console.log('code',j.code,'msg',j.msg))"
```

预期：`code 0`，`msg` 含「专栏」。

```
node -e "const u='http://localhost:3000/api/bilibili?url='+encodeURIComponent('https://www.bilibili.com/video/BV1sK826SENY');fetch(u).then(r=>r.json()).then(j=>console.log('code',j.code,'videos',j.data&&(j.data.videos||[]).length,'title',j.data&&j.data.title))"
```

预期：`code 200` 且 `videos` ≥ 1（视频解析零回归）。若该 BV 已失效，换任一真实视频链接复测。

- [ ] **步骤 6：Commit**

```bash
git add src/app/api/bilibili/route.js
git commit -m "feat: /api/bilibili 支持图文动态 /opus/ 解析（纯图文返回 type:image）"
```

---

### 任务 3：前端图文图集渲染

**文件：**
- 修改：`src/components/videos/ParseInfoPanel.tsx`
- 修改：`src/components/videos/BilibiliVideo.tsx`

- [ ] **步骤 1：ParseInfoPanel 新增 bilibiliOpus 字段集**

在 `src/components/videos/ParseInfoPanel.tsx` 的 `PLATFORM_FIELDS` 中，`bilibili: [...]` 对象闭合（约 207 行 `],`）之后、`// 博主卡已展示：昵称 / 小红书号 ...`（xhs 注释，209 行）之前插入：

```ts
  // B站图文动态（/opus/）：动态标题 + 发布时间 + 互动统计（统计由后端归一到 stat.like/reply/share）
  bilibiliOpus: [
    { key: "title", label: "动态标题" },
    { key: "time", label: "发布时间", format: formatTime },
    { key: "stat.like", label: "点赞", format: formatCount },
    { key: "stat.reply", label: "评论", format: formatCount },
    { key: "stat.share", label: "分享", format: formatCount },
    TYPE_FIELD,
  ],
```

（`TYPE_FIELD` 的 `format: formatType` 已映射 `image → "图文 / 图集"`。）

- [ ] **步骤 2：BilibiliVideo 加入图集分支（导入与状态）**

`src/components/videos/BilibiliVideo.tsx` 顶部 import 区，将第 8 行 `import CaptionBox from "./CaptionBox";` 后追加两个 import，并把 lucide import 补齐：

原：
```tsx
import CaptionBox from "./CaptionBox";
import { Check, ChevronDown, Download } from "lucide-react";
```
改为：
```tsx
import CaptionBox from "./CaptionBox";
import CollapsibleGallery from "./CollapsibleGallery";
import { downloadAllImages } from "@/utils/downloadImages";
import { Check, ChevronDown, Download, Loader2 } from "lucide-react";
```

在 `BilibiliVideo` 组件函数体最顶部（`const parsed = data.data;` 之前）插入状态：

```tsx
  // 图文图集加载/下载状态（图片分支专用）
  const [imageLoading, setImageLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
```

在 `const parsed = data.data;` 之后的现有声明区（约 214-220 行）追加：

```tsx
  // 图文动态（/opus/）归一化后 type="image" + images[]，走图集卡片分支
  const isImage =
    parsed?.type === "image" && (parsed?.images?.length ?? 0) > 0;
  const images = (parsed?.images?.filter(Boolean) as string[]) || [];
```

在 `scrollToDownload` 函数之后追加下载处理：

```tsx
  /** 一键下载全部图片（文件名前缀 bilibili-作者名，扩展名按实际图片类型补齐） */
  const handleDownloadAll = async () => {
    if (downloading || images.length === 0) return;
    setDownloading(true);
    try {
      await downloadAllImages(images, `bilibili-${parsed?.author || "图文动态"}`);
    } finally {
      setDownloading(false);
    }
  };
```

- [ ] **步骤 3：BilibiliVideo 渲染图文图集卡片**

在「Video：封面 + 播放 …」播放器块（`{hasVideo && primaryVideoUrl && (...)}`，约 344-355 行）**之后**插入图集块（视频与图集互斥：opus 结果 `videos` 为空，两块不会同时出现）：

```tsx
      {/* 图文图集：单图大图（B站蓝主题）/ 多图网格（2/3/4 张自适应），点击打开原图，
          与小红书图集卡片交互一致；封面 alt 文案与图片命名同用动态标题 */}
      {isImage && images.length > 0 && (
        <Card className="p-3">
          {images.length === 1 ? (
            <a
              href={images[0]}
              target="_blank"
              rel="noopener noreferrer"
              className="relative block aspect-square rounded-xl overflow-hidden bg-black">
              {imageLoading && (
                <div className="absolute inset-0 bg-glass-2 animate-pulse" />
              )}
              <Image
                src={images[0]}
                alt={parsed?.title || "图片"}
                fill
                sizes="(max-width: 800px) 100vw, 800px"
                className="object-cover"
                priority
                unoptimized
                onLoad={() => setImageLoading(false)}
              />
            </a>
          ) : (
            <CollapsibleGallery>
              <div
                className={`grid gap-2 ${
                  images.length === 2
                    ? "grid-cols-2"
                    : images.length === 3
                      ? "grid-cols-3"
                      : images.length === 4
                        ? "grid-cols-2"
                        : "grid-cols-3"
                }`}>
                {images.map((imageUrl, index) => (
                  <a
                    key={index}
                    href={imageUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`relative aspect-square rounded-xl overflow-hidden group block bg-black ${
                      images.length === 4 && index >= 2 ? "col-span-1" : ""
                    }`}>
                    <Image
                      src={imageUrl}
                      alt={`${parsed?.title || "图片"} ${index + 1}`}
                      fill
                      sizes="(max-width: 800px) 50vw, 400px"
                      className="object-cover transition-transform duration-500 group-hover:scale-105"
                      unoptimized
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                  </a>
                ))}
              </div>
            </CollapsibleGallery>
          )}

          {/* 一键下载全部图片 */}
          <Button
            type="button"
            onClick={handleDownloadAll}
            disabled={downloading}
            size="lg"
            className="mt-3 w-full bg-gradient-to-r from-[#00aeec] to-[#4dc9ff] hover:opacity-90">
            {downloading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                正在下载...
              </>
            ) : (
              <>
                <Download className="h-4 w-4" />
                一键下载全部图片（{images.length} 张）
              </>
            )}
          </Button>
        </Card>
      )}
```

- [ ] **步骤 4：文案与信息面板按图文切换标题**

将（约 358 行）：

```tsx
      {/* 文案：视频下方，可一键复制 */}
      {parsed?.desc && <CaptionBox text={parsed.desc} title="视频简介" />}
```

改为：

```tsx
      {/* 文案：视频简介 / 图文动态文案，可一键复制 */}
      {parsed?.desc && (
        <CaptionBox text={parsed.desc} title={isImage ? "动态文案" : "视频简介"} />
      )}
```

将（约 361 行）：

```tsx
      {/* 视频信息：UP主 / 分P数量（放在简介下方） */}
      <ParseInfoPanel platform="bilibili" data={parsed} title="视频信息" />
```

改为：

```tsx
      {/* 信息面板：视频信息 / 图文信息（图文用专用字段集避免「视频标题/视频」错标） */}
      <ParseInfoPanel
        platform={isImage ? "bilibiliOpus" : "bilibili"}
        data={parsed}
        title={isImage ? "图文信息" : "视频信息"}
      />
```

- [ ] **步骤 5：Lint + 单元测试回归**

运行：
```
npx eslint src/components/videos/BilibiliVideo.tsx src/components/videos/ParseInfoPanel.tsx src/app/api/bilibili/route.js src/lib/bilibili-opus.js
npx vitest run tests/bilibili-opus.test.ts
```
预期：eslint 无错误；vitest 全绿。

- [ ] **步骤 6：Commit**

```bash
git add src/components/videos/BilibiliVideo.tsx src/components/videos/ParseInfoPanel.tsx
git commit -m "feat: BilibiliVideo 支持图文动态图集卡片展示与一键下载全部图片"
```

---

### 任务 4：live 测试与文档

**文件：**
- 修改：`tests/live/parse-live.test.ts`
- 修改：`tests/live/urls.example.env`
- 修改：`API.md`

- [ ] **步骤 1：live 测试新增 bilibili-opus 可选 case**

在 `tests/live/parse-live.test.ts` 的 `CASES` 中 `bilibili` 条目（约 88-92 行）之后插入：

```ts
  {
    id: "bilibili-opus",
    path: "/api/bilibili",
    envKey: "LIVE_URL_BILIBILI_OPUS",
    GET: GETBilibili,
  },
```

（`expectPlayablePayload` 中 `id === "bilibili"` 特例不影响 `"bilibili-opus"`——后者走通用分支：无 `url` 时有 `images[0]` 为 http(s) 即通过。）

- [ ] **步骤 2：样例 env 文件加行**

在 `tests/live/urls.example.env` 第 8 行 `LIVE_URL_BILIBILI=` 后追加：

```
LIVE_URL_BILIBILI_OPUS=https://www.bilibili.com/opus/1162034214051250177
```

- [ ] **步骤 3：API.md 补充文档**

`API.md` 第 183-196 行的「哔哩哔哩视频解析」参数表后，`**支持的链接格式**:` 列表追加一条：

```md
- `https://www.bilibili.com/opus/<id>` / `https://m.bilibili.com/opus/<id>`（图文动态，返回 `type: "image"` + `images[]`；专栏文章等非纯图文会返回错误提示）
```

并在该节响应示例后补一条说明段落：

```md
**图文动态响应补充**：图文动态为纯图片内容，无 `videos`/`url`；图片直链在 `data.images`（原图，已统一 https），`data.cover` 为首图，`data.desc` 为动态文案，`data.type` 为 `"image"`。前端展示为图集卡片并支持一键下载全部图片。
```

- [ ] **步骤 4：全套单元测试回归**

运行：`npm test`
预期：全部 PASS（无网络用例）。

- [ ] **步骤 5：Commit**

```bash
git add tests/live/parse-live.test.ts tests/live/urls.example.env API.md
git commit -m "docs: bilibili 图文动态支持说明 + live 测试用例"
```

---

### 任务 5：验收（端到端回归，不提交）

**文件：** 无

- [ ] **步骤 1：dev 手测图文解析展示**

dev server 运行中，浏览器打开 `http://localhost:3000`，粘贴 `https://www.bilibili.com/opus/1162034214051250177`：
预期：B 站蓝作者卡（EWEADN前行者）→ 图集卡片（单图大图）→「动态文案」复制块 →「图文信息」面板（动态标题/发布时间/点赞/评论/分享/内容类型：图文 / 图集）→ 下载按钮「一键下载全部图片（1 张）」，点击后浏览器保存 `bilibili-EWEADN前行者-1.jpg`（或按实际图片类型命名）。

- [ ] **步骤 2：dev 手测拒绝与视频回归**

分别粘贴：
1. `https://www.bilibili.com/opus/935868030912561161` → 失败提示含「专栏」
2. 任一真实视频链接（如 `BV1sK826SENY`）→ 原视频卡片（播放器 + 分P 下载行 + 视频简介 + 视频信息）无回归
3. `fmt=text` 方式请求图文链接 → 第二行应为首图直链

- [ ] **步骤 3：live 冒烟（可选，需要出口网络）**

配置 `.env` 中 `RUN_LIVE_PARSE=1`、`LIVE_URL_BILIBILI`、`LIVE_URL_BILIBILI_OPUS` 后运行：`npm run test:live`
预期：`bilibili-opus` 通过（`data.images[0]` 为 http(s)）。

---

## 自检记录

- **规格覆盖度**：设计文档各节均有对应任务——分流/网络封装（任务 2）、类型判定与字段映射纯函数（任务 1）、错误文案（任务 1 + 2）、图集渲染与一键下载（任务 3）、信息面板字段集（任务 3 步骤 1）、live 测试与样例 env（任务 4）、API 文档（任务 4）。设计文档「无需改动点」各项（unifiedParser / platformRoutes / fmt=text / 归一化通用分支）均已核实为现状无需改动。
- **占位符扫描**：无 TODO /「添加错误处理」类占位；所有代码块完整可粘贴。
- **类型一致性**：`classifyOpusDetail` 返回值 `ok/data|msg` 在 route 与测试中一致消费；data 字段（type/title/desc/cover/images/author/authorId/authorUrl/avatar/time/stat）与前端 `ParseData`、`bilibiliOpus` 字段集（title/time/stat.like/stat.reply/stat.share/type）逐项对齐；`parseBilibiliOpus(url, opusId)` 双参签名在两处调用一致。
- **风险确认**：Next.js route 模块限制额外导出（避免在 route.js export 非 HTTP 函数，分类器独立成 lib 文件）；`/opus/<id>` 前先过 `b23.tv` 重定向；视频路径不含 `/opus/` 不受影响。
