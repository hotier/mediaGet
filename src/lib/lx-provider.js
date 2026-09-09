/**
 * lx-provider —— mediaGet「音乐源 Provider」的洛雪(lx-music)脚本提供方
 *
 * 统一 Provider 抽象的一部分：
 *   - provider=gd   ：现有 GD 公共上游契约（见 lib/gdmusic.js + /api/music/route.js）
 *   - provider=lx   ：本文件实现，把配置的洛雪生态自定义音源脚本（qdy/qsvip 类）
 *                     变成 /api/music/lx 下的统一动作接口（搜索/直链/歌词）。
 *
 * 启用（三种方式可叠加）：
 *   - 环境变量 MUSIC_LX_SCRIPTS 填脚本 URL / 本地文件路径（支持英文逗号、空格分隔多个，
 *     也支持 JSON 数组 [{ "id": "qdy", "url": "https://..." }]；本地文件建议用 JSON 数组，
 *     以便路径含空格也不受影响）；
 *   - 环境变量 MUSIC_LX_SCRIPTS_DIR 指向一个目录，目录内每个 *.js 视为一个音源脚本；
 *   - 未设置 MUSIC_LX_SCRIPTS_DIR 时，若仓库根目录存在 .lxref/scripts/ 目录，
 *     则自动加载其中的全部 *.js（开发本机 / Docker 放入即生效）。
 * 源脚本只跑在 nodejs runtime（本机 / Vercel / Docker），Cloudflare Workers 上不可用。
 *
 * 动作编排：
 *   - 脚本初始化时上报 sources（key → { name, type, actions, qualitys }），
 *     provider 据此判断某个 source 属于哪个脚本并做路由；
 *   - 脚本源码按 URL / 本地路径进程内缓存（TTL 由 MUSIC_LX_SCRIPT_TTL_MS 控制，默认 6h）；
 *   - 脚本加载失败/脚本对某 action 报错时以 LxProviderError 抛出，route 层归类。
 *
 * 内置平台「音源兜底取直链」：netease/tencent/kuwo/kugou/migu 曲目在自身通道取直链失败
 * （VIP 受限等）或无内置引擎时，可改由音源脚本按同曲 id 换链（映射默认 wy/tx/kw/kg/mg，
 * 可用 MUSIC_LX_URL_FALLBACKS 覆盖/关闭，见 readUrlFallbackConfig；是否启用同时取决于
 * 已加载脚本确实注册了对应 source 且带 musicUrl）。映射结果经 sources 目录 urlFallbacks 下发。
 *
 * 本文件可独立单测（脚本拉取实现允许注入，见 setLxScriptFetcherForTest）。
 */
import { createLxScriptHost } from "@/lib/lx-host";

const DEFAULT_SCRIPT_TTL_MS = 6 * 60 * 60 * 1000;
const SCRIPT_FETCH_TIMEOUT_MS = 20_000;

/** GD br 数值 → 洛雪音质字符串（lx 脚本音质惯例为 128k/320k/flac/flac24bit） */
export const BR_TO_LX_QUALITY = Object.freeze({
  "128": "128k",
  "192": "192k",
  "320": "320k",
  "740": "flac",
  "999": "flac24bit",
});

/** 洛雪音质字符串 → 展示用 kbps 文案（播放条 brLabel 用） */
export const LX_QUALITY_LABEL = Object.freeze({
  "128k": "128kbps",
  "192k": "192kbps",
  "320k": "320kbps",
  flac: "FLAC",
  flac24bit: "FLAC 24bit",
  "24bit": "FLAC 24bit",
  hires: "Hi-Res",
});

export function brToLxQuality(br) {
  const raw = String(br ?? "").trim();
  if (BR_TO_LX_QUALITY[raw]) return BR_TO_LX_QUALITY[raw];
  return "320k";
}

/** 平台搜索结果里常见的“歌手/作者”字段候选 */
const SINGER_FIELD_ORDER = ["singer", "singerName", "artist", "author", "artists"];

/** 单个歌手值 → 名字：兼容纯字符串与 { name } / { singer } 等对象形态 */
function toSingerName(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "object" && !Array.isArray(value)) {
    const inner = value.name ?? value.singer ?? value.artist ?? value.nickname;
    return inner == null ? "" : toSingerName(inner);
  }
  return String(value).trim();
}

/**
 * 把 lx 脚本 musicSearch 返回的单条记录归一成 mediaGet SearchItem
 * （对齐 gdmusic.js parseSearchResponse 的字段契约：id/urlId/picId/name/artist/album/source，
 *  封面若脚本已给出 http(s) 直链则放进 picUrlDirect，播放端直接展示不再二次换取）。
 */
export function normalizeLxSearchItem(raw, source) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = String(
    raw.id ?? raw.songmid ?? raw.songId ?? raw.hash ?? raw.vid ?? raw.rid ?? ""
  ).trim();
  const name = String(raw.name ?? raw.title ?? "").trim();
  if (!id || !name) return null;

  const singerRaw =
    SINGER_FIELD_ORDER.map((f) => raw[f]).find(
      (v) => v != null && String(v).trim() !== ""
    ) ?? "";
  let artist = [];
  if (Array.isArray(singerRaw)) {
    artist = singerRaw.map((a) => toSingerName(a)).filter(Boolean);
  } else {
    const name = toSingerName(singerRaw);
    if (name) artist = [name];
  }

  const pic = String(raw.pic ?? raw.picUrl ?? raw.cover ?? "").trim();
  const picIsUrl = /^https?:\/\//i.test(pic);
  const item = {
    id,
    urlId: String(raw.url_id ?? raw.songmid ?? raw.hash ?? id).trim() || id,
    picId: "",
    lyricId: String(raw.lyric_id ?? id).trim() || id,
    name,
    artist,
    album: String(raw.album ?? raw.albumName ?? "").trim(),
    source: String(source ?? "").trim(),
  };
  if (picIsUrl) {
    // 与 gdmusic.js parsePicResponse 一致：升级 https，避免线上页面 mixed-content
    item.picUrlDirect = pic.replace(/^http:\/\//i, "https://");
  }
  return item;
}

/** 归一 lx 脚本 musicSearch 整个响应（兼容 { list } / { data: { list } } / 数组） */
export function normalizeLxSearchResponse(result, source) {
  let list = [];
  if (Array.isArray(result)) {
    list = result;
  } else if (result && typeof result === "object") {
    const data = result.data;
    if (Array.isArray(result.list)) list = result.list;
    else if (data && typeof data === "object" && Array.isArray(data.list)) list = data.list;
    else if (Array.isArray(data)) list = data;
  }
  const items = [];
  for (const raw of list) {
    const it = normalizeLxSearchItem(raw, source);
    if (it) items.push(it);
  }
  const isEnd = result && typeof result === "object" && result.isEnd === true;
  return { items, isEnd: Boolean(isEnd) };
}

/** lx 脚本 musicUrl 响应：可能是 URL 字符串 / { url } / { data: { url } } */
export function pickLxUrl(result) {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const data = result.data;
    if (typeof result.url === "string") return result.url;
    if (data && typeof data === "object" && typeof data.url === "string") return data.url;
  }
  return "";
}

/** lx 脚本 lyric 响应：可能是纯字符串 / { lyric } / { data: { lyric } } */
export function pickLxLyric(result) {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const data = result.data;
    if (typeof result.lyric === "string") return result.lyric;
    if (typeof result.lrc === "string") return result.lrc;
    if (data && typeof data === "object") {
      if (typeof data.lyric === "string") return data.lyric;
      if (typeof data.lrc === "string") return data.lrc;
    }
  }
  return "";
}

/** provider 侧业务错误：携带 failType，route 层据此映射 code/failType */
export class LxProviderError extends Error {
  constructor(message, failType = "script-error") {
    super(message);
    this.name = "LxProviderError";
    this.failType = failType;
  }
}

const CONFIG_SOURCE_ENV = "MUSIC_LX_SCRIPTS";
const CONFIG_DIR_ENV = "MUSIC_LX_SCRIPTS_DIR";
const CONFIG_TTL_ENV = "MUSIC_LX_SCRIPT_TTL_MS";
const CONFIG_FALLBACK_ENV = "MUSIC_LX_URL_FALLBACKS";

/**
 * 「内置平台曲目 → 音源脚本 source key」的取直链兜底默认映射
 * （对标 全豆要/pdone 一类聚合音源脚本声明的 key：wy/tx/kw/kg/mg）。
 * 仅当对应 source 已被可用脚本注册、且带 musicUrl/url action 时才生效。
 */
const DEFAULT_URL_FALLBACKS = Object.freeze({
  netease: "wy",
  tencent: "tx",
  kuwo: "kw",
  kugou: "kg",
  migu: "mg",
});

/**
 * 平台 → lx source 兜底映射配置：默认值之上允许环境变量覆盖：
 *   MUSIC_LX_URL_FALLBACKS 支持 JSON 对象 {"netease":"wy",...} 或 "netease=wy,tencent=tx,kuwo=0"；
 *   value 为 0/false/none/空 表示关闭该平台兜底。
 */
function readUrlFallbackConfig() {
  const map = { ...DEFAULT_URL_FALLBACKS };
  const raw = (process.env[CONFIG_FALLBACK_ENV] || "").trim();
  if (!raw) return map;
  let entries = [];
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      entries = Object.entries(parsed);
    }
  } catch {
    /* 非 JSON → 按 k=v 列表解析 */
  }
  if (!entries.length) {
    entries = raw
      .split(/[,，;；]/)
      .map((part) => part.split(/[=:：]/))
      .filter((parts) => parts.length >= 2 && parts[0].trim());
  }
  for (const [key, value] of entries) {
    const platform = String(key).trim().toLowerCase();
    const target = String(value).trim().toLowerCase();
    if (!platform) continue;
    if (!target || target === "0" || target === "false" || target === "none") {
      delete map[platform];
    } else {
      map[platform] = target;
    }
  }
  return map;
}

/** 只保留「可用脚本已注册且带 musicUrl」的映射项（平台顺序稳定、按序去重） */
export function resolveUrlFallbacks() {
  const map = readUrlFallbackConfig();
  const urlKeys = new Set();
  for (const s of lxSourcesSnapshot()) {
    if (s.actions.includes("musicUrl") || s.actions.includes("url")) urlKeys.add(s.key);
  }
  const out = [];
  for (const [platform, source] of Object.entries(map)) {
    if (!urlKeys.has(source)) continue;
    out.push({ platform, source });
  }
  return out;
}

/**
 * 默认本地脚本目录（相对进程 cwd）。本地开发在仓库根目录建 .lxref/scripts/ 放入脚本，
 * Docker 部署时把该目录 COPY 进镜像同路径即可，无需再配环境变量。
 */
const DEFAULT_LOCAL_SCRIPTS_DIR = ".lxref/scripts";

/** 判断某个引用是否支持：http(s) / file:// / 本地 *.js 路径 */
function isSupportedScriptRef(ref) {
  if (!ref || typeof ref !== "string") return false;
  if (/^https?:\/\//i.test(ref)) return true;
  if (/^file:\/\//i.test(ref)) return true;
  // 本地路径兜底：形如 x.js / a/b.js / D:\a\b.js 的相对或绝对路径
  return /\.js(?:\?[^/?#]*)?$/i.test(ref);
}

/** 从 URL 或本地路径推导默认脚本 id（可读、稳定，失败时退回下标） */
function defaultScriptIdFor(ref, index) {
  const clean = ref.split(/[?#]/)[0];
  const file = clean.split(/[\\/]/).pop() || "";
  const base = file.replace(/\.js$/i, "");
  if (/^https?:\/\//i.test(ref)) {
    try {
      const u = new URL(ref);
      return `${u.hostname}-${base || "script"}`;
    } catch {
      /* 落到通用规则 */
    }
  }
  return base ? `lx-${base}` : `lx-script-${index}`;
}

function sanitizeScriptId(id) {
  const s = String(id || "").replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return s || "";
}

/** 把环境变量里的脚本配置解析为 [{ id, url }]（仅同步判断，不做文件系统访问） */
function readScriptConfig() {
  const raw = (process.env[CONFIG_SOURCE_ENV] || "").trim();
  if (!raw) return [];
  let items;
  try {
    const parsed = JSON.parse(raw);
    items = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    items = raw.split(/[\s,，]+/).filter(Boolean);
  }
  const seen = new Set();
  const out = [];
  items.forEach((it, i) => {
    let url = "";
    let id = "";
    if (typeof it === "string") {
      url = it;
    } else if (it && typeof it === "object") {
      url = String(it.url || "");
      id = String(it.id || "");
    }
    if (!isSupportedScriptRef(url)) return;
    if (!id) id = defaultScriptIdFor(url, i);
    id = sanitizeScriptId(id) || `lx-script-${i}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, url });
  });
  return out;
}

/** 每项脚本进程内状态 */
const registry = new Map(); // id -> entry

/** 默认脚本拉取实现：http(s) 走 fetch，file:///本地路径读文件（Node runtime） */
const defaultScriptFetcher = async (url) => {
  if (/^https?:\/\//i.test(url)) {
    const res = await fetch(url, { signal: AbortSignal.timeout(SCRIPT_FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`脚本下载失败 HTTP ${res.status}`);
    return res.text();
  }
  return readLocalTextFile(url);
};

let scriptFetcher = defaultScriptFetcher;
/** 测试钩子：注入脚本拉取实现；传 null 恢复默认实现（http(s)/本地文件均可用） */
export function setLxScriptFetcherForTest(fn) {
  scriptFetcher = typeof fn === "function" ? fn : defaultScriptFetcher;
}
export function resetLxScriptRegistryForTest() {
  registry.clear();
}

/** nodejs 下读取本地脚本文件；不支持文件系统的运行时（如 edge）直接抛错交给调用方归类 */
async function readLocalTextFile(ref) {
  const fs = await import("node:fs/promises");
  const pathMod = await import("node:path");
  let filePath = ref;
  if (/^file:\/\//i.test(ref)) {
    const { fileURLToPath } = await import("node:url");
    filePath = fileURLToPath(new URL(ref));
  } else if (!pathMod.isAbsolute(ref)) {
    filePath = pathMod.resolve(process.cwd(), ref);
  }
  return fs.readFile(filePath, "utf8");
}

/**
 * 本地脚本目录配置：MUSIC_LX_SCRIPTS_DIR 指定目录时扫描该目录；
 * 未指定时若默认目录 .lxref/scripts 存在则自动扫描。返回 [{ id, url }]。
 */
async function readDirScriptConfig() {
  const explicitDir = String(process.env[CONFIG_DIR_ENV] || "").trim();
  // 默认目录（.lxref/scripts）只是“开发/Docker 放入即生效”的约定，不存在时静默跳过；
  // 显式配置 MUSIC_LX_SCRIPTS_DIR 后目录不可用则视为错误（避免配置失效被悄悄吞掉）
  const dir = explicitDir || DEFAULT_LOCAL_SCRIPTS_DIR;
  let fsMod;
  try {
    fsMod = await import("node:fs/promises");
  } catch {
    return []; // 无 node:fs（edge）时目录方式不可用，静默跳过
  }
  const pathMod = await import("node:path");
  const abs = pathMod.isAbsolute(dir) ? dir : pathMod.resolve(process.cwd(), dir);
  let names;
  try {
    names = await fsMod.readdir(abs, { withFileTypes: true });
  } catch (err) {
    // 默认目录不存在属正常（尚未放脚本）；显式配置的目录缺失则提示
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
      if (!explicitDir) return [];
      throw new Error(`MUSIC_LX_SCRIPTS_DIR 目录不存在或不可读：${dir}（${err.code}）`);
    }
    throw err;
  }
  const files = names
    .filter((d) => d.isFile() && /\.js$/i.test(d.name))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));
  return files.map((name, i) => ({
    id: sanitizeScriptId(name.replace(/\.js$/i, "")) || `lx-script-${i}`,
    url: pathMod.join(abs, name),
  }));
}

/** 汇总全部脚本配置（MUSIC_LX_SCRIPTS 优先，同名 id 只保留第一份） */
async function readAllScriptConfigs() {
  const seen = new Set();
  const out = [];
  const sources = [readScriptConfig(), await readDirScriptConfig()];
  for (const cfg of sources) {
    for (const item of cfg) {
      if (!item.id || seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}

function ttlMs() {
  const n = Number(process.env[CONFIG_TTL_ENV]);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SCRIPT_TTL_MS;
}

function entryOk(entry) {
  return entry && entry.host && !entry.initError && entry.state === "ok";
}

/** 加载失败后的最小重试间隔（避免每次请求都去重新拉脚本） */
const RETRY_COOLDOWN_MS = 60 * 1000;

async function loadEntry(entry) {
  if (entry.inflight) return entry.inflight;
  entry.lastTryAt = Date.now();
  entry.inflight = (async () => {
    try {
      const code = await scriptFetcher(entry.url);
      const host = createLxScriptHost({ code, url: entry.url });
      if (host.initError) {
        // 脚本能下载但初始化失败（语法/缺宿主 API 等）：直接判失败
        entry.state = "error";
        entry.error = host.initError;
        entry.host = host; // 保留以便 initError 信息透出
        return;
      }
      entry.host = host;
      entry.state = "ok";
      entry.error = null;
      entry.refreshError = null;
      entry.loadedAt = Date.now();
    } catch (err) {
      const reason =
        err && typeof err.message === "string"
          ? err
          : new Error(String(err ?? "脚本加载失败"));
      if (!entry.host) {
        entry.state = "error";
        entry.error = reason;
      } else {
        // 已有可用宿主：保留旧宿主继续服务，仅记录刷新失败
        entry.refreshError = reason.message;
      }
    } finally {
      entry.inflight = null;
    }
  })();
  return entry.inflight;
}

/** 按需加载全部配置脚本（进程内缓存，TTL 内不重复拉取；失败后按冷却期重试） */
export async function ensureLxScripts() {
  const entries = await readAllScriptConfigs();
  const tasks = entries.map((cfg) => {
    let entry = registry.get(cfg.id);
    if (!entry) {
      entry = {
        id: cfg.id,
        url: cfg.url,
        state: "pending",
        host: null,
        error: null,
        refreshError: null,
        loadedAt: 0,
        lastTryAt: 0,
      };
      registry.set(cfg.id, entry);
    } else if (cfg.url !== entry.url) {
      entry.url = cfg.url; // 配置更新后下次拉取按新 URL
    }
    const expired = Date.now() - (entry.loadedAt || 0) > ttlMs();
    if (entry.state === "ok" && !expired) return null;
    if (entry.state === "ok" && expired) return loadEntry(entry);
    const inCooldown = Date.now() - (entry.lastTryAt || 0) < RETRY_COOLDOWN_MS;
    if (entry.state === "error" && inCooldown) return null;
    return loadEntry(entry);
  });
  await Promise.all(tasks.filter(Boolean));
  return entries;
}

function listEntries() {
  return Array.from(registry.values());
}

/** 配置的全部脚本的元信息快照（含加载失败的错误信息，便于页面提示） */
export function lxScriptsSnapshot() {
  return listEntries().map((entry) => ({
    id: entry.id,
    url: entry.url,
    state: entry.state,
    ok: entry.state === "ok" && Boolean(entry.host),
    name: entry.host ? entry.host.meta.name : "",
    description: entry.host ? entry.host.meta.description : "",
    version: entry.host ? entry.host.meta.version : "",
    error: entry.error ? entry.error.message : entry.refreshError || null,
  }));
}

/** 全部脚本上报的 source 扁平化元信息 */
export function lxSourcesSnapshot() {
  const all = [];
  for (const entry of listEntries()) {
    if (!entryOk(entry)) continue;
    for (const [key, info] of Object.entries(entry.host.sources || {})) {
      if (!info || typeof info !== "object") continue;
      all.push({
        key,
        name: String(info.name ?? key),
        type: String(info.type ?? ""),
        actions: Array.isArray(info.actions) ? info.actions.map(String) : [],
        qualitys: Array.isArray(info.qualitys) ? info.qualitys.map(String) : [],
        scriptId: entry.id,
        scriptName: entry.host.meta.name || entry.id,
      });
    }
  }
  return all;
}

/** 支持关键词搜索的 lx source 列表（含 musicSearch/search action 的源） */
export function lxSearchableSources() {
  return lxSourcesSnapshot().filter(
    (s) => s.actions.includes("musicSearch") || s.actions.includes("search")
  );
}

function hasLxScriptSource(sourceKey) {
  if (typeof sourceKey !== "string" || !sourceKey) return false;
  return lxSourcesSnapshot().some((s) => s.key === sourceKey);
}

/** 某 source 是否由 lx 脚本提供（用于调用侧区分 provider） */
export function isLxSourceKey(sourceKey) {
  if (typeof sourceKey !== "string" || !sourceKey) return false;
  // 仅当配置了脚本且脚本已声明该 key 才视为 lx source；
  // 未加载完成时按非 lx 处理（避免抢占 GD source 名）
  return hasLxScriptSource(sourceKey);
}

function findEntryBySource(sourceKey) {
  if (typeof sourceKey !== "string" || !sourceKey) return null;
  for (const entry of listEntries()) {
    if (entryOk(entry) && entry.host.sources && Object.prototype.hasOwnProperty.call(entry.host.sources, sourceKey)) {
      return entry;
    }
  }
  return null;
}

/**
 * 向归属脚本发起一次 action。
 * @param {{source: string, action: string, info?: object}} req
 */
export async function lxScriptInvoke({ source, action, info }) {
  await ensureLxScripts();
  const entry = findEntryBySource(source);
  if (!entry) {
    const loaded = lxSourcesSnapshot().map((s) => s.key);
    throw new LxProviderError(
      loaded.length
        ? `lx 脚本未提供该 source：${source}（已加载：${loaded.join("/")}）`
        : `lx 脚本未加载或未注册任何 source：${source}`,
      loaded.length ? "source-not-found" : "script-not-ready"
    );
  }
  const raw = await entry.host.invoke({ action, source, info });
  return raw;
}

/** 便于 route 层在返回前给出全量目录时的统一出口（内含 ensureLxScripts） */
export async function getLxCatalog() {
  await ensureLxScripts();
  return {
    scripts: lxScriptsSnapshot(),
    sources: lxSourcesSnapshot(),
    searchSources: lxSearchableSources(),
    urlFallbacks: resolveUrlFallbacks(),
  };
}
