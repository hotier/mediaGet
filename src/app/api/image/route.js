/**
 * 通用图片代理：解决第三方图床（小红书 sns-webpic、sns-avatar-qc 等）的
 * Referer 防盗链。这些 CDN 在 https 来源页面上直链加载会 403。
 *
 * 用法：GET /api/image?url=<encodeURIComponent(原图 URL)>
 *
 * - 小红书 xhscdn 图床：fetch 时带 Referer: https://www.xiaohongshu.com/
 * - 其他图床：直接 fetch（不强制 Referer，避免误伤）
 * - 内存 LRU 缓存 6 小时（图床 URL 不变，重复请求免重复 fetch）
 * - 10MB 上限保护
 * - 透传 Content-Type，加 Cache-Control: public, max-age=21600
 */
export const runtime = "nodejs";

import { isBlockedIP, getClientIP, logger } from "@/lib/api-utils";

const cache = new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_BYTES = 10 * 1024 * 1024;

function isXhsHost(hostname) {
  return hostname === "xhscdn.com" || hostname.endsWith(".xhscdn.com");
}

/** 微博图床（sinaimg / weibocdn）：防盗链必须带 weibo Referer，否则 403 */
function isWeiboHost(hostname) {
  return (
    hostname === "sinaimg.cn" ||
    hostname.endsWith(".sinaimg.cn") ||
    hostname === "weibocdn.com" ||
    hostname.endsWith(".weibocdn.com")
  );
}

/** 快手图床（yximgs / kwimgs）：防盗链必须带 kuaishou Referer，否则 403 */
function isKuaishouHost(hostname) {
  return (
    hostname.endsWith(".yximgs.com") ||
    hostname.endsWith(".kwimgs.com") ||
    hostname.endsWith(".kwaicdn.com")
  );
}

/** 根据图床域名返回防盗链所需的 Referer（无特殊要求的返回 null） */
function refererFor(hostname) {
  if (isXhsHost(hostname)) return "https://www.xiaohongshu.com/";
  if (isWeiboHost(hostname)) return "https://weibo.com/";
  if (isKuaishouHost(hostname)) return "https://www.kuaishou.com/";
  return null;
}

export async function GET(request) {
  // IP 黑名单：图片代理返回二进制图片，无法套用解析接口的 JSON 蜜罐，
  // 此处对黑名单 IP 保持 403（图片代理只是前端加载资源的通道，不承载解析宣传）。
  const clientIP = getClientIP(request);
  if (isBlockedIP(clientIP)) {
    logger.warn(`黑名单 IP 被拦截(image): ip=${clientIP}`);
    return new Response("Forbidden", { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const encoded = searchParams.get("url");
  if (!encoded) return new Response("Missing url", { status: 400 });

  // 候选列表 = 主 URL + CDN 备选（fallback：逗号分隔的 encodeURIComponent URL）。
  // 快手头像同一资源有多个 CDN 节点，实测部分节点 DNS 解析失败（如 p2-pro），
  // 按序重试直至成功，提高图片可加载率。
  const candidates = [];
  try {
    candidates.push(new URL(decodeURIComponent(encoded)));
  } catch {
    return new Response("Invalid url", { status: 400 });
  }
  if (!/^https?:$/.test(candidates[0].protocol)) {
    return new Response("Only http(s) allowed", { status: 400 });
  }
  const fallbackParam = searchParams.get("fallback");
  if (fallbackParam) {
    for (const part of fallbackParam.split(",")) {
      if (!part) continue;
      try {
        const u = new URL(decodeURIComponent(part));
        if (/^https?:$/.test(u.protocol)) candidates.push(u);
      } catch {
        // 忽略非法备选
      }
    }
  }

  const cacheKey = candidates[0].href;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return new Response(cached.buffer, {
      headers: {
        "Content-Type": cached.contentType,
        "Cache-Control": "public, max-age=21600",
      },
    });
  }

  let lastError = "Upstream error";
  for (const candidate of candidates) {
    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0",
      Accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8",
    };
    // 图床防盗链：按当前候选的域名决定 Referer
    const referer = refererFor(candidate.hostname);
    if (referer) headers.Referer = referer;

    let upstream;
    try {
      upstream = await fetch(candidate.href, {
        headers,
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      lastError = `Upstream fetch failed: ${e.message}`;
      continue;
    }
    if (!upstream.ok) {
      lastError = `Upstream error: ${upstream.status}`;
      continue;
    }

    const arrayBuffer = await upstream.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length > MAX_BYTES) {
      return new Response("Image too large", { status: 413 });
    }

    const contentType = upstream.headers.get("content-type") || "image/jpeg";
    cache.set(cacheKey, {
      buffer,
      contentType,
      expires: Date.now() + CACHE_TTL_MS,
    });

    return new Response(buffer, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=21600",
      },
    });
  }
  return new Response(lastError, { status: 502 });
}