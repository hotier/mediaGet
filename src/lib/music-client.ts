/**
 * 音乐解析播放器页 —— 搜索/直链/封面 客户端请求层
 *
 * 多通道请求：
 * 1. GD 聚合上游（同源代理优先 + 浏览器直连降级）：
 *    a. 同源代理 GET /api/music（服务端进程缓存 / IP 限流 / 统一 {code,msg,data} 契约，
 *       route 见 src/app/api/music/route.js）。
 *    b. 上游直连（降级）：https://music-api.gdstudio.xyz/api.php（已开 CORS *）。公共上游对
 *       Vercel / 云厂商这类数据中心出口会回 CF 风控（403 / 校验页），但对普通民用出口友好；
 *       因此当代理通道判定为「上游对部署出口不可用」（code 502 / sources-down）而非真实业务
 *       错误（400 / 404 / 429）时，浏览器端改用上游直连兜底。直连成功一次后本会话即进入直连
 *       模式（isDirectUsed），后续请求跳过代理，避免每次都先空转一次 502。
 * 2. 自研直连搜索（服务器直连各音源搜索接口，不经 GD）：GET /api/music/self?action=search
 *    （对应 src/lib/self-search/* + src/app/api/music/self/route.js）。
 *    分派语义：
 *    - 独立搜索源 chips：tencent / kugou / migu 仅自研（GD 未开放其搜索）；
 *    - 双通道源（netease / kuwo）：**自研直连搜索为主**，GD 搜索引擎仅作兜底——自研通道
 *      失败时回退 GD（同源代理 → 浏览器直连），会话内该源后续直接走 GD，不再每次空转自研。
 *    平台「搜索引擎 / 播放引擎」为可配置开关（MUSIC_PLATFORM_SEARCH / MUSIC_PLATFORM_PLAY，
 *    见 music-platform-flags.js）：tencent 默认关（可播直链无稳定来源）——chips 是否展示、
 *    跨源现搜候选等由 music-caps 生效矩阵过滤；直链 / 歌词 / 封面通道能力不随本开关移除。
 *    kuwo / netease / tencent 的自研搜索结果可复用既有 GD 直链 / 歌词 / 封面通道；
 *    kugou 内置官方试听直链（/api/music/self?action=url，免费档 128k mp3，VIP/付费曲
 *    返回 failType=vip-only）；migu 自研搜索无内置直链——若配置了对应 lx 音源脚本
 *    （sources 目录 urlFallbacks 映射，见 lx-provider.js MUSIC_LX_URL_FALLBACKS），
 *    点播/切音质时会自动改由音源脚本按同曲 id/hash/songmid 换直链（见 requestPlayDirect）。
 * 3. 洛雪(lx-music)扩展音源：同源 /api/music/lx（脚本仅在 Node 侧沙箱执行，无直连兜底）。
 *
 * 注意：浏览器直连没有服务端缓存 / 限流兜底，且仅对民用出口可用；数据契约解析与本文件上游
 * 协议均对齐 src/lib/gdmusic.js（服务端解析仍以该文件为准，本文件仅保留浏览器端所需的最小解析）。
 */
import {
  BR_OPTIONS,
  SEARCH_SOURCES,
  SELF_SEARCH_SOURCES,
  type SearchSourceKey,
} from "@/components/music/types";
import {
  isPlatformPlayOn,
  isPlatformSearchOn,
} from "@/lib/music-caps";

/** 搜索结果默认每页条数（对齐服务端 gdmusic.js 的 GD_SEARCH_COUNT_DEFAULT=20） */
export const PAGE_SIZE = 20;

/** 上游公共实例（与 gdmusic.js 未配置 MUSIC_API_BASE 时的默认值同址） */
const DIRECT_BASE = "https://music-api.gdstudio.xyz/api.php";

/** GD 音乐台公共实例 host：代理默认基址与直连降级目标都可能指向它，列表标注时按此归名为「GD 公共源」 */
export const GD_PUBLIC_HOST = "music-api.gdstudio.xyz";

/** 上游搜索页码上限（对齐 gdmusic.js 的 GD_SEARCH_PAGE_MAX） */
const DIRECT_PAGE_MAX = 20;

/** 上游对非浏览器出口偶回 CF 校验页标记（对齐 route.js 的 CF_CHALLENGE_MARKERS） */
const CF_CHALLENGE_MARKERS = [
  "__cf_chl",
  "cf_chl_opt",
  "Just a moment",
  "Enable JavaScript and cookies to continue",
];

/** 会话内：是否已判定「同源代理不可用」并切到上游直连模式 */
let directUsed = false;
export function isDirectUsed(): boolean {
  return directUsed;
}

/** 会话内：已判定「自研搜索不可用」而转用 GD 搜索兜底的源集合（netease/kuwo）。
 *  命中后这些源的后续搜索（含翻页）直接走 GD 通道，不再每次空转一遍 /api/music/self。 */
const gdFallbackSearchSources = new Set<string>();

export function resetDirectUsed(): void {
  directUsed = false;
  gdFallbackSearchSources.clear();
}

export interface MusicLine {
  /** proxy = 经同源代理 /api/music 命中上游；direct = 代理不可用时浏览器直连上游；
   *  self = 站点自研通道直连各音源搜索接口（不经 GD 上游，/api/music/self） */
  kind: "proxy" | "direct" | "self";
  /** 取回本页结果的上游基址（如 https://music-api.gdstudio.xyz/api.php；self 线路为固定标记） */
  base: string;
}

export interface SearchItem {
  id: string;
  urlId: string;
  name: string;
  artist: string[];
  album: string;
  source: string;
  /** 专辑封面 pic_id，需经 action=pic 二次换取真实图片 URL */
  picId?: string;
  /** 歌词 id，用于 action=lyric 获取歌词 */
  lyricId?: string;
  /** 图床直链封面（链接解析产物可用；存在时优先直接展示，跳过 GD pic 换取） */
  picUrlDirect?: string;
  /** 该条结果经由哪条线路（通道 + 上游基址）取回；逐页请求各自标注，多页列表可能不同 */
  line?: MusicLine;
}

/** /api/music?action=search 返回的 data 契约（后端提供 page/hasMore 供逐页拉取） */
export interface SearchData {
  source: string;
  keyword: string;
  page?: number;
  hasMore?: boolean;
  count?: number;
  items: SearchItem[];
  /** 本页结果取回线路；同源代理由后端上报命中的上游基址，直连通道由前端自标 */
  line?: MusicLine;
}

export interface DirectData {
  url: string;
  br: number;
  size: number;
  source: string;
  id: string;
}

export interface PicData {
  url: string;
}

export interface LyricData {
  lyric: string;
}

// —— 洛雪(lx-music)生态音源脚本 Provider（扩展音源）——
// 部署侧配置 MUSIC_LX_SCRIPTS（见 src/lib/lx-provider.js）且脚本可用时，同源
// /api/music/lx 会返回扩展源目录。浏览器端据此把「内置 GD 源之外」的扩展源 key
// 识别为 lx 源：搜索 / 直链 / 歌词请求改发 /api/music/lx（音源脚本只能在 Node 侧
// 沙箱执行，故 lx 源没有 GD 那样的浏览器直连兜底，错误信息原样透传给用户）。

/** /api/music/lx?action=sources 返回的单条可搜索扩展源 */
export interface LxSearchSource {
  key: string;
  label: string;
  qualitys?: string[];
  scriptId?: string;
}

/** 内置平台 → lx 音源 source key 的取直链兜底映射项（服务端按已加载脚本解析） */
export interface LxUrlFallback {
  platform: string;
  source: string;
}

/** /api/music/lx?action=sources 返回的完整目录 */
export interface LxCatalogData {
  enabled: boolean;
  scripts: Array<{
    id: string;
    url?: string;
    name?: string;
    description?: string;
    version?: string;
    state?: string;
    ok?: boolean;
    error?: string | null;
  }>;
  searchSources: LxSearchSource[];
  allSourceKeys: string[];
  /** 内置平台曲目取直链失败时的 lx 音源兜底映射（仅含已注册带 musicUrl 的 source） */
  urlFallbacks?: LxUrlFallback[];
}

/** 内置 GD 源 key：无论 lx 脚本是否声明同名源，内置源都优先，避免扩展源抢占主链路。
 *  注意渠道细节：netease/kuwo 的搜索现以自研为主（GD 引擎兜底），joox 搜索仅 GD。 */
const GD_BUILTIN_SOURCE_KEYS = SEARCH_SOURCES.map((s) => s.key);

/** 内置自研直连搜索源 key 全集（tencent/kugou/migu；平台开关关闭时的过滤在 UI chips 层，
 *  见 music-caps.ts——全集保留、展示按 MUSIC_PLATFORM_SEARCH 生效矩阵收敛） */
export const SELF_SEARCH_CHIP_KEYS = SELF_SEARCH_SOURCES.map((s) => s.key);

/** 自研直连搜索白名单全集（netease/kuwo/tencent/kugou/migu；与 src/lib/self-search/index.js
 *  注册表一致；实际可搜 = 全集 ∩ 平台搜索引擎开关） */
export const SELF_SEARCH_KEYS = new Set([
  ...GD_BUILTIN_SOURCE_KEYS.filter((k) => k !== "joox"),
  ...SELF_SEARCH_CHIP_KEYS,
]);

/** 双通道搜索源（netease/kuwo）：自研直连搜索为主、GD 搜索引擎作兜底（自研通道失败才走 GD） */
const GD_FALLBACK_SEARCH_KEYS = new Set(["netease", "kuwo"]);

/** 自研直连源中仍未接内置取直链的子集（仅 migu；kugou 已内置官方试听直链）。
 *  这些源没有本服务直链路径，只能依赖已配置的 lx 音源脚本兜底（urlFallbacks）。 */
export const SELF_ONLY_ENGINE_KEYS = new Set(["migu"]);

/** 引擎通道 = 自研直连（/api/music/self，无 GD/lx/浏览器直连概念）的源：
 *  kugou 用官方试听直链，migu 无内置直链（见 SELF_ONLY_ENGINE_KEYS）。
 *  自研双通道源 netease/kuwo 与 tencent（历史曲目走 GD）的引擎通道仍是 gd，不在此列。 */
export const SELF_CHANNEL_SOURCE_KEYS = new Set(["kugou", "migu"]);

/** 无论 lx 脚本是否声明同名源都算内置（GD 或自研直连）的 key，扩展源目录需剔除它们 */
const BUILTIN_SOURCE_KEYS = [...GD_BUILTIN_SOURCE_KEYS, ...SELF_SEARCH_CHIP_KEYS];

/** 目录的进程内缓存（同一会话只拉一次；音乐页挂在主请求的独立入口） */
let lxCatalogCache: LxCatalogData | null = null;
let lxCatalogInflight: Promise<LxCatalogData> | null = null;

export function lxCatalogSnapshot(): LxCatalogData | null {
  return lxCatalogCache;
}

/** 仅供测试：清空目录缓存，便于重新拉取 */
export function resetLxCatalogCache(): void {
  lxCatalogCache = null;
}

/** 仅供测试：直接写入目录缓存，省去 mock 网络往返 */
export function setLxCatalogCacheForTest(data: LxCatalogData | null): void {
  lxCatalogCache = data;
}

/** 拉取 lx 扩展源目录（失败可重试，成功后本会话不再重复请求） */
export async function fetchLxCatalog(
  signal?: AbortSignal
): Promise<LxCatalogData> {
  if (lxCatalogCache) return lxCatalogCache;
  if (lxCatalogInflight) return lxCatalogInflight;
  lxCatalogInflight = (async () => {
    try {
      const payload = await proxyGet(
        new URLSearchParams({ action: "sources" }),
        signal,
        "/api/music/lx"
      );
      const data = payload.data as LxCatalogData | undefined;
      if (
        !data ||
        !Array.isArray(data.searchSources) ||
        !Array.isArray(data.scripts)
      ) {
        throw new MusicError("biz", "扩展音源目录返回异常");
      }
      lxCatalogCache = data;
      return data;
    } finally {
      lxCatalogInflight = null;
    }
  })();
  return lxCatalogInflight;
}

/** 该 source key 是否由 lx 脚本提供（目录加载后生效；内置 GD / 自研直连源永远不算） */
export function isLxSourceKey(sourceKey: string): boolean {
  if (!lxCatalogCache || BUILTIN_SOURCE_KEYS.includes(sourceKey)) return false;
  return lxCatalogCache.allSourceKeys.includes(sourceKey);
}

/** 目录中「内置源之外」的可搜索扩展源（供音乐页动态 chip 展示） */
export function lxSearchableSources(): LxSearchSource[] {
  if (!lxCatalogCache) return [];
  return (lxCatalogCache.searchSources || []).filter(
    (s) => !BUILTIN_SOURCE_KEYS.includes(s.key)
  );
}

/**
 * 「可搜又可播」的音源 key 集合（跨源现搜兜底来源 B 用）。
 *
 * 规则（对齐 musicEngine.md §5 来源 B）：
 * - 内置平台（GD 源 netease/kuwo/joox + 自研源 tencent/kugou/migu）须同时满足
 *   平台搜索引擎开关 search 与播放引擎开关 play（music-caps，默认 tencent 全关、
 *   migu play 关），且剔除 SELF_ONLY_ENGINE_KEYS——migu 无内置直链，恒不作为跨源候选
 *   （配置 lx 脚本后由下方的可搜索扩展源承担）；kugou 已内置官方直链，默认即候选；
 * - lx 目录已加载的可搜索扩展源（脚本源本身即负责搜索 + 直链，不受平台开关约束）；
 * - 传 excludeSource 时把失败源自身剔除（避免在刚失败的同一 source 上重复现搜）。
 */
export function crossSearchPlayableSourceKeys(
  excludeSource?: string | null
): string[] {
  const keys: string[] = [];
  const push = (k: string) => {
    if (!k || k === excludeSource || keys.includes(k)) return;
    keys.push(k);
  };
  for (const s of [...SEARCH_SOURCES, ...SELF_SEARCH_SOURCES]) {
    if (!isPlatformSearchOn(s.key)) continue; // 引擎（平台开关）未开
    if (!isPlatformPlayOn(s.key)) continue; // 播放引擎未开
    if (SELF_ONLY_ENGINE_KEYS.has(s.key)) continue; // migu 无内置直链，不收录
    push(s.key);
  }
  for (const s of lxSearchableSources()) push(s.key);
  return keys;
}

/**
 * 某内置平台曲目取直链失败时，可用的 lx 音源 source key。
 * 目录未加载时尽量拉一次；失败/无映射返回 null（离线时静默，不叠额外错误）。
 */
export async function lxUrlFallbackSourceFor(
  platform: string,
  signal?: AbortSignal
): Promise<string | null> {
  if (!lxCatalogCache) {
    try {
      await fetchLxCatalog(signal);
    } catch {
      return null;
    }
  }
  const hit = (lxCatalogCache?.urlFallbacks || []).find((e) => e.platform === platform);
  return hit?.source ?? null;
}

/** 仅按已加载目录判断（不触发网络）：供播放流程决定是否保留旧的“仅提示换源”行为 */
export function hasLxUrlFallbackFor(platform: string): boolean {
  return Boolean((lxCatalogCache?.urlFallbacks || []).some((e) => e.platform === platform));
}

/** 平台曲目在 lx 音源语义下的“取链 id”（各平台脚本所需 id 形态不同） */
function platformLxPlayId(
  platform: string,
  item: Pick<SearchItem, "id" | "urlId" | "lyricId">
): string {
  switch (platform) {
    case "kugou": // 酷狗以 FileHash 为准（自研结果 hash 也放 urlId，兜底 lyricId）
      return item.urlId || item.lyricId || item.id;
    case "netease":
    case "tencent": // QQ 以 songmid 为准
    case "kuwo": // 酷我以 rid 为准
    case "migu": // 咪咕以 contentId（cid）为准，缺失退回 songId
    default:
      return item.urlId || item.id;
  }
}

/** 构造“音源脚本同曲换链”请求参数：id 必填，按平台补 hash/songmid，并带标题歌手便于脚本兜底 */
function buildLxUrlFallbackQuery(
  platform: string,
  fallbackSource: string,
  item: Pick<SearchItem, "id" | "urlId" | "lyricId" | "name" | "artist">,
  br: string
): URLSearchParams {
  const id = platformLxPlayId(platform, item);
  const qs = new URLSearchParams({ action: "url", source: fallbackSource, id, br });
  if (platform === "kugou") qs.set("hash", item.urlId || item.lyricId || id);
  if (platform === "tencent") qs.set("songmid", item.urlId || id);
  const name = (item.name || "").trim();
  if (name) qs.set("title", name);
  const artist = item.artist?.find(Boolean);
  if (artist) qs.set("artist", artist);
  return qs;
}

/** lx 扩展源请求入口：直发 /api/music/lx，错误信息透传（无 GD 直连兜底概念） */
async function lxProxyGet(
  params: URLSearchParams,
  signal?: AbortSignal
): Promise<ProxyOkPayload> {
  return proxyGet(params, signal, "/api/music/lx");
}

// —— 错误分类：仅 kind="down"（代理对部署出口不可用/通道层故障）才触发直连降级 ——
type MusicErrKind = "down" | "biz";

class MusicError extends Error {
  readonly kind: MusicErrKind;
  constructor(kind: MusicErrKind, message: string) {
    super(message);
    this.name = "MusicError";
    this.kind = kind;
  }
}

function isAbortError(err: unknown): boolean {
  if (
    typeof DOMException !== "undefined" &&
    err instanceof DOMException
  ) {
    return err.name === "AbortError";
  }
  return err instanceof Error && err.name === "AbortError";
}

function isChallengeBody(text: string): boolean {
  if (!text) return false;
  const head = text.slice(0, 2000);
  return CF_CHALLENGE_MARKERS.some((marker) => head.includes(marker));
}

/** 同源代理请求：仅成功（HTTP 200 且 code=200）返回，失败按分类抛 MusicError */
interface ProxyOkPayload {
  code: number;
  msg?: string;
  data?: unknown;
  failType?: string;
}
async function proxyGet(
  params: URLSearchParams,
  signal?: AbortSignal,
  endpoint = "/api/music"
): Promise<ProxyOkPayload> {
  let res: Response;
  try {
    res = await fetch(`${endpoint}?${params.toString()}`, { signal });
  } catch (err) {
    if (isAbortError(err)) throw err;
    // 代理通道本身不可达（网络断 / 平台错误页）也按“通道不可用”处理，可尝试直连
    throw new MusicError("down", DOWN_MSG);
  }
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    /* 代理返回非 JSON（平台 5xx 错误页等） */
  }
  const obj =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as ProxyOkPayload)
      : null;
  if (res.ok && obj && obj.code === 200) return obj;
  const msg = obj && typeof obj.msg === "string" ? obj.msg : "";
  if (!res.ok && res.status >= 500) throw new MusicError("down", msg || DOWN_MSG);
  if (obj && (obj.code === 502 || obj.failType === "sources-down")) {
    throw new MusicError("down", msg || DOWN_MSG);
  }
  // 400（源不可用/参数错）/ 404（无此曲）/ 429（限流）等业务态：直连结果也不会更好
  throw new MusicError("biz", msg || "请求失败，请稍后重试");
}

/** 上游直连 GET（跨域，上游已放行 CORS） */
async function directGet(
  params: URLSearchParams,
  signal?: AbortSignal
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${DIRECT_BASE}?${params.toString()}`, { signal });
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new MusicError("down", DOWN_MSG);
  }
  if (!res.ok) throw new MusicError("down", DOWN_MSG);
  return res;
}

/** 直连 JSON：HTTP 200 但非 JSON（多为 CF 校验页）同样视为不可用 */
async function directJson(
  params: URLSearchParams,
  signal?: AbortSignal
): Promise<unknown> {
  const res = await directGet(params, signal);
  try {
    return await res.json();
  } catch {
    throw new MusicError("down", DOWN_MSG);
  }
}

// —— 上游响应解析（对齐 gdmusic.js 同名函数，仅保留浏览器端需要的最小字段） ——

/** types=search 成功契约：扁平数组 [{ id, name, artist, album, pic_id, url_id, lyric_id, source }] */
function parseUpstreamSearch(json: unknown): SearchItem[] {
  const items: SearchItem[] = [];
  if (!Array.isArray(json)) return items;
  for (const raw of json) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const rec = raw as Record<string, unknown>;
    const id = String(rec.id ?? rec.url_id ?? "").trim();
    const name = String(rec.name ?? rec.title ?? "").trim();
    if (!id || !name) continue; // 缺 id/歌名的脏条目直接丢弃
    let artist: string[] = [];
    if (Array.isArray(rec.artist)) {
      artist = rec.artist.map((a) => String(a ?? "")).filter(Boolean);
    } else if (typeof rec.artist === "string" && rec.artist.trim()) {
      artist = [rec.artist.trim()];
    }
    items.push({
      id,
      // 直链请求优先使用上游单独的 url_id（多数源与 id 相同，个别源不一致）
      urlId: String(rec.url_id ?? rec.id ?? "").trim() || id,
      // 封面需经 types=pic 二次换取；个别曲目 pic_id 可能为空串
      picId: String(rec.pic_id ?? rec.pic ?? "").trim(),
      // 歌词 id，酷我/JOOX 可能为空，回退到曲目 id
      lyricId: String(rec.lyric_id ?? rec.id ?? "").trim(),
      name,
      artist,
      album: String(rec.album ?? "").trim(),
      source: String(rec.source ?? "").trim() || "",
    });
  }
  return items;
}

const DOWN_MSG = "音乐源接口暂不可用，请稍后重试";
const NOT_FOUND_MSG = "未找到该歌曲的播放链接，歌曲可能已下架或该音乐源暂无可播音源";
const NO_COVER_MSG = "未找到该歌曲的专辑封面（可能已下架或该源无封面）";

// —— 上游直连的具体操作 ——

async function directSearch(
  src: string,
  kw: string,
  page: number,
  signal?: AbortSignal
): Promise<SearchData> {
  const params = new URLSearchParams({
    types: "search",
    source: src,
    name: kw,
    count: String(PAGE_SIZE),
    pages: String(page),
  });
  const json = await directJson(params, signal);
  const items = parseUpstreamSearch(json);
  // hasMore 判定对齐服务端：仅“回满整页且未到页码上限”才有下一页（joox 无视分页整页返回）
  const hasMore =
    page < DIRECT_PAGE_MAX && items.length > 0 && items.length === PAGE_SIZE;
  return {
    source: src,
    keyword: kw,
    page,
    hasMore,
    count: items.length,
    items,
    line: { kind: "direct", base: DIRECT_BASE },
  };
}

async function directTrack(
  source: string,
  id: string,
  br: string,
  signal?: AbortSignal
): Promise<DirectData> {
  const params = new URLSearchParams({
    types: "url",
    source,
    id,
    br,
  });
  const json = await directJson(params, signal);
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new MusicError("down", DOWN_MSG);
  }
  const rec = json as Record<string, unknown>;
  const url = typeof rec.url === "string" ? rec.url.trim() : "";
  if (!url.startsWith("http")) throw new MusicError("biz", NOT_FOUND_MSG);
  return {
    url,
    br: Number(rec.br) || 0,
    size: Number(rec.size) || 0,
    source,
    id,
  };
}

async function directPic(
  source: string,
  picId: string,
  signal?: AbortSignal
): Promise<string> {
  const params = new URLSearchParams({
    types: "pic",
    source,
    id: picId,
    size: "300",
  });
  const json = await directJson(params, signal);
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new MusicError("down", DOWN_MSG);
  }
  const rec = json as Record<string, unknown>;
  const url = typeof rec.url === "string" ? rec.url.trim() : "";
  if (!/^https?:\/\//i.test(url)) throw new MusicError("biz", NO_COVER_MSG);
  // 与 gdmusic.js parsePicResponse 一致：统一升级为 https，避免页面 mixed-content
  return url.replace(/^http:\/\//i, "https://");
}

async function directLyric(
  source: string,
  id: string,
  signal?: AbortSignal
): Promise<string> {
  const params = new URLSearchParams({ types: "lyric", source, id });
  const res = await directGet(params, signal);
  const text = await res.text();
  if (isChallengeBody(text)) throw new MusicError("down", DOWN_MSG);
  let lyric = "";
  if (text) {
    try {
      const json = JSON.parse(text);
      if (typeof json.lyric === "string") lyric = json.lyric;
      else if (typeof json.lrc === "string") lyric = json.lrc;
      else if (typeof json === "string") lyric = json;
    } catch {
      // 上游可能直接返回 LRC 纯文本
      lyric = text;
    }
  }
  return lyric.trim();
}

/**
 * 降级编排：代理成功 → 直接用；代理「通道不可用」→ 直连兜底；直连成功一次后，
 * 本会话后续请求（含翻页/换音质/歌词）直接走直连，不再重复请求必挂的代理。
 */
async function directAfterDown<T>(
  server: () => Promise<T>,
  direct: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (directUsed) return direct();
  try {
    return await server();
  } catch (err) {
    if (!(err instanceof MusicError) || err.kind !== "down") throw err;
    if (signal?.aborted) throw err;
    const data = await direct();
    if (!directUsed) {
      directUsed = true;
      console.info(
        "[music-client] 同源代理对上游不可用，已切换为浏览器直连上游（本会话生效）"
      );
    }
    return data;
  }
}

/** 链接解析返回的 data 契约（对齐 /api/music/resolve/route.js） */
export interface ResolveData {
  /** playable = 已解析为可播放曲目；engine-missing = 识别成功但该平台直链引擎未接入 */
  status: "playable" | "engine-missing";
  platform: string;
  songId: string;
  /** playable 时元数据完整度：full = 标题/封面齐全；fallback = 详情通道不可用，以 ID 占位标题 */
  metadata?: "full" | "fallback";
  /** playable 时的归一曲目（source/netease，直链仍按 id 经既有 /api/music 链路获取） */
  item?: SearchItem;
  message?: string;
}

/**
 * 链接解析：粘贴平台分享链接 → 归一曲目（source + id + 元数据）。
 * 仅走同源代理（网易官方详情接口未开 CORS，浏览器端无直连兜底）；代理通道
 * 不可用时直接按“解析服务暂不可用”提示，不触发直连降级编排。
 */
export async function requestResolve(
  link: string,
  signal?: AbortSignal
): Promise<ResolveData> {
  const qs = new URLSearchParams({ link });
  const payload = await proxyGet(qs, signal, "/api/music/resolve");
  const data = payload.data as ResolveData | undefined;
  if (!data || typeof data.status !== "string" || !data.platform) {
    throw new MusicError("biz", "解析结果无效，请稍后重试");
  }
  return data;
}

// —— 源通道引擎：搜索引擎 / 内容提供通道的抽象面 ——
// 三条服务通道：gd = GD 聚合上游（同源代理优先 + 浏览器直连降级 + bin=1 字节能力），
// lx = 洛雪生态脚本扩展源（仅同源代理，无 bin），self = 自研直连源（搜索 + kugou 官方
// 试听直链均经 /api/music/self，无 bin；migu 无内置直链，见 SELF_ONLY_ENGINE_KEYS）。
// UI 层判断“某个 source 属于哪种引擎、能否 bin 下载 / 封面取色 / 直连降级”都必须走这里
// 的注册函数，而不是在各组件里手拼 /api/music URL 或读 isDirectUsed。未来接入新的源引擎：
// 在此注册 kind 判定与能力即可。
//
// 注意：self 引擎仅覆盖自研直连源（kugou/migu）；tencent 的搜索引擎默认停用（部署侧
// MUSIC_PLATFORM_SEARCH 可开启，见 music-platform-flags.js），链接解析/历史缓存携带的
// tencent 曲目播放/歌词/封面仍复用 GD 直链通道，因此 tencent/netease/kuwo 的引擎通道仍是 gd。

/** 源通道引擎种类（注册新引擎：在 sourceEngineKindFor 内新增判定分支） */
export type SourceEngineKind = "gd" | "lx" | "self";

/** 单个源引擎暴露给 UI 的能力位（决定该源在当前会话可用的操作） */
export interface SourceEngineCaps {
  kind: SourceEngineKind;
  /** 同源 bin=1 字节代理能力（GD 源才有；lx/self 无 bin，下载 / 封面需走直链） */
  gdBytes: boolean;
}

/** source key → 所属引擎通道（未识别一律按 GD 内置契约源处理，保持向后兼容） */
export function sourceEngineKindFor(source: string): SourceEngineKind {
  if (isLxSourceKey(source)) return "lx";
  // 引擎通道 = 自研直连源（kugou/migu）：走 /api/music/self，无 bin
  if (SELF_CHANNEL_SOURCE_KEYS.has(source)) return "self";
  return "gd";
}

/** 取某 source 的能力位（UI / 下载 / 取色的统一决策入口） */
export function sourceEngineCapsFor(source: string): SourceEngineCaps {
  const kind = sourceEngineKindFor(source);
  return { kind, gdBytes: kind === "gd" };
}

/** 该源无内置直链引擎时播放失败给用户的文案（migu；SELF_ONLY_ENGINE_KEYS） */
export const NO_ENGINE_MSG =
  "该音源暂未接入试听直链引擎，且未配置可用的兜底音源脚本；可切到网易云/QQ音乐/酷狗/酷我等音源搜索同一首歌";

/**
 * 下载入口的通道内决策结果：
 * - kind=bin：经同源 /api/music 字节代理下载（带音质标签文件名），下载按钮配 download 属性；
 * - kind=external：浏览器直接访问真实源地址，新标签打开后另存；
 *   若因「同源代理对上游不可用」退回直连模式（fallbackDirect=true），提示文案需说明这是直连。
 */
export interface TrackDownloadSpec {
  kind: "bin" | "external";
  url: string;
  fallbackDirect?: boolean;
}

/** 由「当前曲目 + 已解析直链 + 档位」决策下载入口，收敛原散落在展示层的三分支 */
export function trackDownloadSpec(opts: {
  item?: SearchItem | null;
  source: string;
  direct: DirectData;
  br: string;
}): TrackDownloadSpec {
  const { item, source, direct, br } = opts;
  const channel = sourceEngineKindFor(item?.source || source);
  // GD 源 + 同源代理可用 → 同源 bin 字节下载（服务端带 attachment 与原文件名）
  if (channel === "gd" && !directUsed) {
    const qs = new URLSearchParams({
      source: item?.source || source,
      id: item?.urlId || item?.id || direct.id,
      br,
      bin: "1",
      title: item?.name || "",
    });
    return { kind: "bin", url: `/api/music?${qs.toString()}` };
  }
  // 其余（GD 直连模式 / lx 扩展源）：真实源地址即为可下载文件，新标签打开后另存
  return {
    kind: "external",
    url: direct.url,
    fallbackDirect: channel === "gd" && directUsed,
  };
}

/**
 * 封面取色用的同源 bin 字节 URL；仅 GD 源且同源代理可用时返回非空。
 * lx 源（封面为搜索自带直链）与直连模式下返回空串，调用方据此回退“仅外部直链取色”。
 */
export function coverBinUrl(source: string, picId: string): string {
  if (!picId || sourceEngineKindFor(source) !== "gd" || directUsed) return "";
  return (
    `/api/music?action=pic&source=${encodeURIComponent(source)}` +
    `&id=${encodeURIComponent(picId)}&size=300&bin=1`
  );
}

// —— 对外请求：代理优先，通道不可用时直连兜底 ——

/** 把本页取回线路落到每条结果上：单页内同源，但多页列表追加时各页可能来自不同线路 */
function stampSearchLine(data: SearchData): SearchData {
  if (!data.line || !Array.isArray(data.items)) return data;
  return { ...data, items: data.items.map((it) => ({ ...it, line: data.line })) };
}

/**
 * 自研直连搜索（同源 /api/music/self）：不经 GD 上游，服务端直连各音源搜索接口。
 * 支持 source：netease/tencent/kugou/kuwo/migu（GD 通道命名；某平台是否启用受
 * MUSIC_PLATFORM_SEARCH 开关约束，默认仅 tencent 停用）。返回数据自带
 * line(kind=self)，翻页上限 / hasMore 由服务端计算，这里不做浏览器直连兜底（服务端已直连音源）。
 */
async function requestSelfSearchPage(
  src: string,
  kw: string,
  targetPage: number,
  signal: AbortSignal
): Promise<SearchData> {
  const qs = new URLSearchParams({
    action: "search",
    source: src,
    keyword: kw,
    page: String(targetPage),
    count: String(PAGE_SIZE),
  });
  const payload = await proxyGet(qs, signal, "/api/music/self");
  const pageData = payload.data as SearchData | undefined;
  if (!pageData || !Array.isArray(pageData.items)) {
    throw new MusicError("biz", "搜索失败，请稍后重试");
  }
  return stampSearchLine(pageData);
}

/** GD 搜索通道：同源 /api/music 代理优先；代理判定「通道不可用」时浏览器直连 GD 公共源兜底 */
async function requestGdSearchPage(
  src: string,
  kw: string,
  targetPage: number,
  signal: AbortSignal
): Promise<SearchData> {
  const qs = new URLSearchParams({
    action: "search",
    source: src,
    keyword: kw,
    page: String(targetPage),
    count: String(PAGE_SIZE),
  });
  return directAfterDown(
    async () => {
      const payload = await proxyGet(qs, signal);
      const pageData = payload.data as SearchData | undefined;
      if (!pageData || !Array.isArray(pageData.items)) {
        throw new MusicError("biz", "搜索失败，请稍后重试");
      }
      return pageData;
    },
    () => directSearch(src, kw, targetPage, signal),
    signal
  );
}

/**
 * 请求指定页码的搜索结果。
 *
 * 分派顺序（同一 source 只会命中一种）：
 * - lx 扩展源 → /api/music/lx（脚本只能在 Node 侧跑，无浏览器直连兜底）；
 * - 自研直连搜索独立源 chips（kugou/migu）→ /api/music/self（仅自研）；
 * - 双通道源 netease/kuwo → 先 /api/music/self（**自研为主**）；自研通道失败时回退 GD 搜索
 *   （同源代理 → 浏览器直连，见 requestGdSearchPage），并把该源标为「本会话 GD 兜底」
 *   （gdFallbackSearchSources），后续请求（含翻页）直接走 GD，不再每次空转一遍自研；
 * - 其余 GD 源（joox）→ GD 代理 → 浏览器直连兜底。
 */
export async function requestSearchPage(
  src: string,
  kw: string,
  targetPage: number,
  signal: AbortSignal
): Promise<SearchData> {
  // lx 扩展源
  if (sourceEngineKindFor(src) === "lx") {
    const qs = new URLSearchParams({
      action: "search",
      source: src,
      keyword: kw,
      page: String(targetPage),
      count: String(PAGE_SIZE),
    });
    const payload = await lxProxyGet(qs, signal);
    const pageData = payload.data as SearchData | undefined;
    if (!pageData || !Array.isArray(pageData.items)) {
      throw new MusicError("biz", "搜索失败，请稍后重试");
    }
    return pageData;
  }
  // 自研直连搜索独立源 chips（kugou/migu）：仅走自研通道
  if (SELF_SEARCH_CHIP_KEYS.includes(src)) {
    return requestSelfSearchPage(src, kw, targetPage, signal);
  }
  // 双通道源（netease/kuwo）：自研为主，自研失败才走 GD 搜索兜底
  if (GD_FALLBACK_SEARCH_KEYS.has(src)) {
    if (!gdFallbackSearchSources.has(src)) {
      try {
        return await requestSelfSearchPage(src, kw, targetPage, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        gdFallbackSearchSources.add(src);
        console.info(
          `[music-client] 自研搜索通道不可用，已转 GD 搜索兜底（本会话 ${src} 生效）`
        );
      }
    }
    return stampSearchLine(await requestGdSearchPage(src, kw, targetPage, signal));
  }
  // 其余 GD 源（joox）：GD 代理 → 浏览器直连
  return stampSearchLine(await requestGdSearchPage(src, kw, targetPage, signal));
}

export interface CrossSourceResult {
  source: string;
  ok: boolean;
  items: SearchItem[];
  message?: string;
}

/**
 * 聚合搜索平台级并发上限：无论单次聚合还是多次触发交叠，同一时刻至多并行打
 * 3 个音源平台的搜索请求（对第三方搜索接口更克制，降低被风控/限流的概率）。
 */
const AGGREGATE_CONCURRENCY = 3;

/** 当前立即可占用的聚合搜索并发位个数。 */
let aggregateFreeSlots = AGGREGATE_CONCURRENCY;
/** 排队等待并发位的回调队列（队首 = 最早开始等待者）。 */
const aggregateWaiters: Array<() => void> = [];

/** 归还一个并发位；若有排队者则立刻把位子转交给队首（不空转）。 */
function releaseAggregateSlot(): void {
  aggregateFreeSlots += 1;
  const wake = aggregateWaiters.shift();
  if (wake) {
    aggregateFreeSlots -= 1;
    wake();
  }
}

/**
 * 申请一个聚合搜索并发位（模块级限流闸，跨多次 searchAcrossSources 调用生效）。
 * - resolve(true)：已占用一个位，调用方完成任务后必须调 releaseAggregateSlot() 归还；
 * - resolve(false)：排队等待期间被 signal 中止，未占用位，调用方应放弃该平台请求。
 */
function acquireAggregateSlot(signal: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (aggregateFreeSlots > 0) {
    aggregateFreeSlots -= 1;
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      const i = aggregateWaiters.indexOf(wake);
      if (i >= 0) aggregateWaiters.splice(i, 1);
    };
    const onAbort = () => {
      cleanup();
      resolve(false);
    };
    const wake = () => {
      cleanup();
      if (signal?.aborted) {
        // 位子虽已让出但本请求已放弃：把它继续传给下一个等待者，避免泄漏
        releaseAggregateSlot();
        resolve(false);
        return;
      }
      resolve(true);
    };
    signal?.addEventListener("abort", onAbort);
    aggregateWaiters.push(wake);
  });
}

/**
 * 「聚合搜索」编排：对多个搜索源各自取第 1 页（复用 requestSearchPage 的分派/回退
 * 语义：lx → /api/music/lx，自研 chips / 已回退源 → /api/music/self，GD 源走代理+
 * 浏览器直连兜底），平台级并发经限流闸限制在 ≤3 路（多次触发叠加也成立）、逐源失败
 * 隔离。结果顺序与入参 keys 无关（并发完成）；聚合排序由 music-match 内部按
 * 「内容相关度 → 跨源共识位次」决定，不依赖调用方/引擎顺序，并发乱序也稳定。
 */
export async function searchAcrossSources(
  sourceKeys: string[],
  keyword: string,
  signal: AbortSignal
): Promise<CrossSourceResult[]> {
  const keys = sourceKeys.filter(Boolean);
  const runOne = async (src: string): Promise<CrossSourceResult> => {
    const granted = await acquireAggregateSlot(signal);
    if (!granted) {
      return { source: src, ok: false, items: [], message: "已取消" };
    }
    try {
      if (signal?.aborted) {
        return { source: src, ok: false, items: [], message: "已取消" };
      }
      const data = await requestSearchPage(src, keyword, 1, signal);
      return { source: src, ok: true, items: data.items ?? [] };
    } catch (error) {
      if (signal?.aborted) {
        return { source: src, ok: false, items: [], message: "已取消" };
      }
      return {
        source: src,
        ok: false,
        items: [],
        message: error instanceof Error ? error.message : "搜索失败",
      };
    } finally {
      releaseAggregateSlot();
    }
  };
  return Promise.all(keys.map(runOne));
}

/** 自研直连源取直链：/api/music/self?action=url（kugou 官方试听直链；无浏览器直连兜底） */
async function requestSelfPlayDirect(
  source: string,
  id: string,
  br: string,
  signal: AbortSignal
): Promise<DirectData> {
  const qs = new URLSearchParams({ action: "url", source, id, br });
  const payload = await proxyGet(qs, signal, "/api/music/self");
  const data = payload.data as DirectData | undefined;
  if (!data?.url) throw new MusicError("biz", NOT_FOUND_MSG);
  return data;
}

/** 取指定 source+id 在 br 档位下的试听直链 */
export async function requestDirect(
  source: string,
  id: string,
  br: string,
  signal: AbortSignal
): Promise<DirectData> {
  // self 源：migu（SELF_ONLY）无内置直链明确提示；kugou 有官方直链走自研端点
  //（避免 migu 打到 GD 后误报“未找到链接”）
  if (sourceEngineKindFor(source) === "self") {
    if (SELF_ONLY_ENGINE_KEYS.has(source)) {
      throw new MusicError("biz", NO_ENGINE_MSG);
    }
    return requestSelfPlayDirect(source, id, br, signal);
  }
  // lx 扩展源：改发 /api/music/lx?action=url（br 由服务端映射为 128k/320k/flac…）
  if (sourceEngineKindFor(source) === "lx") {
    const qs = new URLSearchParams({ action: "url", source, id, br });
    const payload = await lxProxyGet(qs, signal);
    const data = payload.data as DirectData | undefined;
    if (!data?.url) throw new MusicError("biz", NOT_FOUND_MSG);
    return data;
  }
  const qs = new URLSearchParams({ source, id, br });
  return directAfterDown(
    async () => {
      const payload = await proxyGet(qs, signal);
      const data = payload.data as DirectData | undefined;
      if (!data?.url) throw new MusicError("biz", NOT_FOUND_MSG);
      return data;
    },
    () => directTrack(source, id, br, signal),
    signal
  );
}

/**
 * 播放取直链入口（点歌 / 切音质）。
 *
 * - GD 引擎源：原直链优先；失败（VIP 受限 / 404 等）时自动尝试 lx 音源脚本同曲换链；
 * - self 源（kugou / migu）：kugou 走内置官方直链（失败再试 lx 兜底）；migu（无内置直链）
 *   直接尝试 lx 音源兜底，未配置则保持 NO_ENGINE 提示；
 * - lx 源（脚本可搜源 chip）：等同原 requestDirect 直发，不叠加兜底。
 */
export async function requestPlayDirect(
  source: string,
  item: Pick<SearchItem, "id" | "urlId" | "lyricId" | "name" | "artist">,
  br: string,
  signal: AbortSignal
): Promise<DirectData> {
  const kind = sourceEngineKindFor(source);
  const tryLxFallback = async (): Promise<DirectData | null> => {
    if (kind === "lx") return null;
    const fallbackSource = await lxUrlFallbackSourceFor(source, signal);
    if (!fallbackSource || fallbackSource === source) return null;
    const qs = buildLxUrlFallbackQuery(source, fallbackSource, item, br);
    try {
      const payload = await lxProxyGet(qs, signal);
      const data = payload.data as DirectData | undefined;
      if (data?.url) return data;
    } catch (err) {
      if (signal.aborted) throw err;
      // 音源兜底失败静默：沿用主通道错误信息展示
    }
    return null;
  };
  if (kind === "self" && SELF_ONLY_ENGINE_KEYS.has(source)) {
    // migu 无内置直链：仅试 lx 音源兜底
    const data = await tryLxFallback();
    if (data) return data;
    throw new MusicError("biz", NO_ENGINE_MSG);
  }
  try {
    return await requestDirect(source, item.urlId || item.id, br, signal);
  } catch (err) {
    if (signal.aborted) throw err;
    const data = await tryLxFallback();
    if (data) return data;
    throw err;
  }
}

/** 取专辑封面真实图片 URL */
export async function requestPic(
  source: string,
  picId: string,
  signal: AbortSignal
): Promise<string> {
  // self 源（kugou/migu）：无 GD 封面通道，且自研搜索结果一般不带可二次换取封面
  if (sourceEngineKindFor(source) === "self") {
    throw new MusicError("biz", NO_COVER_MSG);
  }
  // lx 源封面由搜索结果自带的 picUrlDirect 直接展示，不走 GD 式 pic_id 二次换取
  if (sourceEngineKindFor(source) === "lx") {
    throw new MusicError("biz", NO_COVER_MSG);
  }
  const qs = new URLSearchParams({ action: "pic", source, id: picId, size: "300" });
  return directAfterDown(
    async () => {
      const payload = await proxyGet(qs, signal);
      const data = payload.data as PicData | undefined;
      if (!data?.url) throw new MusicError("biz", NO_COVER_MSG);
      return data.url;
    },
    () => directPic(source, picId, signal),
    signal
  );
}

/** 取歌词文本（LRC 格式） */
export async function requestLyric(
  source: string,
  lyricId: string,
  signal: AbortSignal
): Promise<string> {
  // self 源（kugou/migu）：无歌词通道，明确提示
  if (sourceEngineKindFor(source) === "self") {
    throw new MusicError("biz", "歌词获取失败（该音源暂未接入歌词通道）");
  }
  // lx 扩展源：改发 /api/music/lx?action=lyric
  if (sourceEngineKindFor(source) === "lx") {
    const qs = new URLSearchParams({ action: "lyric", source, id: lyricId });
    const payload = await lxProxyGet(qs, signal);
    const data = payload.data as LyricData | undefined;
    if (!data || typeof data.lyric !== "string") {
      throw new MusicError("biz", "歌词获取失败");
    }
    return data.lyric.trim();
  }
  const qs = new URLSearchParams({ action: "lyric", source, id: lyricId });
  return directAfterDown(
    async () => {
      const payload = await proxyGet(qs, signal);
      const data = payload.data as LyricData | undefined;
      if (!data || typeof data.lyric !== "string") {
        throw new MusicError("biz", "歌词获取失败");
      }
      return data.lyric.trim();
    },
    () => directLyric(source, lyricId, signal),
    signal
  );
}

/** AMLL 词库可按平台 ID 精确匹配逐字歌词的源（源名沿用 GD 通道命名） */
const AMLL_ID_SOURCES = new Set(["netease", "tencent"]);

/** 该源是否能用平台 ID 精确查词库（其余源只能模糊搜，暂不接入） */
export function sourceSupportsAmllLyric(source: string): boolean {
  return AMLL_ID_SOURCES.has(source);
}

/**
 * 从 AMLL 词库（/api/music/amll）拉 TTML 逐字歌词原文。
 * 属于「锦上添花」通道：未收录 / 上游异常一律返回 null，不抛错打扰主歌词流。
 */
export async function requestAmllLyric(
  source: string,
  id: string,
  signal: AbortSignal
): Promise<string | null> {
  if (!sourceSupportsAmllLyric(source) || !id) return null;
  try {
    const qs = new URLSearchParams({ source, id });
    const res = await fetch(`/api/music/amll?${qs.toString()}`, { signal });
    if (!res.ok) return null;
    const payload = (await res.json()) as
      | { code?: number; data?: { lyric?: unknown } }
      | null;
    const lyric = payload?.data?.lyric;
    return typeof lyric === "string" && lyric.trim() ? lyric : null;
  } catch {
    return null;
  }
}

/** 音质档位详情 */
export function brInfo(value: string): { label: string; br: number } {
  const opt = BR_OPTIONS.find((o) => o.value === value);
  return { label: opt?.label ?? `${value}kbps`, br: Number(value) || 320 };
}

export function brIsSupported(value: string): boolean {
  return BR_OPTIONS.some((o) => o.value === value);
}

/** 上游基址可读短名：GD 公共实例显示「GD 公共源」，其余按 host 展示 */
export function lineBaseLabel(base: string): string {
  let host = base;
  try {
    host = new URL(base).host;
  } catch {
    /* 非法 URL 保持原样展示 */
  }
  return host === GD_PUBLIC_HOST ? "GD 公共源" : host;
}

/** 结果列表「线路」列内容：返回展示文案 / 悬浮全文 / 是否直连；无线路（如链接解析产物）返回 null */
export function musicLineMeta(
  line?: MusicLine | null
): { text: string; title: string; direct: boolean } | null {
  if (!line || !line.base) return null;
  // 自研直连搜索线路：站点服务端直连各音源搜索接口（不经 GD 上游）
  if (line.kind === "self") {
    return {
      text: "自研直搜",
      title: "站点自研通道直连音源搜索接口取回（不经 GD 公共源）",
      direct: false,
    };
  }
  const direct = line.kind === "direct";
  return {
    text: `${direct ? "直连" : "代理"} · ${lineBaseLabel(line.base)}`,
    title: direct
      ? `浏览器直连上游取回（同源代理不可用后降级）· ${line.base}`
      : `经同源代理 /api/music 命中上游基址 · ${line.base}`,
    direct,
  };
}

export type { SearchSourceKey };
