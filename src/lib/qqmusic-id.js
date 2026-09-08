/**
 * QQ音乐 source+id 解析（非路由模块）。
 *
 * 原本 qqmusic/route.js 直接导出 parseVideoId 供 platformRoutes 挂到
 * unified-parser 的 source+id 模式；但 Next 的路由模块只允许导出 HTTP
 * 方法/路由配置，额外的具名导出会使 next build 的类型校验失败
 * （Type error: Property 'parseVideoId' is incompatible ...）。故把该实现
 * 移出路由模块，由 platformRoutes 按平台映射动态加载并挂载同名函数。
 */

import { logger } from "@/lib/api-utils";
import { zzcSign } from "@/lib/qqmusic-sign";
import {
  SONGMID_RE,
  QQMUSIC_FAILURE,
  QQMUSIC_FAILURE_MSG,
  buildSongInfoUrl,
  parseSongInfo,
  buildAlbumCoverUrl,
  buildVkeyRequestBody,
  extractPlayUrl,
  extractUinFromCookie,
  classifyQqmusicFailure,
  createQqmusicCookieGuard,
} from "@/lib/qqmusic";

// QQMUSIC_COOKIE：QQ 登录态 Cookie（uin + qm_keyst 等）。vkey 试听接口对
// 无登录态请求返回风控码（实测 500003），带 Cookie 是当前拿试听直链的通用手段。
// 与 BILIBILI_COOKIE 同约定：不走 wrangler.toml，在 Worker Dashboard 配置。
const QQMUSIC_COOKIE = process.env.QQMUSIC_COOKIE || "";

const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Referer: "https://y.qq.com/",
  Origin: "https://y.qq.com",
};

// Cookie 失效守卫：配置了 Cookie 仍连续 5 次被风控 → 醒目告警一次提醒更新
const cookieGuard = createQqmusicCookieGuard({
  threshold: 5,
  warn: (streak) =>
    console.error(
      `[qqmusic] 已配置 QQMUSIC_COOKIE 但连续 ${streak} 次被风控拦截，Cookie 疑似失效，请更新`
    ),
});

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { ...REQUEST_HEADERS, ...options.headers },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  return await res.json();
}

/** 元数据 + 试听链接组装。成功：code 200（试听拿不到时降级纯元数据 + failType） */
export async function parseBySongIds({ songmid = "", songid = "" }) {
  // 元数据：c.y.qq.com 歌曲信息接口，免签名可用（songmid/songid 均支持）
  let meta = null;
  try {
    const metaJson = await fetchJson(buildSongInfoUrl({ songmid, songid }));
    meta = parseSongInfo(metaJson);
  } catch (e) {
    logger.warn(`qqmusic 元数据请求异常: ${e.message}`);
  }
  if (!meta) {
    return {
      code: 404,
      msg: QQMUSIC_FAILURE_MSG[QQMUSIC_FAILURE.NOT_FOUND],
      failType: QQMUSIC_FAILURE.NOT_FOUND,
    };
  }

  // 试听直链：zzc 签名走 GetVkeyServerBase，失败降级为纯元数据结果
  let purl = "";
  let audioCode = null;
  let audioError = false;
  try {
    const body = buildVkeyRequestBody({
      songmid: meta.songmid,
      uin: extractUinFromCookie(QQMUSIC_COOKIE),
    });
    const json = await fetchJson(
      `https://u.y.qq.com/cgi-bin/musicu.fcg?sign=${zzcSign(body)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(QQMUSIC_COOKIE ? { Cookie: QQMUSIC_COOKIE } : {}),
        },
        body,
      }
    );
    const extracted = extractPlayUrl(json);
    purl = extracted.purl;
    audioCode = extracted.code;
  } catch (e) {
    audioError = true;
    logger.warn(`qqmusic vkey 请求异常: ${e.message}`);
  }

  const failure = classifyQqmusicFailure({
    cookieConfigured: Boolean(QQMUSIC_COOKIE),
    metaFound: true,
    audioError,
    audioCode,
    hasPurl: Boolean(purl),
  });
  cookieGuard.note({
    configured: Boolean(QQMUSIC_COOKIE),
    succeeded: Boolean(purl),
    challenged: typeof audioCode === "number" && audioCode !== 0,
  });

  const data = {
    name: meta.name,
    author: meta.singers.join(" / "),
    cover: buildAlbumCoverUrl(meta.albumMid),
    album: meta.albumName,
    songmid: meta.songmid,
    songid: meta.songid,
    interval: meta.interval,
    core: "QQ音乐",
    type: "music",
  };
  if (purl) data.url = purl;

  return {
    code: 200,
    msg: failure ? failure.msg : "解析成功",
    ...(failure ? { failType: failure.type } : {}),
    data,
  };
}

/** source+id 模式（unified-parser）：id 即 songmid */
export async function parseVideoId(songmid) {
  const mid = String(songmid || "").trim();
  if (!SONGMID_RE.test(mid)) {
    return { code: 400, msg: "无效的QQ音乐歌曲ID" };
  }
  try {
    return await parseBySongIds({ songmid: mid });
  } catch (error) {
    logger.error("qqmusic parseVideoId error:", error);
    return { code: 500, msg: "服务器内部错误" };
  }
}
