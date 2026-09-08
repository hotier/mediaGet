import {
  beijingNow,
  getCachedResponse,
  getClientIP,
  getCorsHeaders,
  isBlockedIP,
  logger,
  rateLimit,
  setCacheResponse,
} from "@/lib/api-utils";
import { honeypotResponse } from "@/lib/honeypot";
import { normalizeResult } from "@/lib/normalize-result";
import {
  buildNeteaseDetailUrl,
  NETEASE_META_HEADERS,
  NETEASE_META_TIMEOUT,
  normalizeNeteaseSongId,
  parseNeteaseDetailJson,
} from "@/lib/netease-meta";
import {
  MUSIC_PLATFORM_LABEL,
  extractMusicUrl,
  isFollowableShareUrl,
  parseMusicLink,
} from "@/lib/music-link";

export const runtime = "nodejs";

/**
 * 音乐「链接解析」接口（链接解析模式 · M1）：
 *   GET /api/music/resolve?link=<分享文本或链接>
 *
 * 与 /api/music 的关系：/api/music 解决「关键词搜索 → 直链」；本接口解决
 * 「已知平台歌曲链接 → 归一曲目（source+id+元数据）」。解析产物是标准 SearchItem
 * 形态，点击播放时仍走既有 /api/music 直链链路（含代理/直连降级、bin 下载、歌词、封面）。
 *
 * 输入处理（全链路不直接请求用户链接，SSRF 面收敛到白名单短链域）：
 *   1. 从分享文本抽 URL → 平台识别 → 提取曲目 ID（纯函数，见 lib/music-link.ts）；
 *   2. 对官方分享短链（163cn.tv / t1.kugou.com / c.y.qq.com）跟随一次重定向再识别；
 *   3. 不支持的 host / 无法提取 ID → 400 返回受支持说明。
 *
 * 平台分支：
 *   netease  —— 请求网易官方 song/detail 补齐元数据（成功缓存 5 分钟）；
 *               详情通道失败不致命，降级为「ID 占位标题」仍可播放/下载（metadata=fallback）；
 *               直链由播放端按 id 实时取，不在本接口内预取。
 *   tencent / kugou / kuwo —— 识别成功即返回 engine-missing 状态与引导文案（引擎接入后排期点亮）。
 *
 * 响应契约（HTTP 恒 200，业务态在 data.status）：
 *   playable      { status, platform, songId, metadata: "full"|"fallback", item: SearchItem }
 *   engine-missing{ status, platform, songId, message }
 *   无法识别链接时 HTTP 400 + { code: 400, msg }。
 */

const LINK_MAX_LEN = 2000;
const REDIRECT_TIMEOUT = 7000;

/** 识别网易详情缓存 key（仅元数据成功时写缓存） */
function metaCacheKey(songId) {
  return `netease:detail:${songId}`;
}

/** 从分享文本走到「平台 + 曲目 ID」，识别不出返回 null（含短链重定向跟随） */
async function identifyLink(rawLink) {
  const url = extractMusicUrl(rawLink);
  if (!url) return null;
  let parsed = parseMusicLink(url);
  if (!parsed && isFollowableShareUrl(url)) {
    // 官方分享短链：跟随一次重定向（redirect=follow 时 resp.url 为最终地址），
    // 不读 body、只取重定向后的 URL 再识别
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: NETEASE_META_HEADERS,
        signal: AbortSignal.timeout(REDIRECT_TIMEOUT),
      });
      parsed = parseMusicLink(res.url || url);
    } catch (error) {
      logger.warn(`music resolve redirect follow failed: ${error.message}`);
    }
  }
  return parsed;
}

export async function GET(request) {
  const startTime = Date.now();
  const corsHeaders = getCorsHeaders(request.headers.get("origin") || "");
  const { searchParams } = new URL(request.url);

  const logResolve = (status, code, detail = "") =>
    console.log(
      `[music-resolve] time=${beijingNow()} code=${code} status=${status} duration=${Date.now() - startTime}ms${
        detail ? ` ${detail}` : ""
      }`
    );

  const clientIP = getClientIP(request);

  if (isBlockedIP(clientIP)) {
    logger.warn(`黑名单 IP 命中蜜罐(music-resolve): ip=${clientIP}`);
    return Response.json(normalizeResult(honeypotResponse("music-resolve")), {
      status: 200,
      headers: corsHeaders,
    });
  }

  if (!rateLimit(clientIP)) {
    logResolve("limited", 429);
    return Response.json(
      { code: 429, msg: "请求过于频繁，请稍后再试" },
      { status: 429, headers: corsHeaders }
    );
  }

  const rawLink = String(searchParams.get("link") ?? "").slice(0, LINK_MAX_LEN);
  if (!rawLink.trim()) {
    return Response.json(
      {
        code: 400,
        msg: "link 为空：请粘贴歌曲分享链接（如 https://music.163.com/song?id=…）",
        usage:
          "/api/music/resolve?link=<分享文本或歌曲链接>",
      },
      { status: 400, headers: corsHeaders }
    );
  }

  // 1) 识别（含官方短链跟随一次重定向）
  const parsed = await identifyLink(rawLink);
  if (!parsed) {
    const ready = MUSIC_PLATFORM_LABEL.netease;
    return Response.json(
      {
        code: 400,
        msg: `未能从链接中识别出歌曲：当前仅支持 ${ready} 歌曲链接直接解析，QQ音乐 / 酷狗 / 酷我链接可识别但直链引擎尚未接入；请粘贴歌曲的详情页链接（非歌单 / 歌手主页 / 视频页）`,
        supported: {
          ready: ["netease"],
          pending: ["tencent", "kugou", "kuwo"],
        },
      },
      { status: 400, headers: corsHeaders }
    );
  }

  const { platform, songId } = parsed;
  const label = MUSIC_PLATFORM_LABEL[platform];

  // 2) 分支：网易云 —— 取官方详情补齐元数据，直链由播放端实时取
  if (platform === "netease") {
    const normalizedSongId = normalizeNeteaseSongId(songId);
    if (!normalizedSongId) {
      return Response.json(
        {
          code: 400,
          msg: `链接中的网易云歌曲 ID 不合法：${songId}`,
        },
        { status: 400, headers: corsHeaders }
      );
    }

    let meta = null;
    const cacheKey = metaCacheKey(normalizedSongId);
    const cached = getCachedResponse(cacheKey);
    if (cached && typeof cached.meta === "object") {
      meta = cached.meta;
    } else {
      try {
        const res = await fetch(buildNeteaseDetailUrl(normalizedSongId), {
          headers: NETEASE_META_HEADERS,
          signal: AbortSignal.timeout(NETEASE_META_TIMEOUT),
        });
        const json = res.ok ? await res.json().catch(() => null) : null;
        const result = parseNeteaseDetailJson(json);
        if (result.ok) {
          meta = result.meta;
          setCacheResponse(cacheKey, { meta: result.meta });
        } else if (!res.ok || result.kind === "bad-data") {
          // 详情通道异常（HTTP 错误 / 非 JSON / 风控页）属于“元数据缺失”，走降级标题
          logger.warn(
            `netease detail upstream unusable status=${res.status} songId=${normalizedSongId}`
          );
        }
      } catch (error) {
        logger.warn(`netease detail upstream error: ${error.message}`);
      }
    }

    const metadata = meta ? "full" : "fallback";
    const item = {
      id: normalizedSongId,
      urlId: normalizedSongId,
      lyricId: normalizedSongId,
      name: meta ? meta.name : `网易云歌曲 ${normalizedSongId}`,
      artist: meta ? meta.artist : [],
      album: meta ? meta.album : "",
      source: "netease",
      // 详情封面为图床直链，前端封面渲染优先使用（跳过 GD pic 换取）
      picUrlDirect: meta ? meta.coverUrl : "",
    };
    logResolve("ok", 200, `platform=netease songId=${normalizedSongId} metadata=${metadata}`);
    return Response.json(
      {
        code: 200,
        msg: "解析成功",
        data: {
          status: "playable",
          platform: "netease",
          songId: normalizedSongId,
          metadata,
          item,
        },
      },
      { status: 200, headers: corsHeaders }
    );
  }

  // 3) 分支：QQ / 酷狗 / 酷我 —— 识别成功，直链引擎未接入
  logResolve("engine-missing", 200, `platform=${platform} songId=${songId}`);
  return Response.json(
    {
      code: 200,
      msg: "识别成功，该平台直链引擎暂未接入",
      data: {
        status: "engine-missing",
        platform,
        songId,
        message: `已识别为「${label}」歌曲（ID：${songId}），但该平台的直链解析引擎尚未接入，暂无法解析播放；网易云歌曲链接当前即可直接解析`,
      },
    },
    { status: 200, headers: corsHeaders }
  );
}
