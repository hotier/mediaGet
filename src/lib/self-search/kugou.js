/**
 * 酷狗音乐 自研搜索 —— 移植 lx-music-desktop（Apache-2.0）musicSdk/kg 的 song_search_v2 链路。
 *
 * 链路：GET https://songsearch.kugou.com/song_search_v2?keyword=&page=&pagesize=...
 * 返回：{ error_code: 0, data: { total, lists: [...] } }，列表条目含 Grp（同曲各档位变体）。
 * 搜索列表不含封面字段，遵循「封面不强求」约定不补二次换取。
 *
 * 官方试听直链（cmd=playInfo，本文件下半段）：
 * 以 FileHash 换 128k mp3 试听直链：GET https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=<hash>
 * （2026-09 实测：免费曲 status=1 + url/backup_url 可用直链并带元数据；VIP/付费曲 url 为空、
 * privilege 族 >0 且 error="需要付费"，归类 vip-only。wwwapi.kugou.com/yy 的 play/getdata 族接口
 * 已被 SSA 反爬拦截，不采用。）
 */
import { SelfSearchError, SELF_SEARCH_FAILURE } from "./errors";
import { decodeName, fetchJson, upgradeToHttps } from "./request";

export function buildKugouSearchUrl(keyword, page, limit) {
  return (
    `https://songsearch.kugou.com/song_search_v2?keyword=${encodeURIComponent(keyword)}` +
    `&page=${page}&pagesize=${limit}&userid=0&clientver=&platform=WebFilter&filter=2` +
    `&iscorrection=1&privilege_filter=0&area_code=1`
  );
}

function singerNames(singers) {
  if (!Array.isArray(singers)) return [];
  return singers
    .map((s) => {
      if (!s) return "";
      const raw = typeof s === "object" ? s.name : s;
      const name = raw == null ? "" : decodeName(raw);
      return name === "未知" ? "" : name;
    })
    .filter(Boolean);
}

/** 解析 song_search_v2 响应为候选列表（列表内按 Audioid 去重，同曲 Grp 变体不重复上屏） */
export function parseKugouSearch(json) {
  if (!json || json.error_code !== 0 || !json.data) {
    throw new SelfSearchError(
      SELF_SEARCH_FAILURE.SOURCES_DOWN,
      "酷狗搜索接口返回结构异常"
    );
  }
  const rawList = Array.isArray(json.data.lists) ? json.data.lists : [];
  const total = Number(json.data.total) || 0;
  const items = [];
  const seen = new Set();
  for (const item of rawList) {
    if (!item || typeof item !== "object") continue;
    const audioId = item.Audioid ?? item.audio_id ?? item.AudioID ?? "";
    const hash = String(item.FileHash || item.hash || "");
    if ((!audioId && !hash) || seen.has(String(audioId || hash))) continue;
    seen.add(String(audioId || hash));
    items.push({
      id: String(audioId || hash),
      // FileHash 是酷狗各类直链/音源脚本取链的标准 id（GD 无酷狗直链通道，
      // 配置 lx 音源后由音源脚本按此 hash 同曲换链）；lyricId 同样保留 hash。
      urlId: hash,
      lyricId: hash,
      name: decodeName(item.SongName || ""),
      artist: singerNames(item.Singers),
      album: decodeName(item.AlbumName || ""),
      pic: "",
    });
  }
  return { items, total };
}

/** 酷狗搜索编排：最多重试 2 次，网络/结构异常统一归类 sources-down */
export async function searchKugou(keyword, page, limit) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const json = await fetchJson(buildKugouSearchUrl(keyword, page, limit));
      return parseKugouSearch(json);
    } catch (error) {
      lastError = error;
      if (error instanceof SelfSearchError) {
        if (attempt === 1) throw error;
        continue;
      }
    }
  }
  throw new SelfSearchError(
    SELF_SEARCH_FAILURE.SOURCES_DOWN,
    `酷狗搜索暂不可用${lastError ? `：${lastError.message}` : ""}`
  );
}

// —— 酷狗官方试听直链（cmd=playInfo：hash → 128k mp3 直链 + 歌曲元数据） ——

/** FileHash 形态：song_search_v2 / 酷狗分享链接均为 32 位大写十六进制 */
export const KUGOU_HASH_RE = /^[0-9A-Fa-f]{32}$/;

/** 归一 FileHash：非 32 位 hex 返回空串 */
export function normalizeKugouHash(hash) {
  const value = String(hash ?? "").trim().toUpperCase();
  return KUGOU_HASH_RE.test(value) ? value : "";
}

/** 官方 getSongInfo 接口 URL（cmd=playInfo 返回 url/backup_url + 元数据） */
export function buildKugouPlayUrl(hash) {
  return `https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${encodeURIComponent(hash)}`;
}

/** 封面模板 {size} → 数字（album_img 形如 http://imge.kugou.com/stdmusic/{size}/xxx.jpg） */
export function kugouCoverUrl(raw, size = 400) {
  const url = String(raw ?? "").trim();
  if (!url) return "";
  return upgradeToHttps(url.replace("{size}", String(size)));
}

/** getSongInfo 元数据：name / artists（多歌手取 authors 结构化）/ coverUrl（专辑封面） */
export function parseKugouSongInfoMeta(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { name: "", artists: [], album: "", coverUrl: "" };
  }
  const authors = Array.isArray(json.authors)
    ? json.authors
        .map((a) => decodeName(a?.author_name || a?.name || ""))
        .filter(Boolean)
    : [];
  const fallbackArtists = (() => {
    const raw = String(json.author_name || json.singerName || "");
    if (!raw) return [];
    return decodeName(raw)
      .split("、")
      .map((s) => s.trim())
      .filter(Boolean);
  })();
  return {
    name: decodeName(json.songName || json.fileName?.split(" - ")[1] || ""),
    artists: authors.length ? authors : fallbackArtists,
    album: "",
    coverUrl: kugouCoverUrl(json.album_img),
  };
}

/**
 * 解析 getSongInfo 响应。
 * 成功：{ url, br, size, meta }（url 已升级 https；backup_url 仅作兜底不返回，未升级会失效）
 * 失败：抛 SelfSearchError（VIP_ONLY / NOT_FOUND / SOURCES_DOWN）。
 */
export function parseKugouPlayInfo(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new SelfSearchError(SELF_SEARCH_FAILURE.SOURCES_DOWN, "酷狗取链接口返回结构异常");
  }
  const meta = parseKugouSongInfoMeta(json);
  const url = upgradeToHttps(json.url);
  if (url) {
    return {
      url,
      br: Number(json.bitRate) || 128,
      size: Number(json.extra?.filesize || json.extra?.["128filesize"] || json.fileSize) || 0,
      meta,
    };
  }
  // 无 url：付费/VIP 曲目（privilege 族 >0 或 error 提示付费）与“无可用音源”区分开
  const privilegeKeys = [
    "privilege",
    "128privilege",
    "320privilege",
    "sqprivilege",
    "highprivilege",
  ];
  const paid = privilegeKeys.some((k) => Number(json[k]) > 0) || Number(json.pay_type) > 0;
  const errText = String(json.error || "").toLowerCase();
  if (paid || /需要付费|vip|会员|开通|购买|版权保护|仅.*试听|下载.*收费/.test(errText)) {
    throw new SelfSearchError(
      SELF_SEARCH_FAILURE.VIP_ONLY,
      "该歌曲为 VIP/付费歌曲，酷狗官方暂不提供免费试听直链；可切到其它音源搜索同一首歌"
    );
  }
  throw new SelfSearchError(
    SELF_SEARCH_FAILURE.NOT_FOUND,
    "未找到该歌曲的酷狗试听直链（歌曲可能已下架或当前无可播音源）"
  );
}

/** 酷狗取链编排：最多重试 2 次；VIP/下架/结构异常直接归类抛错 */
export async function getKugouPlayUrl(hash) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const json = await fetchJson(buildKugouPlayUrl(hash));
      return parseKugouPlayInfo(json);
    } catch (error) {
      lastError = error;
      if (error instanceof SelfSearchError) {
        if (attempt === 1) throw error;
        continue;
      }
    }
  }
  throw new SelfSearchError(
    SELF_SEARCH_FAILURE.SOURCES_DOWN,
    `酷狗取链暂不可用${lastError ? `：${lastError.message}` : ""}`
  );
}
