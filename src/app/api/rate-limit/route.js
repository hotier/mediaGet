import { getRateLimitStatus, getClientIP, getCorsHeaders, logger } from "@/lib/api-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 查询当前客户端 IP 的 per-IP 限流状况（只读，不消耗配额）。
 * 返回 { used, limit, remaining, resetsInMs }，窗口 60 秒 / 上限 60 次。
 */
export async function GET(request) {
  const corsHeaders = getCorsHeaders(request.headers.get("origin") || "");
  const clientIP = getClientIP(request);
  // dev 排查用：确认限流查询用的是哪个 IP 的桶（应与解析计数一致）
  logger.log("rate-limit query IP:", clientIP);
  const data = getRateLimitStatus(clientIP);
  return Response.json(
    { code: 0, msg: "ok", data },
    {
      status: 200,
      headers: {
        ...corsHeaders,
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    }
  );
}
