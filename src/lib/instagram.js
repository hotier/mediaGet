/**
 * Instagram 解析：帖子/Reels/图集
 *
 * 背景（2026-09 实测）：Instagram 已对匿名访客全面开启登录墙，
 * www.instagram.com 的帖子页对未登录请求只返回 App 外壳（无 og:image、
 * 无 _sharedData 媒体数据，偶见 checkpoint）。因此该解析器：
 *  1. 优先尝试匿名直接抓取（部分网络出口/内容仍可能命中开放数据）；
 *  2. 读取服务端配置的 IG_COOKIE（浏览器登录态 sessionid Cookie）后再抓取，
 *     命中率最高；
 *  3. 两者都拿不到媒体时，返回明确提示（需要配置 Cookie / 帖子私密）。
 */

import { logger } from "@/lib/api-utils";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
// 部署侧配置浏览器登录后的 sessionid Cookie（示例："sessionid=xxx; mid=yyy"）
const IG_COOKIE = process.env.IG_COOKIE || "";
const FETCH_TIMEOUT_MS = Number(process.env.IG_TIMEOUT_MS || 20000);

/** 从 Instagram 各类链接中提取短码，失败返回 null */
export function extractShortcode(url) {
  if (!url) return null;
  const str = String(url);
  const m = str.match(
    /instagram\.com\/(?:p|reel|reels|tv|share)\/([A-Za-z0-9_-]+)/i
  );
  if (m) return m[1];
  const m2 = str.match(/instagr\.am\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
  return m2 ? m2[1] : null;
}

/**
 * 从 <script> 起始标记后提取完整 JSON 对象（花括号配对扫描，防字符串内干扰）
 */
export function extractJsonObject(html, marker) {
  if (!html) return null;
  const start = html.indexOf(marker);
  if (start < 0) return null;
  const openIdx = html.indexOf("{", start);
  if (openIdx < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openIdx; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return html.slice(openIdx, i + 1);
    }
  }
  return null;
}

function largestDisplayUrl(node) {
  if (!node) return "";
  if (node.display_url) return node.display_url;
  if (Array.isArray(node.display_resources) && node.display_resources.length) {
    return [...node.display_resources].sort(
      (a, b) => (b.config_width || 0) - (a.config_width || 0)
    )[0].src;
  }
  return node.thumbnail_src || "";
}

function videoUrl(node) {
  if (!node) return "";
  if (node.video_url) return node.video_url;
  if (Array.isArray(node.video_versions) && node.video_versions.length) {
    return [...node.video_versions].sort(
      (a, b) => (b.width || 0) - (a.width || 0)
    )[0].url;
  }
  return "";
}

function captionOf(media) {
  const text =
    media?.edge_media_to_caption?.edges?.[0]?.node?.text ||
    media?.accessibility_caption ||
    media?.title ||
    "";
  return text.trim();
}

/**
 * 从帖子 HTML 中提取媒体数据（_sharedData 或 __additionalDataLoaded），
 * 返回 IG 媒体节点；失败返回 null。
 */
export function extractPostMedia(html) {
  if (!html) return null;

  const sharedRaw = extractJsonObject(html, "window._sharedData = ");
  if (sharedRaw) {
    try {
      const shared = JSON.parse(sharedRaw);
      const media =
        shared?.entry_data?.PostPage?.[0]?.graphql?.shortcode_media || null;
      if (media) return media;
    } catch {
      /* 继续尝试下一来源 */
    }
  }

  const extraRaw = extractJsonObject(
    html,
    "__additionalDataLoaded('extra',"
  );
  if (extraRaw) {
    try {
      const extra = JSON.parse(extraRaw);
      if (extra?.shortcode_media) return extra.shortcode_media;
      if (extra?.graphql?.shortcode_media) return extra.graphql.shortcode_media;
      if (extra?.media) return extra.media;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** 是否命中 Instagram 登录墙（用于给出更友好的错误提示） */
export function looksLikeLoginWall(html) {
  if (!html) return false;
  // 匿名请求的帖子页典型特征：含 login/checkpoint 提示，且无媒体 JSON
  return (
    /<title>Login/i.test(html) ||
    /"isConsumed":\s*true[^}]*"entry_data"/.test(html) ||
    (html.includes("checkpoint") && html.includes("Log in"))
  );
}

/** 将 IG 媒体节点规范化为统一 data 结构 */
export function normalizeInstagramMedia(media) {
  const children =
    media?.__typename === "GraphSidecar"
      ? (media.edge_sidecar_to_children?.edges || []).map((e) => e.node)
      : [];

  const hasVideo = !!(media?.is_video || children.some((n) => n.is_video));
  const primary = hasVideo
    ? children.find((n) => n.is_video) || media
    : children[0] || media;

  const caption = captionOf(media);
  const username = media?.owner?.username || "";
  const base = {
    title: caption || (username ? `Instagram @${username}` : "Instagram"),
    desc: caption || undefined,
    author: username,
    avatar: media?.owner?.profile_pic_url || "",
    authorUrl: username ? `https://www.instagram.com/${username}/` : undefined,
    cover: largestDisplayUrl(media),
    time: (media?.taken_at_timestamp || 0) * 1000 || undefined,
    source: "instagram",
  };

  // 视频（Reels / 单视频 / 图集内含视频）：以首个视频为主媒体
  if (primary?.is_video) {
    const url = videoUrl(primary);
    return {
      ...base,
      type: "video",
      url: url || "",
      cover: base.cover || largestDisplayUrl(primary),
      duration: (primary?.video_duration || media?.video_duration || 0) * 1000,
    };
  }

  // 图片：单图或纯图片图集返回 images 列表
  const images = hasVideo
    ? []
    : children.length
      ? children.map((n) => largestDisplayUrl(n)).filter(Boolean)
      : [largestDisplayUrl(media)].filter(Boolean);

  const cover = images[0] || base.cover;
  return {
    ...base,
    type: "image",
    url: cover,
    cover,
    images,
  };
}

/** 抓取帖子页 HTML */
async function fetchPostPage(code) {
  const pageUrl = `https://www.instagram.com/p/${code}/?hl=en`;
  const headers = {
    "user-agent": UA,
    "accept-language": "en-US,en;q=0.9",
    accept: "text/html,application/xhtml+xml",
  };
  if (IG_COOKIE) headers.cookie = IG_COOKIE;

  const response = await fetch(pageUrl, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return await response.text();
}

/**
 * 解析 Instagram 帖子/Reels 链接，返回统一结果结构 { code, msg, data }
 */
export async function parseInstagram(url) {
  const shortcode = extractShortcode(url);
  if (!shortcode) {
    return { code: 400, msg: "链接不是有效的 Instagram 帖子/Reels 链接" };
  }

  let html;
  try {
    html = await fetchPostPage(shortcode);
  } catch (error) {
    const message = error.message || "";
    logger.warn(`[instagram] 抓取失败: ${message}`);
    return {
      code: 201,
      msg: `解析失败：无法访问 Instagram（${message}）。可稍后重试；部署侧可配置 IG_COOKIE 后提升成功率。`,
    };
  }

  const media = extractPostMedia(html);
  if (media) {
    logger.log(`[instagram] 解析成功：@${media?.owner?.username || ""} 的帖子 ${shortcode}`);
    return { code: 200, msg: "解析成功", data: normalizeInstagramMedia(media) };
  }

  if (IG_COOKIE) {
    return {
      code: 201,
      msg: "解析失败：未获取到帖子内容，帖子可能为私密/已删除，或配置的 IG_COOKIE 已过期",
    };
  }
  return {
    code: 201,
    msg: looksLikeLoginWall(html)
      ? "解析失败：Instagram 已开启登录墙，公开内容也需要登录态。请在部署侧配置 IG_COOKIE（浏览器登录后的 Cookie）后重试。"
      : "解析失败：未在页面中找到媒体数据，帖子可能为私密、已删除或需要登录后可见",
  };
}

export const _internal = { extractPostMedia, normalizeInstagramMedia, extractJsonObject };
