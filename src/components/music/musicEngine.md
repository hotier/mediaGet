# 音乐聚合播放器「搜歌-播放」架构说明（现状基线 + 换源增强路线）

> 适用：/music 音乐中心（MusicExplorer）与后端音乐接口（`/api/music`、`/api/music/self`、`/api/music/lx`、`/api/music/resolve`）。
> 定位：本文是**模块内设计文档**，面向实现与改造。术语、字段、路由必须与 `src/lib/music-client.ts`、`src/lib/gdmusic.js`、`src/components/music/use-player-engine.ts`、`src/app/api/music/**` 实际代码一致；落地任何增强后，同步刷新 `CLAUDE.md` / `API.md` 的相关描述。
> 核心设计：**搜索与播放解耦，ID 优先播放、懒降级半自动换源，相似度校验防错歌，分层缓存减少第三方请求**。
> 用途约束：个人学习研究使用，禁止商用；第三方请求遵循“最小打扰”。

---

## 目录

1. 现状架构基线（已落地代码事实）
2. 现状约束清单（增强设计的地基）
3. 增强目标与不变式
4. 播放失败闭环（核心）
5. 候选池的落地边界
6. 相似度匹配规则 v2（防错歌）
7. 缓存体系 v2（分层 + 部署载体约束）
8. 前端交互（现状 + 增强后分支）
9. 性能与调优方向
10. 分阶段实施计划
11. 风险与边界

---

## 1. 现状架构基线

### 1.1 分层与文件

```
┌ UI 面板（MusicExplorer / PlayerBar / LyricPage / NowPlayingPanel / PlaylistPanel / TrackInfoDialog …）
│   只消费「快照 + 命令」，不持有 <audio>、不拼直链
├ use-player-engine.ts  播放引擎：会话编排 + HTML5 transport（audioProps）
│   快照：picked/currentIndex/br/direct/fetching/playing/playError/currentTime/duration/volume/muted/loop
│   命令：playTrack/playPrev/playNext/togglePlay/seek/switchQuality/setVolume/setMuted/setLoop/resetSession
├ music-client.ts       源通道引擎：sourceEngineKindFor/Caps（gd|lx|self）、代理优先直连兜底、
│                       自研直连搜索分派 / netease·kuwo 自研为主、GD 搜索引擎兜底（会话标记）、
│                       下载与封面决策收敛（trackDownloadSpec/coverBinUrl）；UI 不得读 isDirectUsed 或手拼 URL
└ 服务端 routes
   /api/music        （provider=gd）    gdmusic.js  组装 GD 契约 types=url/search/pic/lyric，多基址 8s 预算回退
   /api/music/self   （自研直连，search/url）lib/self-search/（index/errors + netease/tencent/kugou/kuwo/migu 各一模块；kugou 官方试听直链在 kugou.js）
   /api/music/lx     （provider=lx）    lx-provider.js + lx-host.js（node:vm 沙箱执行社区脚本，脚本视为不可信）
   /api/music/resolve                  music-link.ts 纯函数识别 → 官方详情通道（netease-meta / qqmusic / kuwo-meta / kugou getSongInfo）
   /api/music/caps   平台能力矩阵下发  lib/music-platform-flags.js（后端真源，读 env）→ 前端 lib/music-caps.ts 拉取过滤
```

> 自研直连搜索（`/api/music/self`）的定位与价值：`tencent`/`kugou`/`migu` 是 GD 未开放搜索的**独立搜索源 chips**；`netease`/`kuwo` 双通道：搜索以本通道为主，自研失败才回退 GD 搜索引擎（会话置位后同源翻页直接走 GD）。搜索结果归一为 GD 搜索同契约 SearchItem（`line.kind=self`）；封面不强求——搜索响应能内嵌的图床 URL 写入 `picUrlDirect` 直接展示，**不做二次换取**。`tencent`/`netease`/`kuwo` 的 id 与 GD 直链通道所需 id 一致可复用；`kugou` 已内置官方免费试听直链（`action=url` → `getSongInfo`，免费档 128k mp3，VIP/付费曲取链失败返回 `failType=vip-only`，见 `src/lib/self-search/kugou.js`）；`migu` 仍无内置直链引擎（`sourceEngineKindFor → self`，`SELF_ONLY_ENGINE_KEYS`），默认只能搜索展示——若部署侧配置 lx 音源脚本并经 sources 目录 `urlFallbacks` 映射（默认 wy/tx/kw/kg/mg，可 `MUSIC_LX_URL_FALLBACKS` 增改），点播/切音质由 `requestPlayDirect` 自动改由音源脚本按同曲 id/hash 换链（见 §1.3 / §2 C8 修订）。

关键不变量（代码事实）：

- **UI 无状态请求、无直链拼装**：直链/封面/下载 URL 一律由 `music-client` 出口；服务端失败按 `kind` 分类，`proxy` 通道不可用才允许浏览器直连 GD 公共源，且一次成功会话内即记忆（`directUsed`）。
- **播放调度在前端**：`use-player-engine` 的 `playTrack(item, index)` 拿到 `SearchItem` 后走 `requestPlayDirect(source, item, br)`（music-client 播放统一取链入口：GD 主通道失败 / kugou 官方直链失败 / migu 无内置直链（`SELF_ONLY_ENGINE_KEYS`）时，按已加载音源脚本的 `urlFallbacks` 映射自动改走「lx 音源同曲换链」，见 §1.3 步骤 2），就绪后经 `canplay` 起播；切音质 `switchQuality` 同样走 `requestPlayDirect`，热切换“旧档不打断、新源 seek 续播”；自然 `ended` 后 `playNext`（队尾且有 `hasMore` 时先 `fetchMorePage` 再播新页第一首）。
- **后端是薄动作 API，不维护播放会话**：`/api/music` 只做「按 source+id+br 取直链 / 按词搜索 / pic / lyric」。增强不得改成后端持会话的长连接式设计。

### 1.2 数据模型与契约（对齐 music-client / API.md）

| 结构 | 关键字段 | 备注 |
|---|---|---|
| `SearchItem`（搜索与 resolve 归一产物） | `id / urlId / name / artist[] / album / source / picId / lyricId / picUrlDirect? / line?` | `urlId` 才是取直链用 ID；`line.kind` = `proxy\|direct\|self`（自研直连通道产物，仅带 `picUrlDirect` 时才有可直接展示封面，无 `picId` 二次换取语义） |
| `DirectData` | `url / br / size / source / id` | 直链带时效 token，**只可缓存 {source,id}，不可缓存 URL** |
| `ResolveData` | `status: "playable"\|"engine-missing"`、`platform / songId / metadata: "full"\|"fallback" / item?` | `playable` 后播放仍走 `requestDirect` |
| br 档位 | `128 / 192 / 320 / 740 / 999` | 前端默认 `BR_DEFAULT="320"`；后端 `action=url` 缺省 `999`——两处默认不一致，取直链必须显式传 br |
| 错误契约 | HTTP 400/404/502 + `failType` | `source-unavailable` / `not-found` / `sources-down` / `script-not-ready` / `script-error`；400 带参数说明 |

### 1.3 播放链路（现状时序）

1. 列表点击/链接解析成功 → `playTrack(item)`：置位 `picked/fetching`，`unlockAutoplay()`（用户手势内静音试播解锁）。
2. `requestPlayDirect(source, item, br)`（music-client 播放统一取链入口）：GD 源 → `/api/music`（代理 `kind=down` 才直连）；kugou（self 源，已内置直链）→ `/api/music/self?action=url`（官方 `getSongInfo`，免费档 128k mp3，VIP/付费曲取链失败）；migu（self 源，`SELF_ONLY_ENGINE_KEYS` 无内置直链）→ 已配置 `urlFallbacks` 兜底映射（且脚本注册对应 source）则直接走音源换链，否则抛 `NO_ENGINE_MSG`（见 §8「仅 migu」分支）；lx 源 → `/api/music/lx?action=url`。GD / kugou / migu 主通道失败时自动试「lx 音源同曲换链」兜底（lx 源自身除外）；音源兜底失败静默，沿用主通道错误信息。
3. 成功 `setDirect(data)` → `<audio src>` 资源 `canplay` 后 `play()`（被自动播放策略拦截时静音起播再还原用户音量设置）。
4. 失败仅 `setPlayError(msg)` 展示，**当前无自动换源**；队列续播只由 `ended` 驱动。
5. 封面走 `requestPic`（picId→URL，代理可用时 `coverBinUrl` 同源取色）；下载由 `trackDownloadSpec` 决策 `bin`（同源字节代理、文件名带音质标签）或 `external`。

---

## 2. 现状约束清单（增强设计的地基）

> ⚠️ **2026-09 变更：平台「搜索引擎」与「播放引擎」改为部署可配开关（双层能力矩阵）**——tencent（QQ音乐）代码与注册**完整保留**，仅**默认停用**；开关关闭 = UI 不展示 + 后端拒绝动作，恢复/关闭无需再改代码：
>
> - **真源与下发**：后端唯一真源 `src/lib/music-platform-flags.js`（读 env、动态生效）；前端默认矩阵与后端同值源（`src/lib/music-caps.ts`），挂载时拉 `/api/music/caps` 覆盖为“生效矩阵”（未拉到前按默认过滤，防首帧闪烁）。
> - **开关模型**：面向用户的 6 平台（netease/tencent/kugou/kuwo/migu/joox）各含二维开关 `search`（搜索引擎）/ `play`（播放引擎 = 取直链通道）。默认值：`MUSIC_PLATFORM_SEARCH` 仅停 tencent、其余开启；`MUSIC_PLATFORM_PLAY` 仅开 netease/kuwo/kugou/joox、停 tencent/migu——kugou 为内置官方免费试听直链（免费档 128k mp3，VIP/付费曲取链失败 `vip-only`），migu 无内置直链（`SELF_ONLY_ENGINE_KEYS`），可经已配置 lx 脚本 `urlFallbacks` 兜底。
> - **关闭表现**：`search` 关 → 前端不展示该源 chip / 聚合候选（`MusicExplorer` 过滤 `SELF_SEARCH_SOURCES` + `buildSearchChips`），后端 `action=search` 与 `/api/music/self` 拒绝并 400 `source-unavailable`（文案含“可配置 MUSIC_PLATFORM_SEARCH 开启”）；`play` 关 → `/api/music?action=url` 拒绝取链、`/api/music/resolve` 识别成功但返回 `engine-missing`（文案含 `MUSIC_PLATFORM_PLAY`）。
> - **语义边界**：仅“面向用户的 6 平台”受开关约束；lx 脚本扩展源、GD-only 源不在全集内，恒视为启用（避免误伤）；lx `urlFallbacks` 兜底是独立“播放通道”，不随平台 `play` 开关收敛。歌词/封面/pic 等数据通道不受开关影响，resolve 的歌曲识别与官方详情元数据同理不受影响。
> - 下文凡提及 tencent 为“独立搜索源 chips / 可搜可播集合”之处，均指**开关放开后的启用态**；默认部署下等价于停用态（后端 `enabledPlatformList` / 前端 `getPlatformCaps` 为唯一口径）。

以下限制来自已落地上游契约，**任何增强方案都不得假设这些约束不存在**：

| # | 约束 | 影响 |
|---|---|---|
| C1 | GD `action=search` 只开放 `netease / kuwo / joox`，其余 source（含 `tencent`）返回 400 | 「自动跨源搜同名」只能在**可搜索源集合**（GD 三源 + lx `searchSources`）内发生 |
| C2 | GD search 响应字段无时长，`SearchItem` 未透传 duration | 原方案“时长 20 分、差 >15s 淘汰”在**解析失败降级段无法计算**，见 §6 两段式 |
| C3 | lx 源取决于部署侧 `MUSIC_LX_SCRIPTS`，无浏览器直连兜底、错误原样透传 | lx 候选失败只能提示，不能静默跳过 |
| C4 | `resolve` 识别与官方详情 ready：netease/tencent/kuwo/kugou（kugou 走官方 `getSongInfo` 详情并直接返回可播曲目）。（2026-09 起 tencent 播放引擎默认停用，未放开 `MUSIC_PLATFORM_PLAY` 时 QQ 链接识别成功亦回 `engine-missing`，放开后恢复 `playable`） | 官方高置信候选覆盖面有限，QQ 候选是否可播随开关收敛 |
| C5 | 直链均带时效，`requestDirect` 每次现取 | 任何“缓存可用歌曲”都只是缓存 **候选 ID** |
| C6 | 部署形态三选一：Docker standalone（当前线上，进程内存单实例）/ Vercel / CF Workers(OpenNext) | 缓存载体需按部署选型，见 §7 |
| C7 | 播放态失败（403/404/410/CORS/超时）发生在 `audio` 元素层，`use-player-engine` transport 当前未上送 `onError` | 需要补 transport 事件，失败才能进入换源闭环 |
| C8 | 自研直连搜索通道（`/api/music/self`）可搜 netease/tencent/kugou/kuwo/migu：tencent/kugou/migu 为独立搜索源 chips（GD 无其搜索），netease/kuwo 双通道：本通道为主，自研失败才回退 GD 搜索引擎。kugou 已内置官方免费试听直链（`/api/music/self?action=url` → `getSongInfo`，免费档 128k mp3，VIP/付费曲取链失败 `failType=vip-only`）；migu 仍**无内置直链引擎**（`SELF_ONLY_ENGINE_KEYS`，`sourceEngineKindFor → self`），默认只能搜索展示（封面/歌词等数据通道抛明确 biz 提示）；配置 lx 音源兜底映射（sources 目录 `urlFallbacks`，默认 wy/tx/kw/kg/mg）后点播/切音质改由音源脚本同曲换链 | 换源候选只收录**可播放**的源（netease/kuwo/tencent/joox/kugou + lx 目录，随 search+play 开关收敛），migu 即便搜到同名也不进自动候选（kugou 默认即候选）；引擎对 migu（`SELF_ONLY_ENGINE_KEYS`）仅在「无 urlFallbacks 命中」时跳过自动换源闭环（确定性失败避免空转），有兜底映射时先试音源换链、失败后再进候选遍历；kugou 直链失败属业务性（VIP/下架/网络），正常进入候选遍历 |

---

## 3. 增强目标与不变式

价值主张延续 v1，并显式声明以下不变式：

1. **ID 优先播放**：所有入口（搜索、resolve、候选）最终都归结为 `{source, id/urlId}`；直链永远最后一步现取。
2. **懒降级 + 半自动换源**：仅在**当前候选失败**时才寻找同歌候选；**禁止静默换低匹配歌曲**（防错歌安全阀）。
3. **自动候选只信高置信**：≥阈值才自动重试；低置信一律交人工；无候选给可操作的原因与建议。
4. **决策层保持前端**：候选遍历、打分选择由前端引擎/纯函数驱动（可单测），后端只新增无状态动作接口。
5. **不破坏现有单一数据流**：搜索结果列表仍按“源”分组展示，候选池只作为“失败后找替代品”的次级数据，不混入主列表。

---

## 4. 播放失败闭环（核心修订）

### 4.1 两个失败来源（必须同时接入）

| 失败来源 | 判定位置 | 现有处理 | 增强动作 |
|---|---|---|---|
| `resolve-fail` 解析失败 | `requestDirect` 抛错（`MusicError` kind + `failType`） | `playError` 提示 | 按 §6.1 分类记黑名单 → 取下一候选 |
| `play-fail` 播放态失败 | `<audio>` `error` 事件 / `fetch` 直链 HTTP 403/404/410/超时 / `MediaError` code | **未接入** | transport 增加 `onError` 上送（`use-player-engine` 的 `audioProps` 补 `onError`，合入 `playError`），并作为候选遍历触发源 |

**修订理由**：多源聚合最常碰到的其实是“URL 拿到了但 `<audio>` 一播就挂”（防盗链、token 即时失效、地区限制），只处理解析失败等于漏掉主战场。引擎对外快照/命令接口不变，仅在 transport 区块扩展 `onError` 一个回调，符合「快照+命令」界面稳定原则。

### 4.2 换源循环（前端驱动，单轮有界）

```
CURRENT(source,id,br)
  ├─ resolve-fail / play-fail（且失败类别允许换源）
  │     → 记源黑名单 → 取同歌下一候选（来源见 §5）
  │         ├─ auto(≥阈值) → 直接 requestDirect 重试
  │         ├─ manual(阈值内) → 停下来，弹 select 面板交人工（§8）
  │         └─ 无候选 → 返回 fail + 原因；写降级负缓存（§7）
  └─ 成功 → 记录候选缓存（写入条件见 §7）
```

轮次上界：**一次失败最多 1 轮 suggest**；每轮内解析尝试 ≤4 个候选；单个 URL 请求最多重试 1 次（间隔 300–500ms）；同 `source+id` 在失败黑名单 TTL 内不再重试。目标：单轮自动换源对第三方的请求上界 = 1 次 suggest（≈ 搜索源数 × 1 个 search，串行或并发上限 2）+ ≤4 次 `url`。

### 4.3 失败类别 × 重试策略（分级）

| failType / 现象 | 归类 | 重试策略 |
|---|---|---|
| `sources-down` / `script-not-ready` / 代理 5xx | 瞬时通道故障 | 本候选取消，全轮重试前退避（指数，上限 30min） |
| `script-error` / 上游超时 | 解析器瞬时异常 | 退避 2min 后可再试 |
| `not-found` / `source-unavailable` / “无版权/无音源” | 源级确定失败 | **不再自动重试该 `source+id`**，长记（歌曲级黑名单） |
| `play-fail` 403/404/410 | 直链失效（token/防盗链） | 该候选降权；同一 {source,id} 记短期黑名单（因为重取 URL 可能拿到新 token） |
| 参数类 400（source/br 非法） | 配置错误 | 直接 human，不消耗候选 |

---

## 5. 候选池的落地边界

候选池 = 与当前曲目“同歌”的 `{source, id, 元数据指纹}` 列表，按来源与置信排列。**候选只从以下四类来源产生**，不对任意平台凭空改名搜索：

| 来源 | 说明 | 置信基准 | 成本 |
|---|---|---|---|
| A 队列内近似 | 当前 keyword 搜索结果列表里经清洗标题+歌手比对出的同歌不同版本条目 | 文本可证，多数可直接 auto | 0（已持有） |
| B 可搜索源现搜 | 在「可搜可播源（netease/kuwo/tencent/kugou/joox：netease·kuwo 自研为主 GD 兜底、tencent/kugou 自研、joox 仅 GD；kugou 已内置官方直链默认即候选、migu 无直链引擎仅展示并剔除）+ lx searchSources」内，以清洗后歌名+主歌手逐源 search 第 1 页（count=20，分派与列表搜索一致：self-first / GD-fallback），打分过滤后并入 | §6 打分，≥75 才 auto | 每源 1 次 search，必须串行或 ≤2 并发 |
| C 会话内已 resolve 曲目 | 本会话粘贴链接解析出的官方曲目（netease/tencent/kuwo，`metadata=full`） | 官方详情高置信 | 0（会话内） |
| D 历史播放成功缓存 | 本曲“真实播放成功”过的候选（见 §7 层①） | 曾真实可播 | 0 |

约束映射（对照 §2/C8）：netease/kuwo/tencent/kugou/joox 均可搜可播（netease·kuwo 走 self-first / GD-fallback，kugou 走内置官方直链），migu 借自研通道可搜但 **无直链引擎**（`SELF_ONLY_ENGINE_KEYS`），B 只收录可播放源（netease/kuwo/tencent/kugou/joox）；lx 扩展或 resolve 过的官方曲目仍进 B/C。

规则：

- 候选条目统一带 `provenance`（`list|multi-search|resolve|cache`）与打分，供 UI 展示来源标签。
- **专辑不同即视为不同版本**：B 里与当前曲目专辑不同（且当前/候选专辑均非空）的同名曲，不得 auto，降级为 manual（防“同名串歌”，也让缓存不串版本）。
- 主列表不动：候选数据与主搜索列表分开存（如引擎新增 `alternatives` 快照），避免污染既有选择/队列语义。

---

## 6. 相似度匹配规则 v2（防错歌）

### 6.1 文本清洗（沿用 v1 并增补）

剔除歌名括号/方括号内版本标记（保留“标题(ft.xx)”等主标题），移除版本词黑名单（`伴奏/纯音乐/翻唱/翻奏/现场版/Live/Remix/Demo/KTV/cover` 等，词表可配置扩展）；歌手名规范化（去 `feat./ft.` 段、统一 `&`/`and`/全半角与大小写，预留别名表挂载点）。

### 6.2 打分（两段式——修正 v1 的时长盲点）

| 维度 | 权重 | 说明（修订） |
|---|---|---|
| 歌手匹配 | 40 | 拆分歌手数组两两比对取 best-match 再平均；只比较规范化后的名字，容编辑距离（如 1） |
| 歌名匹配 | 30 | 用清洗后标题；相等满分，包含/编辑距离递减 |
| 专辑匹配 | 10 | 一致加分；不一致**不淘汰**（平台专辑命名差异），但触发 §5 的 manual 规则 |
| 时长匹配 | 20 | **仅在“具备高可信时长”时启用**：官方详情（resolve C 类）或本曲真实播放已获得 duration。差值 ≤25s 内按接近给分，>25s 直接淘汰；时长缺失给中性分 0 并**不**把该维度分母计入（即按可得维度归一） |

**两段语义**：
- 第一段（解析失败降级，B/A 类，通常无时长）：只算歌手+歌名+专辑 = 满分 80，按比例归一到 100 与阈值比较。
- 第二段（播放态失败再降级，C/D 类或已真实播过旧版本）：此时本曲真实 duration 已知，才启用时长硬校验——这也是 GD search 无 duration 约束（C2）下的正确解法：**真实播放时长是本歌 ground truth，绝不拿“另一版本录音的猜测时长”去误杀**。

### 6.3 阈值与输出

- `≥75`：高匹配，可 auto 尝试（需过 §5 专辑不同 → manual 例外）。
- `60–74`：低匹配，禁止自动，弹 select 面板人工选择。
- `<60`：丢弃。
- 个人使用不建议把 auto 阈值降到 <70。

---

## 7. 缓存体系 v2

### 7.1 缓存分层

| 层 | Key | Value | TTL | 写回条件 |
|---|---|---|---|---|
| ① 可用候选缓存 | `normalize(清洗标题) + sortedArtists`（utf-8 原文保留于 value） | 按可用优先级排序的 `[{source,id, album?, provenance}]` | 7 天 | **仅“真实播放成功”或“人工确认过”**才写；仅解析成功无播放证据只记临时半可信（低优先，不排前） |
| ② 搜索结果缓存 | keyword+source+page | 搜索页 | 30–60s | 每页成功后写 |
| ③ 降级负缓存 | 同层① key | “最近已降级/无合格候选”标记 + 时间 | 5–10min | 降级轮以 fail/manual 结束且无缓存命中时写 |
| ④ 失败黑名单 | `source+id`（或歌曲级） | 失败类别 + 时间戳 | **分级**：瞬时 2min / `sources-down`·`script-*` 指数退避 cap 30min / `not-found`·无版权歌曲级长期 | 对应失败发生时 |
| ⑤ 详情/脚本缓存（已有） | resolve 官方详情 / lx 脚本 | 元数据 / 脚本本体 | 详情 5min / lx 脚本 6h（`MUSIC_LX_SCRIPT_TTL_MS`） | 维持现状 |

作用链：层③ 防止“烂歌”反复触发整轮 suggest（负缓存挡住的是搜索成本，层④ 只挡解析成本）；层① 让熟歌秒起且不发 suggest。

### 7.2 载体选型（对照部署形态 C6）

- 进程内 Map（现 `api-utils` 缓存同思路）：开发环境与 **Docker 单实例**默认可用，层②③④天然满足。
- 层①在单实例下进程内即可；多实例（Vercel/CF）需跨实例共享时才引入外部载体：
  - Cloudflare Workers → `Cache API` / KV（项目已有 `result-cache.js` 先例）；
  - Vercel → Upstash/自管 Redis（可选）。
- **不要在代码里写死某个 Redis 客户端依赖**：抽象成与现有缓存一致的 `get/set/ttl` 接口，按部署注入实现。
- 不变：层④与层①的歌曲级标记在单实例里只存内存，重启可接受。

### 7.3 关键一致性规则

- 直链 URL 永不进任何缓存层（token 时效）。
- 缓存候选在遍历时如果排在首位的“历史成功”再次解析失败 → 当场降权/剔除并触发黑名单，不能让坏候选反复占满 4 个尝试额度。
- 层①写入前过一遍 §6 归一化，防同一歌手数组乱序造成多份 key。

---

## 8. 前端交互（现状 + 增强）

现状（已实现）：

- 搜歌点列表 → `playTrack`；失败给 `playError`；封面临时占位取色；自然播完自动续播下一页。
- 自研直连搜索源 chips（tencent/kugou/migu）与双通道源 netease/kuwo 的自研主通道：搜索列表带 `line.kind=self` 徽标（「自研直搜」）；封面不强求——搜索结果内嵌 `picUrlDirect` 直接展示、无则占位，**不上传二次封面换取**。
- migu「仅搜索展示」（`SELF_ONLY_ENGINE_KEYS`）：点播 / 封面 / 歌词直接抛明确 biz 提示（`NO_ENGINE_MSG` 等，渲染进 `playError`），引擎对 migu 在「无 urlFallbacks 命中」时**跳过自动换源闭环**（确定性失败，同队列候选也必同为该源，空转无意义）；kugou 已内置官方免费试听直链，点播直接可播（免费档 128k；VIP/付费曲失败 `vip-only`），封面/歌词等数据通道仍抛 biz 提示。
- **聚合搜索**：SearchPanel chips 行首「聚合搜索」伪 chip（`aggActive`，不占 `source`）。`music-client.searchAcrossSources`（平台级限流闸 ≤3 路并发，即使多次触发叠加同一时刻也不超 3 路；逐源失败隔离）拉全部可用源第 1 页 → `src/lib/music-match.ts`（纯函数，文本清洗/关键词相关度打分/`isSameSong` 同曲判定）跨源去重（同分取「可播副本」优先：GD > lx/kugou > migu 仅展示）→ 相关度降序（打分只取决于关键词与歌曲内容，排序不掺平台/引擎顺序）截断 80 条混合展示。规则与播放失败自动换源共用（引擎内 `cleanMusicText`/`musicKey` 已收敛到该模块）；聚合列表无翻页、不落播放快照，部分源失败在列表尾 `pageErr` 提示、全部失败给空态原因。

增强后（仅增加分支，不改变既有状态）：

1. 点歌/解析成功 → 引擎照常 requestDirect + transport 起播（不变）。
2. `resolve-fail`/`play-fail` 且候选可自动 → 播放条/面板出现**轻量进行态**：“正在尝试 网易云 → 酷我”，期间可取消（AbortController 已具备）。
3. 触达 manual（60–74 或专辑不同版本）→ 弹 `select` 候选面板：每项展示 来源徽标 + 歌名 + 歌手 + 专辑 + 来源类型（搜索/历史可播/链接解析）+ 置信，按钮“就播这版”与“仅此一次 / 以后记住”。选中后立即 `playTrack(candidate)`（成功则按 §7.1 层①决定是否写入）。
4. 无候选 → 展示**最终原因**（哪一源、何种失败类别、是否被源黑名单）与建议动作（换源搜索 / 粘贴 QQ/酷我分享链接 resolve——C 类是 GD 不可搜索源的正规补充入口）。

所有面板仍然只消费引擎“快照+命令”，新候选状态以 `alternatives` 快照 + `reportPlaybackFailure` 命令形式挂在引擎界面上。

---

## 9. 性能与调优方向

- **请求预算表**：单次自动换源轮次对第三方请求上界见 §4.2；负缓存层③保证重复失败不重复花钱。
- **源顺序**：缓存候选（层①）→ 会话内 resolve（C）→ 当前搜索列表近似（A，0 成本）→ B 现搜；每源 1 页、串行或 ≤2 并发。
- **匹配精度**：版本词黑名单做成配置表；阈值个人使用不低于 70；专辑冲突走 manual 而非降阈。
- **可观测**：候选换源全程埋点——`prov`（A/B/C/D）、尝试 source、阶段（resolve/play）、耗时、结果（success/manual/fail），用于日志定位失效源（哪些 source 最近一直 play-fail，应降权/剔除）。
- 新打分纯函数与清洗规则必须**可脱离 DOM 单测**（放 `src/lib/music-match.ts` 之类共享位置，前后端皆可用）。

---

## 10. 分阶段实施计划

> v1 原文把“搜索引擎适配器/播放调度在服务端一个 get-play-url”当作起点——与本项目已落地的“前端驱动 + 薄后端动作 API”不符，废弃该假设。以下计划从**现状代码**出发。

- **P0（已落地）**：四入口 + gd/self/lx 三通道（含自研直连搜索 chips tencent/kugou/migu 与 netease/kuwo 双通道：自研为主、GD 搜索兜底）+ resolve 归一曲目 + `use-player-engine` 快照/命令解耦 + 代理/直连降级 + bin 下载/封面收敛。对照 §1。
- **P1｜最小闭环（纯前端）**：transport 补 `onError` 上送（§4.1）；候选来源 A（队列近似，0 成本）接入换源循环；`alternatives` 快照 + manual select 基础 UI。
  - ✅ 已落地（引擎层，`use-player-engine.ts`，不触碰 UI）：`audioProps.onError` 上送（`play` 阶段失败）；`resolve`/`play` 双失败闭环，token 化有界（`MAX_AUTO_ALT_ATTEMPTS`）自动换源队列内近似高置信候选；`failStage` / `alternatives` / `autoTrying` 快照暴露。
  - ✅ 已落地（UI 层）：`MusicExplorer.tsx` 消费 `failStage` / `alternatives` / `autoTrying`——`autoTrying` 期间播放条上方轻量进行态 pill（“播放失败，正在自动尝试同曲其他版本…”）；失败收尾且队列内仍有未尝试同曲候选时自动弹出 `AltSelectDialog` 人工选版面板（逐行展示 来源徽标 + 歌名 + 歌手 + 专辑，整行点击即 `playTrack` 重走闭环；Esc / 遮罩 / X 关闭，关闭记忆 `altDismissed` 随换歌复位）。引擎侧配套：候选快照仅保留本轮尚未自动尝试的版本、任一候选播放就绪即清空快照（防陈旧候选在后续音质档失败时误弹）；自动尝试的“取消”= 手动切歌（token 失效），pill 内未做独立取消按钮。
- **P2｜跨源现搜**（已落地：来源 B 自动兜底；未落地：层③④负缓存、§6 两段式时长校验）：
  - 来源 B 自动兜底：队列内已无自动候选可试时，一次失败至多跑 **1 轮现搜**——拿原曲在「可搜可播源（netease/kuwo/joox + tencent + kugou + lx searchSources，剔除失败源自身与无直链的 migu）」现搜第 1 页，由 `music-match.ts` 的 `rankSongMatchCandidates` 打分收敛：≥75 且专辑一致 → 自动接续尝试（A 耗尽后才动用）；60-74 或专辑冲突 → 人工候选。
  - 预算/并发：单轮直链尝试预算由 2 上调到 ≤4（来源 A 队列候选 + 来源 B 现搜候选共用 `MAX_AUTO_ALT_ATTEMPTS`）；跨源现搜复用聚合闸（≤3 并发）、切歌/重置即中止（轮次 token + AbortController），现搜网络异常静默降级不阻塞闭环。
  - UI：pill 动态文案（`altNote`，跨源现搜阶段提示“正在跨音源现搜…”）；`AltSelectDialog` 跨源条目带“现搜”徽标与置信注角；面板可点“现搜”回条目（不在队列时走 index=-1 直接播放）。
  - 未落地：层③④ 负缓存/黑名单（重复失败不再跨源重搜、专辑名歌手级停用）；层① 歌手热歌缓存；§6 时长维度校验；候选来源 C（解析产物/会话内 resolve）。
- **P3｜记忆与编排**：`/api/music/suggest` 服务端动作（输入归一曲目元数据 → 返回可搜索源候选 B 结果，无状态，复用现有 search 与限流）；层①可用候选缓存 + 写入规则；多实例缓存载体按部署选型接入。
- **P4｜可选增强**：播放成功/失败统计与源健康度排序；lx 源质量收敛；失效源自动降权。

P1–P3 各阶段结束时跑 `npm run lint`、`npm test`，并同步 CLAUDE.md/API.md。

---

## 11. 风险与边界

- **上游契约漂移**：GD search 源名单与字段可能变化（搜索源缩到少于两家时 B 来源退化）；现有多基址 8s 预算机制对超时兜底，但“可搜索源变少”要能自动降级为 manual。
- **误判成本**：宁 manual 勿 auto——放错歌对音乐工具是致命体验；auto 前置条件：清洗一致 + 歌手一致 + 专辑不冲突（或专辑缺失）。
- **请求打扰**：跨源现搜天然放大对第三方的请求；严格遵守 §4.2 轮次上界与层③负缓存，不无限搜索。
- **lx 沙箱负载**：B 来源如果含多个 lx 源，搜索任务在 Node 侧并发执行，需复用现有并发上限，勿把 suggest 做成 for 全量源。
- **SSRF/开放代理**：任何新增中转/代理端点（suggest 本身只出 ID 不拉字节，无需代理；若未来需字节代理复用 `/api/music` `bin=1` 白名单语义）都不得接受任意 URL。
- **合规**：个人学习研究用途，禁止商用；不向第三方源做批量抓取，人工触发为主。
- 本文档是模块设计说明，不替代 `API.md`（对外契约）与 `CLAUDE.md`（目录/环境变量），实施落地后三处需保持同步。
