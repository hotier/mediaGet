/**
 * 咪咕音乐 自研搜索 —— 移植 lx-music-desktop（Apache-2.0）musicSdk/mg 的 jadeite v3 链路。
 *
 * 链路：GET https://jadeite.migu.cn/music_search/v3/search/searchAll?...
 *   Query 需带 text/分页/搜索开关，请求头需带 deviceId/timestamp/sign（sign = MD5 混串）。
 * 返回：{ code: "000000", songResultData: { resultList: [ [song...] ], totalCount } }。
 * 搜索列表携带封面（img1/img2/img3），可直接作为 picUrlDirect 使用。
 */
import { SelfSearchError, SELF_SEARCH_FAILURE } from "./errors";
import { md5Hex } from "./crypto";
import { fetchJson, upgradeToHttps } from "./request";

const MIGU_DEVICE_ID = "963B7AA0D21511ED807EE5846EC87D20";
const MIGU_SIGNATURE_MD5 = "6cdc72a439cef99a3418d2a78aa28c73";
const MIGU_SEARCH_SWITCH =
  '{"song":1,"album":0,"singer":0,"tagSong":1,"mvSong":0,"bestShow":1,"songlist":0,"lyricSong":0}';
const MIGU_UA =
  "Mozilla/5.0 (Linux; U; Android 11.0.0; zh-cn; MI 11 Build/OPR1.170623.032) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30";

/** v3 签名：md5(text + signatureMd5 + 固定串 + deviceId + timestamp) */
export function createMiguSignature(time, text) {
  const sign = md5Hex(
    `${text}${MIGU_SIGNATURE_MD5}yyapp2d16148780a1dcc7408e06336b98cfd50${MIGU_DEVICE_ID}${time}`
  );
  return { sign, deviceId: MIGU_DEVICE_ID };
}

export function buildMiguSearchUrl(keyword, page, limit, time = Date.now().toString()) {
  const { sign, deviceId } = createMiguSignature(time, keyword);
  const url =
    `https://jadeite.migu.cn/music_search/v3/search/searchAll?isCorrect=0&isCopyright=1` +
    `&searchSwitch=${encodeURIComponent(MIGU_SEARCH_SWITCH)}&pageSize=${limit}` +
    `&text=${encodeURIComponent(keyword)}&pageNo=${page}&sort=0&sid=USS`;
  return { url, headers: { sign, deviceId, timestamp: time } };
}

function singerNames(singerList) {
  if (!Array.isArray(singerList)) return [];
  return singerList
    .map((s) => (s && typeof s === "object" && s.name ? String(s.name) : ""))
    .filter(Boolean);
}

/** 取搜索列表最清晰的封面字段（img3 > img2 > img1），相对地址补 d.musicapp.migu.cn 前缀 */
export function coverFromMigu(data) {
  const img = (data && (data.img3 || data.img2 || data.img1)) || "";
  if (!img) return "";
  if (!/^https?:\/\//i.test(String(img))) {
    return upgradeToHttps(`http://d.musicapp.migu.cn${img}`);
  }
  return upgradeToHttps(img);
}

/** 解析 v3 搜索响应为候选列表（songResultData.resultList 为按组嵌套的二维数组） */
export function parseMiguSearch(json) {
  if (!json || String(json.code) !== "000000") {
    throw new SelfSearchError(
      SELF_SEARCH_FAILURE.SOURCES_DOWN,
      "咪咕搜索接口返回结构异常"
    );
  }
  const song = json.songResultData || {};
  const rows = Array.isArray(song.resultList) ? song.resultList : [];
  const total = Number(song.totalCount) || 0;
  const items = [];
  const seen = new Set();
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    for (const data of row) {
      if (!data || !data.songId || !data.copyrightId) continue;
      if (seen.has(data.copyrightId)) continue;
      seen.add(data.copyrightId);
      // songId 用于平台内识别；咪咕取链以 contentId（cid）为标准，缺失时退回 songId，
      // 供「配置 lx 音源后由音源脚本同曲换链」兜底使用。
      const playId = String(data.contentId || data.songId || "");
      items.push({
        id: String(data.songId),
        urlId: playId,
        lyricId: "",
        name: String(data.name || ""),
        artist: singerNames(data.singerList),
        album: String(data.album || ""),
        pic: coverFromMigu(data),
      });
    }
  }
  return { items, total };
}

/** 咪咕搜索编排：签名带时间戳，每次尝试重建；网络/结构异常统一归类 sources-down */
export async function searchMigu(keyword, page, limit) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { url, headers } = buildMiguSearchUrl(keyword, page, limit);
      const json = await fetchJson(url, {
        headers: {
          uiVersion: "A_music_3.6.1",
          ...headers,
          channel: "0146921",
          "User-Agent": MIGU_UA,
        },
      });
      return parseMiguSearch(json);
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
    `咪咕搜索暂不可用${lastError ? `：${lastError.message}` : ""}`
  );
}
