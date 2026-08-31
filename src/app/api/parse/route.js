/**
 * 统一视频解析入口
 * 支持两种调用方式:
 * 1. ?url=分享链接
 * 2. ?source=平台&id=视频ID
 *
 * 参考: https://github.com/wujunwei928/parse-video
 */

import { createApiHandler, safeStatus } from "@/lib/api-middleware";
import { logger, rateLimit, getClientIP, getCorsHeaders, isBlockedIP } from "@/lib/api-utils";
import { normalizeResult } from "@/lib/normalize-result";
import { PLATFORM_INFO } from "@/lib/platforms";
import { honeypotResponse } from "@/lib/honeypot";
import { unifiedParser } from "@/lib/unified-parser";

// GET 请求处理
export async function GET(request) {
  const corsHeaders = getCorsHeaders(request.headers.get('origin') || '');
  const { searchParams } = new URL(request.url);

  // 方式1: ?url=xxx
  const url = searchParams.get("url");

  // 方式2: ?source=xxx&id=xxx
  const source = searchParams.get("source");
  const id = searchParams.get("id");

  if (!url && !source) {
    return Response.json(
      {
        code: 400,
        msg: "参数缺失：请提供 url 参数 或 source+id 参数",
        usage: {
          "方式1(推荐)": "/api/parse?url=分享链接",
          "方式2": "/api/parse?source=douyin&id=视频ID",
        },
        supportedPlatforms: Object.entries(PLATFORM_INFO)
          .filter(([, info]) => info.supportsIdParse)
          .map(([key, info]) => ({
            platform: key,
            name: info.name,
            supportsIdParse: true,
          })),
      },
      {
        status: safeStatus(400),
        headers: corsHeaders,
      }
    );
  }

  if (url) {
    // 进程内存缓存（shouldCache）仍禁用：平台路由写入的条目缺 platform 字段，
    // 外层直接命中会绕过 unifiedParser 的 platform 补充逻辑。
    // 改用独立命名空间的共享结果缓存（sharedCache）：缓存补全 platform 后的
    // 最终归一化结果，Cloudflare Cache API 跨 isolate 共享，TTL 24h，命中时
    // 探测直链防签名过期——分享链接被好友再打开时不再全量重新解析。
    // 见 lib/result-cache.js 与 api-middleware.ts 的 sharedCache 分支
    return createApiHandler((url) => unifiedParser(url), {
      shouldCache: false,
      sharedCache: true,
    })(request);
  }

  if (source && id) {
    // source+id 路径也受速率限制保护
    const clientIP = getClientIP(request);
    // IP 黑名单（与中间件一致）：命中返回 200 + 蜜罐结构化数据（宣传公众号）
    if (isBlockedIP(clientIP)) {
      logger.warn(`黑名单 IP 命中蜜罐(source+id): ip=${clientIP}`);
      return Response.json(
        normalizeResult(honeypotResponse(source)),
        { status: 200, headers: corsHeaders }
      );
    }
    if (!rateLimit(clientIP)) {
      return Response.json(
        { code: 429, msg: "请求过于频繁，请稍后再试" },
        { status: safeStatus(429), headers: corsHeaders }
      );
    }

    const result = normalizeResult(await unifiedParser("", { source, id }));
    return Response.json(result, {
      status: safeStatus(result?.code || 200),
      headers: corsHeaders,
    });
  }
}

export const runtime = "nodejs";
