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

export const runtime = "nodejs";

const UPSTREAM_BASE = "https://api.amll.dev";
const UPSTREAM_TIMEOUT_MS = 8000;

/**
 * AMLL 词库（amll.dev）逐字歌词代理：
 *   GET /api/music/amll?source=netease|tencent&id=<平台歌曲ID>
 *
 * source → 词库平台参数：netease→ncmMusicId（网易云歌曲数字 ID）、
 * tencent→qqMusicId（QQ 歌曲 songmid）。
 *
 * 词库公开免鉴权（按 IP ~50req/s），但返回的 TTML 带逐字时间戳，命中后由
 * 前端 ttml-amll.ts 解析成 AMLL 行（真逐字扫亮 + 翻译）。这里在服务器侧代理：
 * 1) 复用本项目的 IP 黑名单/限流/日志，避免把第三方依赖直接暴露给用户 UA；
 * 2) 复用 api-utils 的 5 分钟内存缓存（同一首歌词内容固定，重复播放不再打上游）。
 *
 * 未收录返回 { code: 404 }；上游异常返回 { code: 502 }。均不写缓存。
 */
export async function GET(request) {
  const startTime = Date.now();
  const corsHeaders = getCorsHeaders(request.headers.get("origin") || "");
  const { searchParams } = new URL(request.url);

  const logAmll = (status, code, detail = "") =>
    console.log(
      `[music:amll] time=${beijingNow()} code=${code} status=${status} duration=${
        Date.now() - startTime
      }ms${detail ? ` ${detail}` : ""}`
    );

  const send = (payload, status) =>
    Response.json(payload, { status, headers: corsHeaders });

  const clientIP = getClientIP(request);
  console.log(`[music:amll] request from IP: ${clientIP}`);

  if (isBlockedIP(clientIP)) {
    logger.warn(`黑名单 IP 命中蜜罐(music:amll): ip=${clientIP}`);
    return send(normalizeResult(honeypotResponse("music")), 200);
  }

  if (!rateLimit(clientIP)) {
    logAmll("limited", 429);
    return send({ code: 429, msg: "请求过于频繁，请稍后再试" }, 429);
  }

  const SUPPORTED_SOURCES = Object.freeze({
    netease: "ncmMusicId",
    tencent: "qqMusicId",
  });

  const source = String(searchParams.get("source") || "")
    .trim()
    .toLowerCase();
  const platformParam = SUPPORTED_SOURCES[source];
  if (!platformParam) {
    return send(
      {
        code: 400,
        msg: source
          ? `该播放源暂未接入词库逐字匹配：${source}（仅支持 netease / tencent）`
          : "source 为空：请指定歌词来源平台",
        supportedSources: Object.entries(SUPPORTED_SOURCES).map(([key]) => ({
          key,
        })),
        usage: "/api/music/amll?source=netease&id=<网易云歌曲ID>",
      },
      400
    );
  }

  const id = String(searchParams.get("id") || "").trim();
  if (!id) {
    return send(
      {
        code: 400,
        msg: "id 为空：请传入该平台的歌曲 ID（netease 传网易云歌曲 ID / tencent 传 songmid）",
        usage: `/api/music/amll?source=${source}&id=<歌曲ID>`,
      },
      400
    );
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    return send({ code: 400, msg: "id 格式不合法（仅允许字母数字与 - _）" }, 400);
  }

  const upstreamUrl = `${UPSTREAM_BASE}/v1/lyrics/get?${encodeURIComponent(
    platformParam
  )}=${encodeURIComponent(id)}`;
  const cached = getCachedResponse(upstreamUrl);
  if (cached) {
    logAmll(200, 200, `source=${source} id=${id} cache=hit`);
    return send({ code: 200, msg: "获取逐字歌词成功", data: cached }, 200);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const onRequestAbort = () => controller.abort();
  request.signal?.addEventListener("abort", onRequestAbort, { once: true });

  try {
    const res = await fetch(upstreamUrl, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (controller.signal.aborted) {
      logAmll(408, 408, `source=${source} id=${id} upstream-timeout`);
      return send({ code: 408, msg: "词库请求超时，请稍后重试" }, 408);
    }
    if (!res.ok) {
      logAmll(res.status, res.status, `source=${source} id=${id} upstream-http`);
      if (res.status === 404 || res.status === 400) {
        return send({ code: 404, msg: "词库未收录该歌曲的逐字歌词", data: null }, 404);
      }
      return send({ code: 502, msg: "词库服务暂不可用，请稍后重试" }, 502);
    }

    const payload = await res.json().catch(() => null);
    const lyric = payload?.data?.lyrics;
    if (!payload || typeof lyric !== "string" || !lyric.trim()) {
      logAmll(404, 404, `source=${source} id=${id} lyric-miss`);
      return send({ code: 404, msg: "词库未收录该歌曲的逐字歌词", data: null }, 404);
    }

    const data = { source, id, lyric };
    setCacheResponse(upstreamUrl, data);
    logAmll(200, 200, `source=${source} id=${id} lyric-len=${lyric.length}`);
    return send({ code: 200, msg: "获取逐字歌词成功", data }, 200);
  } catch (error) {
    const timedOut = controller.signal.aborted;
    logger.error(
      `music:amll upstream error: ${error?.message || error}${timedOut ? " (timeout)" : ""}`
    );
    logAmll(timedOut ? 408 : 502, timedOut ? 408 : 502, `source=${source} id=${id}`);
    return send(
      { code: timedOut ? 408 : 502, msg: "词库请求失败，请稍后重试" },
      timedOut ? 408 : 502
    );
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onRequestAbort);
  }
}
