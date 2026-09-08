/**
 * lx-provider —— mediaGet「音乐源 Provider」的洛雪(lx-music)脚本提供方
 *
 * 统一 Provider 抽象的一部分：
 *   - provider=gd   ：现有 GD 公共上游契约（见 lib/gdmusic.js + /api/music/route.js）
 *   - provider=lx   ：本文件实现，把配置的洛雪生态自定义音源脚本（qdy/qsvip 类）
 *                     变成 /api/music/lx 下的统一动作接口（搜索/直链/歌词）。
 *
 * 启用：环境变量 MUSIC_LX_SCRIPTS 填脚本 URL（支持英文逗号 / 空格分隔多个，
 * 也支持 JSON 数组 [{ "id": "qdy", "url": "https://..." }]）。源脚本只跑在
 * nodejs runtime（本机 / Vercel / Docker），Cloudflare Workers 上不可用。
 *
 * 动作编排：
 *   - 脚本初始化时上报 sources（key → { name, type, actions, qualitys }），
 *     provider 据此判断某个 source 属于哪个脚本并做路由；
 *   - 脚本源码按 URL 进程内缓存（TTL 由 MUSIC_LX_SCRIPT_TTL_MS 控制，默认 6h）；
 *   - 脚本加载失败/脚本对某 action 报错时以 LxProviderError 抛出，route 层归类。
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
const CONFIG_TTL_ENV = "MUSIC_LX_SCRIPT_TTL_MS";

/** 每项脚本进程内状态 */
const registry = new Map(); // id -> entry

/** 测试钩子：注入脚本拉取实现（默认 global fetch） */
let scriptFetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(SCRIPT_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`脚本下载失败 HTTP ${res.status}`);
  return res.text();
};
export function setLxScriptFetcherForTest(fn) {
  scriptFetcher = typeof fn === "function" ? fn : scriptFetcher;
}
export function resetLxScriptRegistryForTest() {
  registry.clear();
}

/** 把环境变量里的脚本配置解析为 [{ id, url }] */
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
    if (!/^https?:\/\//i.test(url)) return;
    if (!id) {
      try {
        const u = new URL(url);
        const file = (u.pathname.split("/").pop() || "script").replace(/\.js$/i, "");
        id = file ? `${u.hostname}-${file}` : `lx-script-${i}`;
      } catch {
        id = `lx-script-${i}`;
      }
    }
    id = id.replace(/[^A-Za-z0-9._-]/g, "-");
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, url });
  });
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
  const entries = readScriptConfig();
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
  };
}
