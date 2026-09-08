/**
 * 音乐解析播放器页 —— 搜索/直链/封面 客户端请求层
 *
 * 双通道请求：
 * 1. 同源代理（首选）：GET /api/music（服务端进程缓存 / IP 限流 / 统一 {code,msg,data} 契约，
 *    对应 src/app/api/music/route.js）。
 * 2. 上游直连（降级）：https://music-api.gdstudio.xyz/api.php（已开 CORS *）。公共上游对
 *    Vercel / 云厂商这类数据中心出口会回 CF 风控（403 / 校验页），但对普通民用出口友好；
 *    因此当代理通道判定为「上游对部署出口不可用」（code 502 / sources-down）而非真实业务
 *    错误（400 / 404 / 429）时，浏览器端改用上游直连兜底。直连成功一次后本会话即进入直连
 *    模式（isDirectUsed），后续请求跳过代理，避免每次都先空转一次 502。
 *
 * 注意：直连没有服务端缓存 / 限流兜底，且仅对民用出口可用；数据契约解析与本文件上游协议
 * 均对齐 src/lib/gdmusic.js（服务端解析仍以该文件为准，本文件仅保留浏览器端所需的最小解析）。
 */
import { BR_OPTIONS, SEARCH_SOURCES, type SearchSourceKey } from "@/components/music/types";

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
export function resetDirectUsed(): void {
  directUsed = false;
}

export interface MusicLine {
  /** proxy = 经同源代理 /api/music 命中上游；direct = 代理不可用时浏览器直连上游 */
  kind: "proxy" | "direct";
  /** 取回本页结果的上游基址（如 https://music-api.gdstudio.xyz/api.php） */
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
}

/** 内置 GD 源 key：无论 lx 脚本是否声明同名源，内置源都优先走 GD，避免扩展源抢占主链路 */
const GD_BUILTIN_SOURCE_KEYS = SEARCH_SOURCES.map((s) => s.key);

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

/** 该 source key 是否由 lx 脚本提供（目录加载后生效；内置 GD 源永远不算） */
export function isLxSourceKey(sourceKey: string): boolean {
  if (!lxCatalogCache || GD_BUILTIN_SOURCE_KEYS.includes(sourceKey)) return false;
  return lxCatalogCache.allSourceKeys.includes(sourceKey);
}

/** 目录中「内置源之外」的可搜索扩展源（供音乐页动态 chip 展示） */
export function lxSearchableSources(): LxSearchSource[] {
  if (!lxCatalogCache) return [];
  return (lxCatalogCache.searchSources || []).filter(
    (s) => !GD_BUILTIN_SOURCE_KEYS.includes(s.key)
  );
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

// —— 对外请求：代理优先，通道不可用时直连兜底 ——

/** 请求指定页码的搜索结果 */
export async function requestSearchPage(
  src: string,
  kw: string,
  targetPage: number,
  signal: AbortSignal
): Promise<SearchData> {
  // lx 扩展源：改发 /api/music/lx（脚本只能在 Node 侧跑，无浏览器直连兜底）
  if (isLxSourceKey(src)) {
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
  const qs = new URLSearchParams({
    action: "search",
    source: src,
    keyword: kw,
    page: String(targetPage),
    count: String(PAGE_SIZE),
  });
  const data = await directAfterDown(
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
  // 把本页取回线路落到每条结果上：单页内同源，但多页列表追加时各页可能来自不同线路
  if (data.line) {
    return { ...data, items: data.items.map((it) => ({ ...it, line: data.line })) };
  }
  return data;
}

/** 取指定 source+id 在 br 档位下的试听直链 */
export async function requestDirect(
  source: string,
  id: string,
  br: string,
  signal: AbortSignal
): Promise<DirectData> {
  // lx 扩展源：改发 /api/music/lx?action=url（br 由服务端映射为 128k/320k/flac…）
  if (isLxSourceKey(source)) {
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

/** 取专辑封面真实图片 URL */
export async function requestPic(
  source: string,
  picId: string,
  signal: AbortSignal
): Promise<string> {
  // lx 源封面由搜索结果自带的 picUrlDirect 直接展示，不走 GD 式 pic_id 二次换取
  if (isLxSourceKey(source)) {
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
  // lx 扩展源：改发 /api/music/lx?action=lyric
  if (isLxSourceKey(source)) {
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
