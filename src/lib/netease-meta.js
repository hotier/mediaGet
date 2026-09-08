/**
 * 网易云官方「歌曲详情」轻量取数层 —— 链接解析模式（M1）的元数据通道。
 *
 * 背景：GD 上游只提供 search/pic/url/lyric，无法「按 songId 查详情」；而网易云
 * 官方 song/detail JSON 接口对服务端请求（带浏览器 UA/Referer）稳定返回 200，
 * 故链接解析用它补齐 歌名/歌手/专辑/封面（fetch 编排在 resolve 路由，本文件纯逻辑可单测）。
 *
 * 上游契约（2026-09 实测）：
 *   GET https://music.163.com/api/song/detail/?id=<songId>&ids=[<songId>]
 *   - 成功：{ songs: [{ name, artists:[{name,img1v1Url}], album:{name,blurPicUrl,picUrl}, fee, duration }] }
 *   - 无此曲 / 风控：HTTP 非 200 / songs 空数组 / 非 JSON —— 由路由按“元数据缺失”降级处理。
 *   注意：网易对数据中心/海外出口可能有限制，降级后曲目仍可凭 songId 走 GD 直链播放。
 */

/** 封面缩略参数尺寸（w × h），网易图床通过 ?param= 控制 */
export const NETEASE_COVER_SIZE = 300;

export const NETEASE_COVER_URL = "https://music.163.com/api/song/detail";

/** 服务端请求头（带浏览环境，降低风控概率） */
export const NETEASE_META_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  Referer: "https://music.163.com/",
};

/** 详情请求超时（ms） */
export const NETEASE_META_TIMEOUT = 8000;

/** 网易 songId：纯数字，常见 5~10 位 */
const NETEASE_SONG_ID_RE = /^\d{4,12}$/;

/** 归一 songId：trim + 纯数字校验，非法返回空串 */
export function normalizeNeteaseSongId(value) {
  const v = String(value ?? "").trim();
  return NETEASE_SONG_ID_RE.test(v) ? v : "";
}

/** 组装详情请求 URL（官方接口要求 id 与 ids 同时携带，ids 为 [songId]） */
export function buildNeteaseDetailUrl(songId) {
  return `${NETEASE_COVER_URL}?id=${encodeURIComponent(songId)}&ids=[${songId}]`;
}

/** 为封面图床 URL 追加 ?param=WxH 缩略参数（图床支持时才拼接） */
export function appendCoverParam(url, size = NETEASE_COVER_SIZE) {
  const v = String(url || "").trim();
  if (!v) return "";
  // 统一 https，避免 http 图片在 https 页面被 mixed-content 拦截
  let u = /^\/\//.test(v) ? "https:" + v : v;
  u = u.replace(/^http:\/\//i, "https://");
  if (!/^https?:\/\//i.test(u)) return "";
  const sep = u.includes("?") ? "&" : "?";
  return `${u}${sep}param=${size}y${size}`;
}

/**
 * 解析官方 song/detail 响应为最小元数据。
 * @returns {{ ok: true, meta: { name, artist, album, coverUrl } } | { ok: false, kind: "bad-data"|"not-found" }}
 */
export function parseNeteaseDetailJson(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, kind: "bad-data" };
  }
  const song = Array.isArray(json.songs) ? json.songs[0] : null;
  if (!song || typeof song !== "object") {
    return { ok: false, kind: "not-found" };
  }
  const name = String(song.name ?? "").trim();
  if (!name) return { ok: false, kind: "not-found" };

  const artist = Array.isArray(song.artists)
    ? song.artists
        .map((a) => String(a?.name ?? "").trim())
        .filter(Boolean)
    : [];

  const album =
    song.album && typeof song.album === "object"
      ? String(song.album.name ?? "").trim()
      : "";

  // 封面优先级：专辑模糊图 → 专辑图 → 首艺人头像（头像默认小图，交由 appendCoverParam 放大）
  const albumNode = song.album && typeof song.album === "object" ? song.album : {};
  const coverRaw =
    String(albumNode.blurPicUrl ?? albumNode.picUrl ?? "").trim() ||
    (Array.isArray(song.artists) && song.artists[0]
      ? String(song.artists[0].img1v1Url ?? "").trim()
      : "");

  return {
    ok: true,
    meta: {
      name,
      artist,
      album,
      coverUrl: appendCoverParam(coverRaw, NETEASE_COVER_SIZE),
    },
  };
}
