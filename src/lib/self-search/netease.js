/**
 * 网易云音乐 自研搜索 —— 移植 lx-music-desktop（Apache-2.0）musicSdk/wy 的 eapi 搜索链路。
 *
 * 链路：POST https://interface.music.163.com/eapi/batch
 *   表单 params = eapi('/api/search/song/list/page', { keyword, ... }) 加密串
 * 返回：{ code: 200, data: { totalCount, resources: [{ baseInfo: { simpleSongData } }] } }
 * 本模块为纯逻辑 + 默认编排：URL/表单/解析可单测，fetch 失败按 sources-down 归类。
 */
import { SelfSearchError, SELF_SEARCH_FAILURE } from "./errors";
import { wyEapi } from "./crypto";
import { postFormJson, upgradeToHttps } from "./request";

export const NETEASE_SEARCH_API_PATH = "/api/search/song/list/page";
export const NETEASE_SEARCH_URL = "https://interface.music.163.com/eapi/batch";

/** eapi 批量入口所需请求头（origin/Referer 缺一不可） */
export const NETEASE_HEADERS = {
  origin: "https://music.163.com",
  Referer: "https://music.163.com/",
};

export function buildNeteaseSearchForm(keyword, page, limit) {
  return {
    params: wyEapi(NETEASE_SEARCH_API_PATH, {
      keyword,
      needCorrect: "1",
      channel: "typing",
      offset: limit * (page - 1),
      scene: "normal",
      total: page === 1,
      limit,
    }),
  };
}

/** 解析 eapi 搜索响应为候选列表；结构不符抛 sources-down */
export function parseNeteaseSearch(json) {
  if (!json || json.code !== 200 || !json.data || !Array.isArray(json.data.resources)) {
    throw new SelfSearchError(
      SELF_SEARCH_FAILURE.SOURCES_DOWN,
      "网易云搜索接口返回结构异常"
    );
  }
  const items = [];
  for (const entry of json.data.resources || []) {
    const song = entry && entry.baseInfo && entry.baseInfo.simpleSongData;
    if (!song || !song.id || !song.name) continue;
    const artist = Array.isArray(song.ar)
      ? song.ar.map((a) => (a && a.name ? String(a.name) : "")).filter(Boolean)
      : [];
    if (!artist.length) continue;
    items.push({
      id: String(song.id),
      urlId: String(song.id),
      lyricId: String(song.id),
      name: String(song.name),
      artist,
      album: song.al && song.al.name ? String(song.al.name) : "",
      pic: song.al && song.al.picUrl ? upgradeToHttps(song.al.picUrl) : "",
    });
  }
  return { items, total: Number(json.data.totalCount) || items.length };
}

/** 网易云搜索编排：最多重试 2 次，网络/结构异常统一归类 sources-down */
export async function searchNetease(keyword, page, limit) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const json = await postFormJson(
        NETEASE_SEARCH_URL,
        buildNeteaseSearchForm(keyword, page, limit),
        { headers: NETEASE_HEADERS }
      );
      return parseNeteaseSearch(json);
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
    `网易云搜索暂不可用${lastError ? `：${lastError.message}` : ""}`
  );
}
