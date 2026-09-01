/**
 * 通用视频代理：解决第三方视频 CDN（小红书 xhscdn 等）的 Referer 防盗链。
 * 这些 CDN 在 https 来源页面上直链加载/新窗口打开会 403，导致无法播放和下载。
 *
 * 用法：
 * - 播放：GET /api/video-proxy?url=<encodeURIComponent(原视频 URL)>
 * - 下载：GET /api/video-proxy?url=...&download=1&filename=<encodeURIComponent(文件名.mp4)>
 *
 * - 小红书 xhscdn 视频 CDN：fetch 时带 Referer: https://www.xiaohongshu.com/
 * - 其他视频源：直接 fetch（不强制 Referer，避免误伤）
 * - 支持 Range 请求（浏览器播放/拖动进度条必须），透传 206 Partial Content
 * - download=1 时设置 Content-Disposition: attachment，强制浏览器下载文件而非播放
 * - 流式转发，不整段缓存到内存，避免大视频占用内存
 * - 透传 Content-Type / Content-Length / Accept-Ranges
 * - 超时策略：首字节 30s 快速失败；传输中不设总时长上限（大视频弱网可能传很久），
 *   仅在持续 30s 无新数据时判定上游挂起并中止；客户端断开时同步中止上游
 */
export const runtime = "nodejs";

import { isBlockedIP, getClientIP, logger } from "@/lib/api-utils";

function isXhsHost(hostname) {
  return hostname === "xhscdn.com" || hostname.endsWith(".xhscdn.com");
}

/** 抖音系主机（aweme/v1/play 接口及 CDN）：带 douyin Referer 防 403 */
function isDouyinHost(hostname) {
  return (
    hostname === "douyin.com" ||
    hostname.endsWith(".douyin.com") ||
    hostname === "iesdouyin.com" ||
    hostname.endsWith(".iesdouyin.com") ||
    hostname === "douyinvod.com" ||
    hostname.endsWith(".douyinvod.com") ||
    hostname === "snssdk.com" ||
    hostname.endsWith(".snssdk.com")
  );
}

/** 微博视频 CDN（weibocdn 等）：防盗链必须带 weibo Referer，否则 403 */
function isWeiboHost(hostname) {
  return (
    hostname === "weibocdn.com" ||
    hostname.endsWith(".weibocdn.com") ||
    hostname === "sinaimg.cn" ||
    hostname.endsWith(".sinaimg.cn")
  );
}

/** X/Twitter 视频 CDN：拒绝「到末尾」的开放区间 Range（bytes=0- / bytes=N-） */
function isTwimgHost(hostname) {
  return hostname === "twimg.com" || hostname.endsWith(".twimg.com");
}

/**
 * 判断 Range 是否为「到末尾」的开放区间（无结束字节，如 bytes=0- / bytes=N-）。
 * 浏览器 <video> 的首次加载请求正是 bytes=0-，X 的 video.twimg.com 对这类请求
 * 会直接重置连接/拒绝（403），导致内嵌播放「无法播放媒体」；有限区间
 * （bytes=a-b，播放器 seek 精确定位）则正常支持。非标准 Range 按开放处理。
 */
function isOpenEndedRange(range) {
  const m = /^bytes=(\d*)-(\d*)$/i.exec((range || "").trim());
  if (!m) return true;
  return m[2] === "";
}

export async function GET(request) {
  // IP 黑名单：视频代理返回二进制流，无法套用解析接口的 JSON 蜜罐，
  // 此处对黑名单 IP 保持 403（视频代理只是前端加载资源的通道，不承载解析宣传）。
  const clientIP = getClientIP(request);
  if (isBlockedIP(clientIP)) {
    logger.warn(`黑名单 IP 被拦截(video-proxy): ip=${clientIP}`);
    return new Response("Forbidden", { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const encoded = searchParams.get("url");
  if (!encoded) return new Response("Missing url", { status: 400 });

  // 下载模式：download=1 时响应带 Content-Disposition: attachment 强制保存文件
  const download = searchParams.get("download") === "1";
  // 下载文件名（可选，需自行 encodeURIComponent），过滤不安全字符
  const filenameParam = searchParams.get("filename") || "";
  const safeFilename =
    filenameParam
      .replace(/[\\/:*?"<>|\r\n]/g, "_")
      .replace(/\.{2,}/g, "_")
      .replace(/[^\w.\-\u4e00-\u9fa5 ]/g, "_")
      .replace(/[.\s]+$/g, "")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .trim()
      .slice(0, 120) || "video.mp4";

  let target;
  try {
    target = new URL(decodeURIComponent(encoded));
  } catch {
    return new Response("Invalid url", { status: 400 });
  }
  if (!/^https?:$/.test(target.protocol)) {
    return new Response("Only http(s) allowed", { status: 400 });
  }

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0",
    Accept: "video/mp4,video/*;q=0.9,*/*;q=0.8",
  };
  // 小红书视频 CDN 防盗链：必须 Referer: xiaohongshu.com，否则 403
  if (isXhsHost(target.hostname)) {
    headers.Referer = "https://www.xiaohongshu.com/";
  }
  // 抖音 play 接口 / CDN：带 douyin Referer 防 403
  if (isDouyinHost(target.hostname)) {
    headers.Referer = "https://www.douyin.com/";
  }
  // 微博视频 CDN：带 weibo Referer 防 403
  if (isWeiboHost(target.hostname)) {
    headers.Referer = "https://weibo.com/";
  }

  // 透传客户端的 Range 头（浏览器播放/拖动进度条必需）。
  // twimg 特殊：开放区间 Range（bytes=0- / bytes=N-）会被上游拒绝（重置连接），
  // 浏览器 <video> 首次加载正是 bytes=0- —— 对 twimg 忽略开放区间 Range，
  // 让上游返回 200 完整文件可正常播放；有限区间（seek 精确定位）照常透传。
  const range = request.headers.get("range");
  if (range && !(isTwimgHost(target.hostname) && isOpenEndedRange(range))) {
    headers.Range = range;
  }

  const FIRST_BYTE_TIMEOUT_MS = 30000;
  const FIRST_BYTE_TIMEOUT = new Error("first-byte timeout");
  // twimg 连接不稳定（间歇性重置/首字节超时/403）：用更短首字节超时 + 失败重试，
  // 瞬时失败重试大概率恢复，显著提升 X 视频内嵌播放成功率。
  const isTwimg = isTwimgHost(target.hostname);
  const TWIMG_FIRST_BYTE_TIMEOUT_MS = 8000;
  const MAX_TWIMG_ATTEMPTS = 3; // 含首次，最多 3 次尝试

  // 首字节超时：只覆盖到收到上游响应头为止。
  // 不能用 AbortSignal.timeout() 一刀切——它会连同 body 流一起掐断，
  // 大视频传输超过 30s 就会在中途断流（failed to pipe response / TimeoutError）。
  const maxAttempts = isTwimg ? MAX_TWIMG_ATTEMPTS : 1;
  let upstream = null;
  let upstreamError = null;
  let attemptController = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      // 短暂退避后重试
      await new Promise((r) => setTimeout(r, 400 * (attempt - 1)));
    }
    attemptController = new AbortController();
    const attemptTimeout = setTimeout(
      () => attemptController.abort(FIRST_BYTE_TIMEOUT),
      isTwimg ? TWIMG_FIRST_BYTE_TIMEOUT_MS : FIRST_BYTE_TIMEOUT_MS
    );
    // 客户端断开（关页面 / 播放器换 Range 重新请求）时中止上游，避免后台白拉流量
    request.signal.addEventListener(
      "abort",
      () => attemptController.abort(new Error("client aborted")),
      { once: true }
    );
    try {
      upstream = await fetch(target.href, {
        headers,
        signal: attemptController.signal,
      });
      clearTimeout(attemptTimeout);
      if (upstream.ok || upstream.status === 206) break;
      upstreamError = new Error(`upstream status ${upstream.status}`);
      // 非 2xx：twimg 可能瞬时 403，重试；其他 host 立即失败
      if (!isTwimg) break;
    } catch (e) {
      clearTimeout(attemptTimeout);
      upstreamError = e;
      if (request.signal.aborted) break; // 客户端已断开，不再重试
      if (!isTwimg && attemptController.signal.reason === FIRST_BYTE_TIMEOUT) break;
      // twimg 的瞬时失败（重置/超时/403）继续下一轮重试
    }
  }

  if (!upstream) {
    if (request.signal.aborted) {
      logger.warn(`video-proxy 客户端中断: host=${target.hostname}`);
      return new Response("Client aborted", { status: 499 });
    }
    if (attemptController?.signal.reason === FIRST_BYTE_TIMEOUT) {
      logger.warn(`video-proxy 上游首字节超时: host=${target.hostname}`);
      return new Response("Upstream timeout", { status: 504 });
    }
    logger.error(`video-proxy upstream fetch failed: ${upstreamError?.message}`);
    return new Response(`Upstream fetch failed: ${upstreamError?.message}`, {
      status: 502,
    });
  }
  // 响应头已到，首字节超时完成使命，传输阶段改用空闲超时
  if (!upstream.ok && upstream.status !== 206) {
    logger.warn(`video-proxy upstream error: ${upstream.status} url=${target.hostname}`);
    return new Response(`Upstream error: ${upstream.status}`, {
      status: 502,
    });
  }

  // 空闲超时：传输中只要数据还在流动就放行，持续 30s 无新数据才中止
  // timer 在重试重构中随旧声明一并删除，这里显式声明（严格模式下赋值未声明变量会抛 ReferenceError）
  let timer;
  const armIdleTimer = () => {
    timer = setTimeout(
      () => attemptController.abort(new Error("upstream idle timeout")),
      FIRST_BYTE_TIMEOUT_MS
    );
  };
  armIdleTimer();
  const bodyGuard = new TransformStream({
    transform(chunk, controller) {
      clearTimeout(timer);
      armIdleTimer();
      controller.enqueue(chunk);
    },
    flush() {
      clearTimeout(timer);
    },
  });

  const contentType =
    upstream.headers.get("content-type") || "video/mp4";
  const contentLength = upstream.headers.get("content-length");
  const acceptRanges = upstream.headers.get("accept-ranges");

  const responseHeaders = {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=3600",
    "Accept-Ranges": acceptRanges || "bytes",
  };
  if (contentLength) {
    responseHeaders["Content-Length"] = contentLength;
  }
  // 下载模式：Content-Disposition 用 ASCII fallback + RFC 5987 编码，支持中文文件名
  if (download) {
    responseHeaders["Content-Disposition"] = `attachment; filename="video.mp4"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`;
  }
  // 透传 206 的 Content-Range（Range 请求时上游会返回）
  const contentRange = upstream.headers.get("content-range");
  if (contentRange) {
    responseHeaders["Content-Range"] = contentRange;
  }

  return new Response(upstream.body.pipeThrough(bodyGuard), {
    status: upstream.status,
    headers: responseHeaders,
  });
}