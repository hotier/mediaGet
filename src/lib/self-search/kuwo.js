/**
 * 酷我音乐 自研搜索 —— 移植 lx-music-desktop（Apache-2.0）musicSdk/kw 的 r.s 链路。
 *
 * 链路：GET http://search.kuwo.cn/r.s?client=kt&all=...&pn=<page-1>&rn=<limit>
 * 返回：{ TOTAL, SHOW, abslist: [...] }，条目 MUSICRID = "MUSIC_<rid>"。
 * 搜索结果不含封面字段（酷我封面需按 rid 二次换取，遵循「封面不强求」约定不做）。
 */
import { SelfSearchError, SELF_SEARCH_FAILURE } from "./errors";
import { decodeName, fetchJson } from "./request";

export function buildKuwoSearchUrl(keyword, page, limit) {
  return (
    `http://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(keyword)}` +
    `&pn=${page - 1}&rn=${limit}&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1` +
    `&show_copyright_off=1&newver=1&ft=music&cluster=0&strategy=2012&encoding=utf8` +
    `&rformat=json&vermerge=1&mobi=1&issubtitle=1`
  );
}

function splitArtist(raw) {
  return String(raw || "")
    .split(/[、/]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 解析 r.s 响应为候选列表；MUSICRID 缺失（结构性异常）抛 sources-down */
export function parseKuwoSearch(json) {
  if (!json || !Array.isArray(json.abslist)) {
    // TOTAL=0 时接口可能只回空对象：视为空结果而非接口异常
    if (json && String(json.TOTAL) === "0") return { items: [], total: 0 };
    throw new SelfSearchError(
      SELF_SEARCH_FAILURE.SOURCES_DOWN,
      "酷我搜索接口返回结构异常"
    );
  }
  const total = Number(json.TOTAL) || 0;
  const items = [];
  for (const info of json.abslist) {
    if (!info || typeof info !== "object") continue;
    const musicRid = String(info.MUSICRID || "");
    if (!/^MUSIC_\d+$/.test(musicRid)) continue;
    const rid = musicRid.replace("MUSIC_", "");
    items.push({
      id: rid,
      urlId: rid,
      lyricId: rid,
      name: decodeName(info.SONGNAME || ""),
      artist: splitArtist(decodeName(info.ARTIST)),
      album: decodeName(info.ALBUM || ""),
      pic: "",
    });
  }
  return { items, total };
}

/** 酷我搜索编排：最多重试 2 次，网络/结构异常统一归类 sources-down */
export async function searchKuwo(keyword, page, limit) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const json = await fetchJson(buildKuwoSearchUrl(keyword, page, limit));
      return parseKuwoSearch(json);
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
    `酷我搜索暂不可用${lastError ? `：${lastError.message}` : ""}`
  );
}
