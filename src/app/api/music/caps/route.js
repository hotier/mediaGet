import {
  beijingNow,
  getClientIP,
  getCorsHeaders,
  logger,
  rateLimit,
} from "@/lib/api-utils";
import { honeypotResponse } from "@/lib/honeypot";
import { normalizeResult } from "@/lib/normalize-result";
import {
  MUSIC_FLAG_PLATFORM_KEYS,
  MUSIC_PLATFORM_DEFAULT_FLAGS,
  resolveMusicPlatformFlags,
} from "@/lib/music-platform-flags";

export const runtime = "nodejs";

/**
 * 音乐平台能力矩阵接口：
 *   GET /api/music/caps
 *
 * 供前端（MusicExplorer）在启动时同步部署期的「平台搜索引擎 / 播放引擎」开关
 * （MUSIC_PLATFORM_SEARCH / MUSIC_PLATFORM_PLAY），用于过滤搜索源 chips、跨源现搜候选、
 * 以及对「引擎已停用平台」的取链/解析前置。前端在拉取成功前使用与后端一致的默认矩阵，
 * 拉取失败/未到达时保持默认（与引擎实际行为一致）。
 *
 * 响应 data：
 *   - defaults: { search, play } 内置默认矩阵（未覆盖时为生效值）；
 *   - flags:    { search, play } 生效矩阵（默认 + env 覆盖）；
 *   - platforms: 平台列表 [{ key, search, play, label, selfSearch: bool }]，
 *                selfSearch=true 表示该平台有自研搜索实现（/api/music/self）。
 * 仅读操作、低频，不做结果缓存；限流/黑名单与主接口一致。
 */
export async function GET(request) {
  const startTime = Date.now();
  const corsHeaders = getCorsHeaders(request.headers.get("origin") || "");
  const clientIP = getClientIP(request);

  if (isBlockedIP(clientIP)) {
    logger.warn(`黑名单 IP 命中蜜罐(music:caps): ip=${clientIP}`);
    return Response.json(normalizeResult(honeypotResponse("music")), {
      status: 200,
      headers: corsHeaders,
    });
  }
  if (!rateLimit(clientIP)) {
    return Response.json(
      { code: 429, msg: "请求过于频繁，请稍后再试" },
      { status: 429, headers: corsHeaders }
    );
  }

  const searchFlags = resolveMusicPlatformFlags("search");
  const playFlags = resolveMusicPlatformFlags("play");

  const body = {
    code: 200,
    msg: "ok",
    data: {
      defaults: MUSIC_PLATFORM_DEFAULT_FLAGS,
      flags: { search: searchFlags, play: playFlags },
      platforms: MUSIC_FLAG_PLATFORM_KEYS.map((key) => ({
        key,
        search: searchFlags[key] === true,
        play: playFlags[key] === true,
        // 是否有自研搜索实现（/api/music/self 注册表收录的平台才可被 chips 中的独立搜索触达）
        selfSearch: ["netease", "tencent", "kugou", "kuwo", "migu"].includes(
          key
        ),
      })),
    },
  };
  console.log(
    `[music:caps] time=${beijingNow()} code=200 status=ok duration=${
      Date.now() - startTime
    }ms ip=${clientIP}`
  );
  return Response.json(body, { status: 200, headers: corsHeaders });
}
