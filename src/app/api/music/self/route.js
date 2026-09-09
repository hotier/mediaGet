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
import { SelfSearchError, SELF_SEARCH_FAILURE } from "@/lib/self-search/errors";
import {
  SELF_SEARCH_PAGE_MAX,
  SELF_SEARCH_SOURCE_LABELS,
  SELF_SEARCH_SOURCE_LIST,
  hasSelfSearchNextPage,
  selfSearch,
} from "@/lib/self-search";

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
 * 自研音乐搜索接口（服务器直连各大音源，不经 GD 中转）：
 *   GET /api/music/self?action=search&source=netease|tencent|kugou|kuwo|migu&keyword=<关键词>&count=20&page=1
 *
 * source 键沿用 GD 通道命名（netease/tencent/kugou/kuwo/migu）。搜索结果与 /api/music
 * 的 action=search 对齐统一契约 { code, msg, data }，items 为 SearchItem；其中能随
 * 搜索响应直接携带的封面写入 picUrlDirect（不做的封面二次换取，见 lib/self-search/index.js）。
 * 仅支持 search 动作；播放/歌词/封面仍走既有 GD / lx 通道。
 * 进程内存 5 分钟缓存（成功才写）、IP 级限流与黑名单拦截与主接口一致。
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
  if (action !== "search") {
    return send(
      {
        code: 400,
        msg: `不支持的 action: ${action}（自研搜索通道仅支持 search）`,
        usage: "/api/music/self?action=search&source=netease&keyword=<关键词>&count=20&page=1",
      },
      400
    );
  }

  const source = String(searchParams.get("source") || "")
    .trim()
    .toLowerCase();
  if (!SELF_SEARCH_SOURCE_LIST.includes(source)) {
    return send(
      {
        code: 400,
        msg: `自研搜索暂未支持该 source：${source || "（为空）"}`,
        supportedSources: SELF_SEARCH_SOURCE_LIST.map((key) => ({
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
