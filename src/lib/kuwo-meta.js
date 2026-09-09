/**
 * 酷我音乐「歌曲详情」轻量取数层 —— 链接解析模式（M1）的元数据通道。
 *
 * 背景：GD 上游只提供 search/pic/url/lyric，无法「按 rid 查详情」；www.kuwo.cn 的
 * www/api 接口需 kw_token/csrf 校验，而移动端 H5 的 songinfoandlrc 接口实测免鉴权
 * 返回歌曲信息与歌词（fetch 编排在 resolve 路由，本文件纯逻辑可单测）。
 *
 * 上游契约（2026-09 实测）：
 *   GET https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=<rid>&httpsStatus=1
 *   - 成功：{ data: { songinfo: { id, musicrId, songName, artist, album, pic, duration } } }
 *   - 无此曲 / 风控：HTTP 非 200 或 songinfo 缺失 / 无 songName —— 由路由按“元数据缺失”降级。
 *   注意：降级后曲目仍可凭 rid 走 GD source=kuwo 直链播放（酷我已开放 GD 关键词搜索，
 *   搜索返回的 id 与分享链接 rid 同形）。
 */

/** 移动端 UA + H5 来源（该接口对桌面 UA 亦可用，此处统一按浏览器请求） */
export const KUWO_META_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  Accept: "application/json, text/plain, */*",
  Referer: "https://m.kuwo.cn/",
};

/** 详情请求超时（ms） */
export const KUWO_META_TIMEOUT = 8000;

/** 酷我 rid：纯数字，5~12 位（www.kuwo.cn/play_detail/<rid>） */
const KUWO_RID_RE = /^\d{5,12}$/;

/** 归一 rid：trim + 纯数字校验，非法返回空串 */
export function normalizeKuwoRid(value) {
  const v = String(value ?? "").trim();
  return KUWO_RID_RE.test(v) ? v : "";
}

/** 组装详情请求 URL（musicId 即 rid） */
export function buildKuwoInfoUrl(rid) {
  return `https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${encodeURIComponent(
    rid
  )}&httpsStatus=1`;
}

/** 封面统一升级为 https，避免 http 图在 https 页面被 mixed-content 拦截 */
function toHttps(raw) {
  const v = String(raw ?? "").trim();
  if (!v) return "";
  const u = v.replace(/^http:\/\//i, "https://").replace(/^\/\//, "https://");
  return /^https?:\/\//i.test(u) ? u : "";
}

/** 歌手字段可能是字符串（含 & / 、 分隔）或数组，归一为数组 */
function normalizeArtist(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((a) => (typeof a === "object" && a !== null ? a.name : a))
      .map((a) => String(a ?? "").trim())
      .filter(Boolean);
  }
  const v = String(raw ?? "").trim();
  return v
    ? v
        .split(/[&、,，/]/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

/**
 * 解析 songinfoandlrc 响应为最小元数据。
 * @returns {{ ok: true, meta: { rid, name, artist, album, coverUrl } } | { ok: false, kind: "bad-data"|"not-found" }}
 */
export function parseKuwoInfo(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, kind: "bad-data" };
  }
  const info = json.data && typeof json.data === "object" ? json.data.songinfo : null;
  if (!info || typeof info !== "object") {
    return { ok: false, kind: "not-found" };
  }
  const name = String(info.songName ?? info.name ?? "").trim();
  const rid = String(info.musicrId ?? info.id ?? "").trim();
  if (!name || !/^\d{5,12}$/.test(rid)) {
    return { ok: false, kind: "not-found" };
  }
  return {
    ok: true,
    meta: {
      rid,
      name,
      artist: normalizeArtist(info.artist),
      album: String(info.album ?? "").trim(),
      coverUrl: toHttps(info.pic),
    },
  };
}
