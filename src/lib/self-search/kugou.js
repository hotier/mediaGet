/**
 * 酷狗音乐 自研搜索 —— 移植 lx-music-desktop（Apache-2.0）musicSdk/kg 的 song_search_v2 链路。
 *
 * 链路：GET https://songsearch.kugou.com/song_search_v2?keyword=&page=&pagesize=...
 * 返回：{ error_code: 0, data: { total, lists: [...] } }，列表条目含 Grp（同曲各档位变体）。
 * 搜索列表不含封面字段，遵循「封面不强求」约定不补二次换取。
 */
import { SelfSearchError, SELF_SEARCH_FAILURE } from "./errors";
import { decodeName, fetchJson } from "./request";

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
