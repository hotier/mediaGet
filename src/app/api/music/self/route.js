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
  enabledPlatformList,
  isPlatformPlayEnabled,
  isPlatformSearchEnabled,
} from "@/lib/music-platform-flags";
import { SelfSearchError, SELF_SEARCH_FAILURE } from "@/lib/self-search/errors";
import {
  SELF_SEARCH_PAGE_MAX,
  SELF_SEARCH_SOURCE_LABELS,
  hasSelfSearchNextPage,
  selfSearch,
} from "@/lib/self-search";
import {
  getKugouPlayUrl,
  normalizeKugouHash,
} from "@/lib/self-search/kugou";

export const runtime = "nodejs";

const DEFAULT_COUNT = 20;
const COUNT_MAX = 30;

function clampInt(value, fallback, min, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(n, max);
}

function normalizeCount(raw) {
  return clampInt(raw, DEFAULT_COUNT, 1, COUNT_MAX);
}

function normalizePage(raw) {
  return clampInt(raw, 1, 1, SELF_SEARCH_PAGE_MAX);
}

/**
 * 自研音乐接口（服务器直连各大音源，不经 GD 中转）：
 *   GET /api/music/self?action=search&source=netease|tencent|kugou|kuwo|migu&keyword=<关键词>&count=20&page=1
 *   GET /api/music/self?action=url&source=kugou&hash=<FileHash>&br=128     —— 酷狗官方试听直链
 *
 * action=search：source 键沿用 GD 通道命名（netease/tencent/kugou/kuwo/migu）。搜索结果与
 * /api/music 的 action=search 对齐统一契约 { code, msg, data }，items 为 SearchItem；其中能随
 * 搜索响应直接携带的封面写入 picUrlDirect（不做的封面二次换取，见 lib/self-search/index.js）。
 *
 * action=url：自研直连平台的「搜索产物 → 播放直链」通道（相当于 GD/lx 在自研源上的内置换链）。
 * 当前仅 kugou（官方 getSongInfo 免费档 128k mp3；VIP/付费曲返回 404+failType=vip-only）。
 * 直链带 CDN 时效不缓存；受 MUSIC_PLATFORM_PLAY 开关约束，关闭时 400。
 *
 * 进程内存 5 分钟缓存（search 成功才写）、IP 级限流与黑名单拦截与主接口一致。
 */
export async function GET(request) {
  const startTime = Date.now();
  const corsHeaders = getCorsHeaders(request.headers.get("origin") || "");
  const { searchParams } = new URL(request.url);

  const logSelf = (status, code, detail = "") =>
    console.log(
      `[music:self] time=${beijingNow()} code=${code} status=${status} duration=${
        Date.now() - startTime
      }ms${detail ? ` ${detail}` : ""}`
    );

  const send = (payload, status) =>
    Response.json(payload, { status, headers: corsHeaders });

  const clientIP = getClientIP(request);
  console.log(`[music:self] request from IP: ${clientIP}`);

  // IP 黑名单（蜜罐）：与统一入口行为一致
  if (isBlockedIP(clientIP)) {
    logger.warn(`黑名单 IP 命中蜜罐(music:self): ip=${clientIP}`);
    return send(normalizeResult(honeypotResponse("music")), 200);
  }

  // IP 级限流（60 次/分钟）
  if (!rateLimit(clientIP)) {
    logSelf("limited", 429);
    return send({ code: 429, msg: "请求过于频繁，请稍后再试" }, 429);
  }

  // —— 参数读取与校验 ——
  const action = (searchParams.get("action") || "search").trim().toLowerCase();
  if (action !== "search" && action !== "url") {
    return send(
      {
        code: 400,
        msg: `不支持的 action: ${action}（自研通道仅支持 search / url）`,
        usage:
          "/api/music/self?action=search&source=netease&keyword=<关键词> | ?action=url&source=kugou&hash=<FileHash>",
      },
      400
    );
  }

  // —— action=url：酷狗官方试听直链（自研源的内置换链） ——
  if (action === "url") {
    const source = String(searchParams.get("source") || "").trim().toLowerCase();
    if (source !== "kugou") {
      return send(
        {
          code: 400,
          msg: source
            ? `自研直连取链暂未支持 source: ${source}（当前仅支持 kugou，其余平台走 GD/lx 直链）`
            : "source 为空：请指定要取直链的音乐平台",
          supportedSources: [{ key: "kugou", label: "酷狗音乐" }],
          usage: "/api/music/self?action=url&source=kugou&hash=<FileHash>",
        },
        400
      );
    }
    if (!isPlatformPlayEnabled(source)) {
      return send(
        {
          code: 400,
          msg: `该平台播放引擎已停用：${source}（部署侧配置 MUSIC_PLATFORM_PLAY 可开启）`,
        },
        400
      );
    }
    const hash = normalizeKugouHash(searchParams.get("hash") || searchParams.get("id"));
    if (!hash) {
      return send(
        {
          code: 400,
          msg: "hash 为空或非法：请传酷狗搜索结果/分享链接的 FileHash（32 位十六进制）",
          usage: "/api/music/self?action=url&source=kugou&hash=<FileHash>",
        },
        400
      );
    }
    try {
      const { url, br, size } = await getKugouPlayUrl(hash);
      logSelf("url", 200, `source=kugou hash=${hash} br=${br}`);
      return send(
        {
          code: 200,
          msg: "获取直链成功",
          data: { url, br: br || 128, size: size || 0, source, id: hash },
        },
        200
      );
    } catch (error) {
      if (error instanceof SelfSearchError) {
        const isBiz = [SELF_SEARCH_FAILURE.NOT_FOUND, SELF_SEARCH_FAILURE.VIP_ONLY].includes(
          error.code
        );
        const status = isBiz ? 404 : 502;
        logSelf("url-failed", status, `source=kugou hash=${hash} failType=${error.code}`);
        return send({ code: status, msg: error.message, failType: error.code }, status);
      }
      logger.error(`music:self url unexpected error: ${error?.message || error}`);
      logSelf("url-failed", 502, `source=kugou hash=${hash}`);
      return send(
        {
          code: 502,
          msg: "酷狗取链暂不可用，请稍后重试",
          failType: SELF_SEARCH_FAILURE.SOURCES_DOWN,
        },
        502
      );
    }
  }

  const source = String(searchParams.get("source") || "")
    .trim()
    .toLowerCase();
  // 可启用集合 = 平台搜索引擎开关（MUSIC_PLATFORM_SEARCH）∩ 自研搜索注册表
  // （enabledPlatformList 含 joox 等 GD-only 平台，需用 SELF_SEARCH_SOURCE_LABELS 收窄）
  const enabledSources = enabledPlatformList("search").filter(
    (key) => SELF_SEARCH_SOURCE_LABELS[key] !== undefined
  );
  if (!isPlatformSearchEnabled(source) || !enabledSources.includes(source)) {
    return send(
      {
        code: 400,
        msg: source
          ? `该平台搜索引擎已停用或未支持：${source}（部署侧配置 MUSIC_PLATFORM_SEARCH 可开启）`
          : "source 为空：请指定要搜索的音乐平台",
        supportedSources: enabledSources.map((key) => ({
          key,
          label: SELF_SEARCH_SOURCE_LABELS[key],
        })),
        usage: "/api/music/self?action=search&source=netease&keyword=<关键词>",
      },
      400
    );
  }

  const keyword = String(
    (searchParams.get("keyword") ?? searchParams.get("name")) || ""
  ).trim();
  if (!keyword) {
    return send(
      {
        code: 400,
        msg: "keyword 为空：请输入要搜索的歌曲关键词（歌名 / 歌手等）",
        usage: "/api/music/self?action=search&source=netease&keyword=<关键词>",
      },
      400
    );
  }

  const count = normalizeCount(searchParams.get("count"));
  const page = normalizePage(searchParams.get("page"));

  // 5 分钟进程内存缓存（仅成功结果写缓存）
  const key = `selfsearch:${source}:${keyword}:${count}:${page}`;
  const cached = getCachedResponse(key);
  if (cached) {
    logSelf("cached-search", 200, `source=${source} keyword=${keyword}`);
    return send(cached, 200);
  }

  let payload;
  let status = 200;
  try {
    const { items, total } = await selfSearch(source, keyword, page, count);
    const hasMore = hasSelfSearchNextPage({
      page,
      limit: count,
      read: items.length,
      total,
    });
    payload = {
      code: 200,
      msg: "搜索成功",
      data: {
        source,
        keyword,
        page,
        hasMore,
        count: items.length,
        total,
        items,
        // 自研直连通道的线路标注（区别于 GD 的 proxy/direct）
        line: { kind: "self", base: "self-search" },
      },
    };
  } catch (error) {
    if (error instanceof SelfSearchError) {
      const isSourceUnavailable = error.code === SELF_SEARCH_FAILURE.SOURCE_UNAVAILABLE;
      status = isSourceUnavailable ? 400 : 502;
      payload = {
        code: status,
        msg: error.message || "搜索源暂不可用，请稍后重试",
        failType: error.code,
      };
      logSelf("search-failed", status, `source=${source} failType=${error.code}`);
      return send(payload, status);
    }
    logger.error(`music:self unexpected error: ${error?.message || error}`);
    payload = {
      code: 502,
      msg: "搜索源暂不可用，请稍后重试",
      failType: SELF_SEARCH_FAILURE.SOURCES_DOWN,
    };
    status = 502;
    logSelf("search-failed", 502, `source=${source}`);
    return send(payload, status);
  }

  setCacheResponse(key, payload);
  logSelf("search", 200, `source=${source} keyword=${keyword}`);
  return send(payload, status);
}
