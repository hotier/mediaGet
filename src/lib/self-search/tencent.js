/**
 * QQ音乐 自研搜索 —— 移植 lx-music-desktop（Apache-2.0）musicSdk/tx 的搜索链路。
 *
 * 链路：POST https://u.y.qq.com/cgi-bin/musics.fcg?sign=<zzc>
 *   body = JSON.stringify({ comm, req })（zzc 签名对象即该 JSON 串），UA 需安卓客户端 UA
 * 返回：{ code: 0, req: { code: 0, data: { meta: { estimate_sum }, body: { item_song } } } }
 * 本模块为纯逻辑 + 默认编排：请求体/响应解析可单测。
 */
import { SelfSearchError, SELF_SEARCH_FAILURE } from "./errors";
import { zzcSign } from "../qqmusic-sign";
import { postJson } from "./request";

export const TENCENT_UA = "QQMusic 14090508(android 12)";

/** musicu 结构版搜索请求体（DoSearchForQQMusicMobile） */
export function buildTencentSearchBody(keyword, page, limit) {
  return {
    comm: {
      ct: "11",
      cv: "14090508",
      v: "14090508",
      tmeAppID: "qqmusic",
      phonetype: "EBG-AN10",
      deviceScore: "553.47",
      devicelevel: "50",
      newdevicelevel: "20",
      rom: "HuaWei/EMOTION/EmotionUI_14.2.0",
      os_ver: "12",
      OpenUDID: "0",
      OpenUDID2: "0",
      QIMEI36: "0",
      udid: "0",
      chid: "0",
      aid: "0",
      oaid: "0",
      taid: "0",
      tid: "0",
      wid: "0",
      uid: "0",
      sid: "0",
      modeSwitch: "6",
      teenMode: "0",
      ui_mode: "2",
      nettype: "1020",
      v4ip: "",
    },
    req: {
      module: "music.search.SearchCgiService",
      method: "DoSearchForQQMusicMobile",
      param: {
        search_type: 0,
        searchid: Math.random().toString().slice(2),
        query: keyword,
        page_num: page,
        num_per_page: limit,
        highlight: 0,
        nqc_flag: 0,
        multi_zhida: 0,
        cat: 2,
        grp: 1,
        sin: 0,
        sem: 0,
      },
    },
  };
}

export function buildTencentSearchUrl(body) {
  const sign = zzcSign(JSON.stringify(body));
  return `https://u.y.qq.com/cgi-bin/musics.fcg?sign=${sign}`;
}

function singerNames(singer) {
  if (!Array.isArray(singer)) return [];
  return singer.map((s) => (s && s.name ? String(s.name) : "")).filter(Boolean);
}

/** 解析 fcg 搜索响应为候选列表；结构不符抛 sources-down */
export function parseTencentSearch(json) {
  if (
    !json ||
    json.code !== 0 ||
    !json.req ||
    json.req.code !== 0 ||
    !json.req.data
  ) {
    throw new SelfSearchError(
      SELF_SEARCH_FAILURE.SOURCES_DOWN,
      "QQ音乐搜索接口返回结构异常"
    );
  }
  const data = json.req.data || {};
  const rawList = data.body && Array.isArray(data.body.item_song) ? data.body.item_song : [];
  const total = Number((data.meta && data.meta.estimate_sum) || 0);
  const items = [];
  for (const item of rawList) {
    // 必须有 media_mid（vkey 用）与 mid（songmid，GD tencent 直链/歌词的 track id）
    if (!item || !item.file || !item.file.media_mid || !item.mid) continue;
    const artist = singerNames(item.singer);
    if (!artist.length) continue;
    const albumMid = item.album && item.album.mid ? String(item.album.mid) : "";
    const albumName = item.album && item.album.name ? String(item.album.name) : "";
    let pic = "";
    if (albumMid && albumMid !== "空") {
      pic = `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg`;
    } else if (item.singer && item.singer[0] && item.singer[0].mid) {
      pic = `https://y.gtimg.cn/music/photo_new/T001R500x500M000${item.singer[0].mid}.jpg`;
    }
    items.push({
      id: String(item.mid),
      urlId: String(item.mid),
      lyricId: String(item.mid),
      name: String(item.title || ""),
      artist,
      album: albumName,
      pic,
    });
  }
  return { items, total };
}

/** QQ音乐搜索编排：最多重试 2 次，网络/结构异常统一归类 sources-down */
export async function searchTencent(keyword, page, limit) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const body = buildTencentSearchBody(keyword, page, limit);
      const url = buildTencentSearchUrl(body);
      const json = await postJson(url, body, { headers: { "User-Agent": TENCENT_UA } });
      return parseTencentSearch(json);
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
    `QQ音乐搜索暂不可用${lastError ? `：${lastError.message}` : ""}`
  );
}
