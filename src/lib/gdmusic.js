/**
 * 通用音乐源（music-api.gdstudio.xyz）纯逻辑层 —— 参数校验、上游 URL 组装、
 * 响应解析与失败归类。无网络依赖（fetch 编排在 app/api/music/route.js），
 * 全部可单测；结构对齐 qqmusic.js（纯逻辑层）+ youtube.js 的组织惯例。
 *
 * 上游契约（2026-09 实测）：
 *   GET /api.php?types=url&source=<source>&id=<track_id>&br=<br>
 *   - source 可选，netease（默认）/ tencent / kuwo / tidal / qobuz / joox /
 *     bilibili / apple / ytmusic / spotify，部分源暂不开放；
 *   - id 必填，即各音乐源下的 track_id，可通过上游 types=search 获取；
 *   - br 可选：128 / 192 / 320 / 740（16bit 无损）/ 999（24bit 无损，默认）。
 *   成功返回扁平对象 { url, br, size, from }（size 为字节数，非文档标注的 KB）；
 *   曲目不存在时 url 为空串、br/size 为 0；source 非法返回 { detail }。
 *
 *   GET /api.php?types=search&source=<source>&name=<keyword>&count=<每页>&pages=<页码>
 *   - 返回扁平数组 [{ id, name, artist, album, pic_id, url_id, lyric_id, source }]；
 *   - netease / kuwo 按 count/pages 翻页；joox 实测无视分页，始终整页返回约 30 条。
 *
 *   GET /api.php?types=pic&source=<source>&id=<pic_id>&size=<300|500>
 *   - 用 search 返回的 pic_id（非曲目 ID）换取封面直链 { url }。
 *   非法 source / 参数返回 { detail }（与 types=url 一致）。
 */

export const GD_MUSIC_API = "https://music-api.gdstudio.xyz/api.php";

/** 支持的 source → 展示名（netease 为上游默认源） */
export const GD_SOURCES = {
  netease: "网易云音乐",
  tencent: "QQ音乐",
  kuwo: "酷我音乐",
  tidal: "Tidal",
  qobuz: "Qobuz",
  joox: "JOOX",
  bilibili: "哔哩哔哩",
  apple: "Apple Music",
  ytmusic: "YouTube Music",
  spotify: "Spotify",
};

/** 上游合法的 source 取值列表 */
export const GD_SOURCE_LIST = Object.keys(GD_SOURCES);

/** 上游支持的 br 取值（999 默认 = 24bit 无损，740 = 16bit 无损） */
export const GD_BRS = [128, 192, 320, 740, 999];

export const GD_DEFAULT_SOURCE = "netease";
export const GD_DEFAULT_BR = 999;

/** 支持 types=search 的 source 子集（2026-09 实测：仅以下源开放搜索，其它返回 detail 拒绝） */
export const GD_SEARCH_SOURCES = {
  netease: "网易云音乐",
  kuwo: "酷我音乐",
  joox: "JOOX",
};

export const GD_SEARCH_SOURCE_LIST = Object.keys(GD_SEARCH_SOURCES);

/** 搜索默认/上限：count=每页数量，pages=页码（对齐上游参数名） */
export const GD_SEARCH_COUNT_DEFAULT = 10;
export const GD_SEARCH_COUNT_MAX = 20;
export const GD_SEARCH_PAGE_MAX = 20;

/** types=pic 支持的封面尺寸（300 小图 / 500 大图），默认 300 */
export const GD_PIC_SIZES = [300, 500];
export const GD_PIC_DEFAULT_SIZE = 300;

/** 曲目 ID 宽松校验：各源 ID 形态差异大（数字 / base62 / base64 等，JOOX 为带 +/=/ 的标准 base64），只挡明显非法输入 */
export const GD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_+=\-]{0,127}$/;

/** pic_id 宽松校验：各源形态差异大（网易数字 / 酷我带 / . 的路径 / JOOX 十六进制或 UUID），只挡明显非法输入 */
export const GD_PIC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_+=\-/.%]{0,255}$/;

/** 是否支持的 source */
export function isSupportedSource(source) {
  return Object.prototype.hasOwnProperty.call(GD_SOURCES, source);
}

/** 是否支持关键词搜索的 source */
export function isSearchableSource(source) {
  return Object.prototype.hasOwnProperty.call(GD_SEARCH_SOURCES, source);
}

/** 归一 br：数字且在白名单内返回数字，否则返回 null（保持 0 也判非法） */
export function normalizeBr(br) {
  const n = Number(br);
  return GD_BRS.includes(n) ? n : null;
}

/** 归一 source：小写 + trim，非法返回空串 */
export function normalizeSource(source) {
  return String(source || "").trim().toLowerCase();
}

/** 归一 id：trim，不合法返回空串 */
export function normalizeId(id) {
  const v = String(id || "").trim();
  return GD_ID_RE.test(v) ? v : "";
}

/** 归一 pic_id：trim，不合法返回空串（放宽允许路径类 pic_id，见 GD_PIC_ID_RE） */
export function normalizePicId(picId) {
  const v = String(picId || "").trim();
  return GD_PIC_ID_RE.test(v) ? v : "";
}

/** 归一搜索关键词：收拢空白、剔除控制符、限长；空返回空串 */
export function normalizeKeyword(keyword) {
  const v = String(keyword || "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  if (!v || v.length > 100) return "";
  return v;
}

/** 归一 count：非法/缺失取默认，钳制在 [1, GD_SEARCH_COUNT_MAX] */
export function normalizeCount(count) {
  const n = Number.parseInt(String(count ?? ""), 10);
  if (!Number.isInteger(n) || n <= 0) return GD_SEARCH_COUNT_DEFAULT;
  return Math.min(n, GD_SEARCH_COUNT_MAX);
}

/** 归一 page：非法/缺失取 1，钳制在 [1, GD_SEARCH_PAGE_MAX] */
export function normalizePage(page) {
  const n = Number.parseInt(String(page ?? ""), 10);
  if (!Number.isInteger(n) || n <= 0) return 1;
  return Math.min(n, GD_SEARCH_PAGE_MAX);
}

/** 归一 pic size：仅 300/500 合法，缺失/非法回落到默认 300 */
export function normalizePicSize(size) {
  const n = Number(size);
  return GD_PIC_SIZES.includes(n) ? n : GD_PIC_DEFAULT_SIZE;
}

/**
 * 通用上游 URL 组装（便于后续扩展 types=search/lyric 等操作）。
 * 已知键放 URLSearchParams 按插入序拼接，未列出的 extra 追加在末尾。
 */
export function buildUpstreamUrl({ types = "url", source, id, br, base = GD_MUSIC_API, ...extra } = {}) {
  const params = new URLSearchParams();
  params.set("types", types);
  if (source) params.set("source", String(source));
  if (id) params.set("id", String(id));
  if (br) params.set("br", String(br));
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  return `${base}?${params.toString()}`;
}

/** 获取歌曲直链的上游 URL */
export function buildTrackUrl({ source = GD_DEFAULT_SOURCE, id, br = GD_DEFAULT_BR, base } = {}) {
  return buildUpstreamUrl({ types: "url", source, id, br, base });
}

/**
 * 关键词搜索的上游 URL。
 * 上游搜索契约：types=search&source=<source>&name=<keyword>&count=<每页>&pages=<页码>
 * （实测 name=网易云/酷我/JOOX；count/pages 可省略，name 必填）
 */
export function buildSearchUrl({
  source = GD_DEFAULT_SOURCE,
  keyword,
  count = GD_SEARCH_COUNT_DEFAULT,
  page = 1,
  base,
} = {}) {
  return buildUpstreamUrl({ types: "search", source, name: keyword, pages: page, count, base });
}

/**
 * 专辑封面换取 URL。
 * 上游 pic 契约：types=pic&source=<source>&id=<pic_id>&size=<300|500>，返回 { url }。
 */
export function buildPicUrl({
  source = GD_DEFAULT_SOURCE,
  id,
  size = GD_PIC_DEFAULT_SIZE,
  base,
} = {}) {
  return buildUpstreamUrl({ types: "pic", source, id, size, base });
}

/**
 * 解析 types=url 响应。
 * @returns {{ ok: true, data: { url, br, size } } | { ok: false, kind: "rejected"|"not-found"|"bad-data", detail?: string }}
 */
export function parseTrackResponse(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, kind: "bad-data" };
  }
  // 上游对非法 source / 未开放源返回 { detail: "Value of `source` is not supported." }
  if (typeof json.detail === "string" && json.detail) {
    return { ok: false, kind: "rejected", detail: json.detail };
  }
  const url = typeof json.url === "string" ? json.url.trim() : "";
  if (url.startsWith("http")) {
    return {
      ok: true,
      data: {
        url,
        br: Number(json.br) || 0,
        size: Number(json.size) || 0,
      },
    };
  }
  // 曲目不存在 / 无可用音源：上游返回 { url: "", br: 0, size: 0 }
  return { ok: false, kind: "not-found" };
}

/**
 * 解析 types=search 响应。
 * 成功契约：扁平数组 [{ id, name, artist: [..], album, pic_id, url_id, lyric_id, source }]
 * 非法 source 返回 { detail }（与 types=url 一致）。
 * @returns {{ ok: true, items: Array<{id,urlId,picId,name,artist,album,source}> } | { ok: false, kind: "rejected"|"bad-data", detail?: string }}
 */
export function parseSearchResponse(json) {
  if (!Array.isArray(json)) {
    if (json && typeof json === "object" && typeof json.detail === "string" && json.detail) {
      return { ok: false, kind: "rejected", detail: json.detail };
    }
    return { ok: false, kind: "bad-data" };
  }
  const items = [];
  for (const raw of json) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const id = String(raw.id ?? raw.url_id ?? "").trim();
    const name = String(raw.name ?? raw.title ?? "").trim();
    if (!id || !name) continue; // 缺 id/歌名的脏条目直接丢弃
    let artist = [];
    if (Array.isArray(raw.artist)) {
      artist = raw.artist.map((a) => String(a ?? "")).filter(Boolean);
    } else if (typeof raw.artist === "string" && raw.artist.trim()) {
      artist = [raw.artist.trim()];
    }
    items.push({
      id,
      // 直链请求优先使用上游单独的 url_id（多数源与 id 相同，个别源不一致）
      urlId: String(raw.url_id ?? raw.id ?? "").trim() || id,
      // 封面需经 types=pic 二次换取；个别曲目（如酷我无专辑歌曲）pic_id 可能为空串
      picId: String(raw.pic_id ?? raw.pic ?? "").trim(),
      // 歌词 id，酷我/JOOX 可能为空，回退到曲目 id
      lyricId: String(raw.lyric_id ?? raw.id ?? "").trim(),
      name,
      artist,
      album: String(raw.album ?? "").trim(),
      source: String(raw.source ?? "").trim() || "",
    });
  }
  return { ok: true, items };
}

/**
 * 解析 types=pic 响应。
 * 封面 URL 统一升级为 https：实测部分源图床（如酷我 img2.kuwo.cn）返回 http，
 * 但其 CDN 支持 TLS，升级后避免线上 https 页面 mixed-content 拦截。
 * @returns {{ ok: true, url } | { ok: false, kind: "rejected"|"not-found"|"bad-data", detail?: string }}
 */
export function parsePicResponse(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, kind: "bad-data" };
  }
  if (typeof json.detail === "string" && json.detail) {
    return { ok: false, kind: "rejected", detail: json.detail };
  }
  const url = typeof json.url === "string" ? json.url.trim() : "";
  if (/^https?:\/\//i.test(url)) {
    return { ok: true, url: url.replace(/^http:\/\//i, "https://") };
  }
  return { ok: false, kind: "not-found" };
}

// —— 失败归类（对齐 QQMUSIC_FAILURE 的分级文案思路） ——

export const MUSIC_FAILURE = {
  NOT_FOUND: "not-found", // 曲目不存在 / 已下架 / 当前源无可用音源
  SOURCE_UNAVAILABLE: "source-unavailable", // source 在上游侧被拒（未开放/不可用）
  SOURCES_DOWN: "sources-down", // 上游网络/接口异常
};

export const MUSIC_FAILURE_MSG = {
  [MUSIC_FAILURE.NOT_FOUND]: "未找到该歌曲的播放链接，歌曲可能已下架或该音乐源暂无可播音源",
  [MUSIC_FAILURE.SOURCE_UNAVAILABLE]: "该音乐源暂未开放或不可用，请更换 source 后重试",
  [MUSIC_FAILURE.SOURCES_DOWN]: "音乐源接口暂不可用，请稍后重试",
};
