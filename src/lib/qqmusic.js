/**
 * QQ音乐解析纯逻辑层 —— URL 识别、接口组装、响应归一、失败归类与 Cookie 守卫。
 * 无网络依赖（fetch 编排在 app/api/qqmusic/route.js），全部可单测；
 * 结构对齐 youtube.js（纯逻辑层）与 bilibili-cookie-guard.js（守卫形态）。
 */

/** 歌曲链接形态：
 *  1. https://y.qq.com/n/ryqq/songDetail/<songmid>            现网歌曲页
 *  2. https://y.qq.com/n/yqq/song/<songmid>.html              旧版歌曲页
 *  3. https://i.y.qq.com/v8/playsong.html?songid=&songmid=    App 分享 webview
 *  4. https://c6.y.qq.com/base/fcgi-bin/u?__=<token>          App 分享短链（需先跟随跳转）
 */
export const SONGMID_RE = /^[0-9A-Za-z]{6,30}$/;

/** 是否 QQ 音乐 App 分享短链（302/JS 跳转到歌曲页，需 resolve 后再提取） */
export function isQqMusicShortUrl(url) {
  try {
    const u = new URL(url);
    return /(^|\.)y\.qq\.com$/.test(u.hostname) && u.pathname.includes("/fcgi-bin/u");
  } catch {
    return false;
  }
}

/**
 * 从歌曲页 / 分享 webview URL 提取歌曲标识。
 * @returns {{ songmid: string, songid: string } | null} 二者至少一个非空；非 y.qq.com 返回 null
 */
export function extractSongIds(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)y\.qq\.com$/.test(u.hostname)) return null;

    // query 优先（分享 webview 常同时带 songid + songmid）
    let songmid = u.searchParams.get("songmid") || "";
    let songid = u.searchParams.get("songid") || "";

    // 路径兜底：/n/ryqq/songDetail/<mid>、旧版 /n/yqq/song/<mid>.html
    if (!songmid && !songid) {
      const m = u.pathname
        .replace(/\/+$/, "")
        .match(/\/song(?:Detail)?\/([0-9A-Za-z]+?)(?:\.html)?$/i);
      if (m) songmid = m[1];
    }

    if (songmid && !SONGMID_RE.test(songmid)) songmid = "";
    if (songid && !/^\d+$/.test(songid)) songid = "";
    if (!songmid && !songid) return null;
    return { songmid, songid };
  } catch {
    return null;
  }
}

/** 歌曲信息接口（免签名可用，songmid/songid 均支持，2026-09 实测） */
export function buildSongInfoUrl({ songmid = "", songid = "" } = {}) {
  const key = songmid ? `songmid=${encodeURIComponent(songmid)}` : `songid=${encodeURIComponent(songid)}`;
  return `https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?${key}&format=json`;
}

/** 归一歌曲信息；结构不符返回 null */
export function parseSongInfo(json) {
  const song = json?.data?.[0];
  if (!song?.mid) return null;
  return {
    songmid: String(song.mid),
    songid: String(song.id ?? ""),
    name: song.name || song.title || "",
    singers: (Array.isArray(song.singer) ? song.singer : [])
      .map((s) => s?.name)
      .filter(Boolean),
    albumName: song.album?.name || "",
    albumMid: song.album?.mid || "",
    interval: Number(song.interval) || 0,
  };
}

/** 专辑封面（按 albummid 拼 y.gtimg.cn 标准图床地址） */
export function buildAlbumCoverUrl(albumMid) {
  if (!albumMid) return "";
  return `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg`;
}

// —— vkey 试听链接接口（musicu.fcg，需 zzc 签名 + 登录 Cookie，见 qqmusic-sign.js） ——

export function randomGuid() {
  // 常规网页端 guid 为纯数字设备串，随机 10 位即可
  return String(Math.floor(1e9 + Math.random() * 9e9));
}

/** 从 QQMUSIC_COOKIE 提取数字 uin（uin=o12345 / qqmusic_uin=12345），无则 "0" */
export function extractUinFromCookie(cookie) {
  const m = String(cookie || "").match(/(?:^|;\s*)(?:qqmusic_)?uin=o?(\d{3,})/i);
  return m ? m[1] : "0";
}

/** musicu.fcg 请求体（GetVkeyServerBase），返回 JSON 字符串（签名输入即该串） */
export function buildVkeyRequestBody({ songmid, uin = "0", guid = randomGuid() }) {
  return JSON.stringify({
    req_0: {
      module: "music.vkey.GetVkeyServerBase",
      method: "CgiGetVkey",
      param: {
        guid,
        songmid: [songmid],
        songtype: [0],
        uin,
        loginflag: 1,
        platform: "20",
      },
    },
  });
}

/** 解析 vkey 响应 → { code, purl }（purl 归一为 https 绝对地址，拿不到为空串） */
export function extractPlayUrl(json) {
  const req = json?.req_0;
  const code = typeof req?.code === "number" ? req.code : null;
  const list = Array.isArray(req?.data?.midurlinfo) ? req.data.midurlinfo : [];
  const hit = list.find((item) => item?.purl) || list[0] || {};
  let purl = String(hit.purl || "");
  if (purl.startsWith("//")) purl = `https:${purl}`;
  else if (purl.startsWith("/")) purl = `https://dl.stream.qqmusic.qq.com${purl}`;
  return { code, purl };
}

// —— 失败归类（对齐 YouTube failType / B站 classifyBiliFailure 的分级文案思路） ——

export const QQMUSIC_FAILURE = {
  NOT_FOUND: "not-found", // 歌曲不存在/已下架
  NEED_COOKIE: "need-cookie", // vkey 接口被风控且服务器未配置 Cookie
  SIGN_STALE: "sign-stale", // 已配置 Cookie 仍被风控（Cookie/签名疑似失效）
  VIP_ONLY: "vip-only", // VIP/付费歌曲无试听直链
  SOURCES_DOWN: "sources-down", // 上游网络/接口异常
};

export const QQMUSIC_FAILURE_MSG = {
  [QQMUSIC_FAILURE.NOT_FOUND]: "歌曲不存在或已下架",
  [QQMUSIC_FAILURE.NEED_COOKIE]:
    "试听链接获取失败：QQ音乐接口被风控拦截（服务器未配置 QQMUSIC_COOKIE）",
  [QQMUSIC_FAILURE.SIGN_STALE]:
    "试听链接获取失败：服务器 Cookie 疑似失效，请更新 QQMUSIC_COOKIE",
  [QQMUSIC_FAILURE.VIP_ONLY]: "该歌曲为 VIP/付费歌曲，暂无可下载的试听直链",
  [QQMUSIC_FAILURE.SOURCES_DOWN]: "QQ音乐解析源暂不可用，请稍后重试",
};

/**
 * 归类一次解析结果。调用方保证已尽力尝试音频（metaFound 时必有 songmid）。
 * @returns {{ type: string, msg: string } | null} null 表示音频可用，无失败
 */
export function classifyQqmusicFailure({
  cookieConfigured = false,
  metaFound = false,
  audioError = false,
  audioCode = null,
  hasPurl = false,
} = {}) {
  if (!metaFound) {
    return { type: QQMUSIC_FAILURE.NOT_FOUND, msg: QQMUSIC_FAILURE_MSG[QQMUSIC_FAILURE.NOT_FOUND] };
  }
  if (audioError) {
    return { type: QQMUSIC_FAILURE.SOURCES_DOWN, msg: QQMUSIC_FAILURE_MSG[QQMUSIC_FAILURE.SOURCES_DOWN] };
  }
  if (typeof audioCode === "number" && audioCode !== 0) {
    return cookieConfigured
      ? { type: QQMUSIC_FAILURE.SIGN_STALE, msg: QQMUSIC_FAILURE_MSG[QQMUSIC_FAILURE.SIGN_STALE] }
      : { type: QQMUSIC_FAILURE.NEED_COOKIE, msg: QQMUSIC_FAILURE_MSG[QQMUSIC_FAILURE.NEED_COOKIE] };
  }
  if (!hasPurl) {
    return { type: QQMUSIC_FAILURE.VIP_ONLY, msg: QQMUSIC_FAILURE_MSG[QQMUSIC_FAILURE.VIP_ONLY] };
  }
  return null;
}

/**
 * Cookie 失效守卫：配置 Cookie 后连续 challenged（风控码）失败 → 只告警一次；
 * 任一次成功复位。形态与 bilibili-cookie-guard 的 createBiliCookieGuard 一致。
 */
export function createQqmusicCookieGuard({ warn, threshold = 5 } = {}) {
  let failureStreak = 0;
  let staleAlerted = false;

  return {
    /** @returns {boolean} 本次是否触发一次性失效告警 */
    note({ configured, succeeded, challenged }) {
      if (!configured) return false;
      if (succeeded) {
        failureStreak = 0;
        staleAlerted = false;
        return false;
      }
      if (!challenged) return false; // VIP-only 等非风控失败不累计
      failureStreak += 1;
      if (failureStreak >= threshold && !staleAlerted) {
        staleAlerted = true;
        if (warn) warn(failureStreak);
        return true;
      }
      return false;
    },
    get failureStreak() {
      return failureStreak;
    },
    get staleAlerted() {
      return staleAlerted;
    },
    reset() {
      failureStreak = 0;
      staleAlerted = false;
    },
  };
}
