/**
 * 视频代理 URL 工具：判断视频直链是否需要走 /api/video-proxy 代理。
 *
 * 背景：
 * - 小红书 xhscdn 视频 CDN 有 Referer 防盗链，直链在新窗口打开/播放会 403。
 * - 抖音 aweme/v1/play 接口（www.douyin.com / www.iesdouyin.com）302 跳转到
 *   CDN，浏览器直连时因 Referer 非 douyin.com 会被 403 拒，同样需要走代理
 *   （服务器带 Referer: douyin.com 转发，并支持 Range 拖动进度条）。
 * 微博 weibocdn 视频 CDN 同样有 Referer 防盗链（无 Referer 403），
 * 播放/下载统一走代理（服务端带 Referer: weibo.com）。
 * X/Twitter 的 video.twimg.com 恰好相反：非 x.com 来源页的 Referer 会被 403
 * 拒绝（浏览器直链播放必带页面 Referer），必须走代理（服务端不带 Referer 转发）。
 * YouTube 媒体域（googlevideo / Piped 实例的 pipedproxy 代理域）没有 Referer
 * 防盗链，但国内网络直连被墙 —— 统一走服务端转发（海外部署可达上游），保证
 * YouTube「直链播放」兜底与下载在全网络环境下可用。
 * 其他平台（B站/快手等）直链通常可正常播放，无需代理。
 */

/** 需要走代理的 CDN 主机（Referer 防盗链 / 网络不可达） */
const PROXY_HOST_SUFFIXES = [
  ".xhscdn.com",
  "xhscdn.com",
  ".douyin.com",
  "douyin.com",
  ".iesdouyin.com",
  "iesdouyin.com",
  ".douyinvod.com",
  "douyinvod.com",
  ".snssdk.com",
  "snssdk.com",
  ".weibocdn.com",
  "weibocdn.com",
  ".twimg.com",
  "twimg.com",
  // YouTube 媒体域（无防盗链，因网络可达性走代理）
  ".googlevideo.com",
  "googlevideo.com",
];

/** 判断视频 URL 是否需要走代理 */
export function needsVideoProxy(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    // Piped 实例的流媒体代理域子域形态不固定（pipedproxy.xxx / pipedproxy-xxx.xxx），
    // 用包含判断；与 googlevideo 同因（网络可达性）走服务端转发
    if (hostname.includes("pipedproxy")) return true;
    return PROXY_HOST_SUFFIXES.some((s) => hostname === s || hostname.endsWith(s));
  } catch {
    return false;
  }
}

/** 生成视频代理 URL（无需代理时原样返回） */
export function buildVideoProxyUrl(url: string): string {
  if (!needsVideoProxy(url)) return url;
  return `/api/video-proxy?url=${encodeURIComponent(url)}`;
}