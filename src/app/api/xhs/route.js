import { createApiHandler } from "@/lib/api-middleware";
import { logger } from "@/lib/api-utils";

export const runtime = "nodejs";

/** 小红书 H5：桌面 Chrome UA，短链统一走 https */
const XHS_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0";

// 可选：浏览器登录小红书后复制的 Cookie，可显著降低数据中心/海外出口被风控概率
const XHS_COOKIE = process.env.XHS_COOKIE || "";

// —— 简易 Cookie 池 ——
// 小红书对无 Cookie 的请求（尤其数据中心/海外 IP）会间歇返回安全验证页
// （无 __INITIAL_STATE__），带齐 a1/webId 等匿名 Cookie 后通常可放行。
// Node fetch 不自动保存 Cookie，这里累积各响应 set-cookie 供后续请求使用。
const xhsCookiePool = {};

function absorbXhsCookies(response) {
  try {
    const list =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [];
    for (const raw of list) {
      const pair = String(raw).split(";")[0].trim();
      const name = pair.split("=")[0]?.trim();
      if (!name) continue;
      xhsCookiePool[name] = pair;
    }
  } catch {
    // 忽略吸收失败，不影响主流程
  }
}

/** 合并多段 Cookie：环境变量 XHS_COOKIE 优先，其次 Cookie 池 */
function buildXhsCookieString(extra) {
  const sources = [extra, XHS_COOKIE];
  for (const name of Object.keys(xhsCookiePool)) {
    sources.push(xhsCookiePool[name]);
  }
  const seen = new Set();
  const parts = [];
  for (const src of sources) {
    if (!src) continue;
    for (const seg of String(src).split(";")) {
      const kv = seg.trim();
      if (!kv) continue;
      const name = kv.split("=")[0];
      if (name && !seen.has(name)) {
        seen.add(name);
        parts.push(kv);
      }
    }
  }
  return parts.join("; ");
}

/** 完整浏览器请求头（小红书会校验请求特征，缺头易被识别为爬虫） */
function xhsHeaders({ referer, cookie, acceptJson } = {}) {
  const headers = {
    "User-Agent": XHS_USER_AGENT,
    Accept: acceptJson
      ? "application/json, text/plain, */*"
      : "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "sec-ch-ua":
      '"Microsoft Edge";v="129", "Not=A?Brand";v="8", "Chromium";v="129"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
  };
  if (referer) headers.Referer = referer;
  const cookieStr = buildXhsCookieString(cookie);
  if (cookieStr) headers.Cookie = cookieStr;
  return headers;
}

function output(code, msg, data = []) {
  return {
    code,
    msg,
    data,
  };
}

function normalizeXhsUrl(url) {
  try {
    const u = new URL(url.trim());
    const host = u.hostname.toLowerCase();
    // xhslink.com / xhslink.cn 短链统一走 https
    if (["xhslink.com", "xhslink.cn"].includes(host) && u.protocol === "http:") {
      u.protocol = "https:";
      return u.toString();
    }
  } catch {
    /* ignore */
  }
  return url.trim();
}

/**
 * 短链与笔记页：手动跟随重定向，兼容 xhslink.com 的 o/ 短链。
 * 每次响应吸收 set-cookie，后续请求自动携带（无 Cookie 时小红书易弹安全验证）。
 * 首次链路失败/被风控时，用已吸收的 Cookie 自动重试一次。
 */
async function fetchXhsNoteHtml(url, attempt = 1) {
  const target = normalizeXhsUrl(url);

  const doFetch = (u, referer) =>
    fetch(u, {
      headers: xhsHeaders(referer ? { referer } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(20000),
    });

  try {
    // 第一步：请求短链/笔记页，手动处理重定向
    let response = await doFetch(target, "");
    absorbXhsCookies(response);

    // 手动跟随重定向（最多跟 5 次），每步带上已吸收的 Cookie 与来源 Referer
    let redirectCount = 0;
    const maxRedirects = 5;
    while (
      redirectCount < maxRedirects &&
      [301, 302, 303, 307, 308].includes(response.status)
    ) {
      const location = response.headers.get("location");
      if (!location) break;
      const nextUrl = new URL(location, response.url).toString();
      redirectCount++;
      response = await doFetch(nextUrl, response.url);
      absorbXhsCookies(response);
    }

    const html = await response.text();
    const finalUrl = response.url;

    // 已落到小红书域但缺页面数据：多半是首次无 Cookie 被风控，
    // 用已吸收的 Cookie 整条重试一次（二次请求通常能拿到正常笔记页）
    if (
      attempt === 1 &&
      !html.includes("__INITIAL_STATE__") &&
      /xiaohongshu\.com|xhslink\.(com|cn)/.test(finalUrl)
    ) {
      console.log("[xhs] retry with absorbed cookies, finalUrl:", finalUrl);
      return fetchXhsNoteHtml(url, 2);
    }

    return { html, finalUrl };
  } catch (error) {
    if (attempt === 1) {
      console.log("[xhs] fetch error, retry once:", error.message);
      return fetchXhsNoteHtml(url, 2);
    }
    throw error;
  }
}

// 安全地获取嵌套属性
function safeGet(obj, path) {
  try {
    return path.split(".").reduce((current, key) => {
      if (current && typeof current === "object" && key in current) {
        return current[key];
      }
      return null;
    }, obj);
  } catch {
    return null;
  }
}

/**
 * 兜底查找互动统计：从 note.noteDetailMap 全量遍历，取第一个带 interactInfo 的笔记
 * （不同分享入口结构略有差异，interactInfo 可能在 entry 或 entry.note 上）
 */
function findFirstInteractInfo(root) {
  const detailMap = safeGet(root, "note.noteDetailMap");
  if (!detailMap || typeof detailMap !== "object") return null;
  for (const key of Object.keys(detailMap)) {
    const entry = detailMap[key];
    const info =
      safeGet(entry, "note.interactInfo") ||
      safeGet(entry, "interactInfo") ||
      null;
    if (info && typeof info === "object") return info;
  }
  return null;
}

/**
 * 新版笔记页：note.currentNoteId + note.noteDetailMap[id].note
 * 旧版：noteData.data.noteData 等
 */
function resolveNotePayload(decoded) {
  // 新版结构：note.noteDetailMap
  const noteId = safeGet(decoded, "note.currentNoteId");
  const detailMap = safeGet(decoded, "note.noteDetailMap");
  if (noteId && detailMap && typeof detailMap === "object") {
    const entry = detailMap[noteId];
    if (entry?.note && typeof entry.note === "object") {
      return entry.note;
    }
    // 有些版本 note 直接挂在 entry 下
    if (entry && typeof entry === "object" && entry.title) {
      return entry;
    }
  }

  // 旧版结构
  return (
    safeGet(decoded, "noteData.data.noteData") ||
    safeGet(decoded, "note.data") ||
    safeGet(decoded, "noteDetail.data") ||
    safeGet(decoded, "data.noteData") ||
    // 更多兜底路径
    safeGet(decoded, "note.noteDetailMap")?.[noteId]?.note ||
    safeGet(decoded, "note.noteDetailMap")?.[noteId] ||
    safeGet(decoded, "note") ||
    null
  );
}

function extractInitialStateJson(html) {
  // 取到下一个 </script>，避免对大段 JSON 做错误的非贪婪 `}` 截断
  const re = /window\.__INITIAL_STATE__\s*=\s*(.*?)<\/script>/is;
  const m = html.match(re);
  if (m?.[1]) {
    return m[1].trim();
  }
  // 兼容旧版 script 标签格式
  const legacy =
    /<script>\s*window\.__INITIAL_STATE__\s*=\s*([\s\S]*?)<\/script>/i.exec(
      html
    );
  if (legacy?.[1]) {
    return legacy[1].trim();
  }
  // 兼容单行 script 格式
  const inline =
    /<script[^>]*>\s*window\.__INITIAL_STATE__\s*=\s*([\s\S]*?)<\/script>/i.exec(
      html
    );
  return inline?.[1]?.trim() ?? null;
}

/**
 * 把第三方图片 URL 包成站内代理路径，绕过 Referer 防盗链
 * （如小红书 sns-webpic 只允许 Referer: xiaohongshu.com）。
 * 视频不代理（耗资源），仅图片走 /api/image。
 */
function proxifyImage(url) {
  if (!url) return "";
  return `/api/image?url=${encodeURIComponent(url)}`;
}

/**
 * 选取稳定可用的视频直链。
 * backupUrls 为裸直链（无短时效签名，长期有效），优先使用；
 * masterUrl 带约 30 分钟签名，仅作兜底。
 * 统一转 https，避免 https 站点下 http 直链的 mixed content 问题。
 */
async function pickStableVideoUrl(entry) {
  if (!entry || typeof entry !== "object") return null;

  const toHttps = (u) => (u ? u.replace(/^http:/i, "https:") : u);

  const candidates = [];
  if (Array.isArray(entry.backupUrls)) {
    for (const u of entry.backupUrls) {
      if (u) candidates.push(toHttps(u));
    }
  }
  if (entry.masterUrl) candidates.push(toHttps(entry.masterUrl));

  // HEAD 轻量验证可用性（部分 CDN 节点 404，如 bak-v6），取第一个可用的
  for (const u of candidates) {
    try {
      const head = await fetch(u, {
        method: "HEAD",
        signal: AbortSignal.timeout(5000),
      });
      if (head.ok) return u;
    } catch {
      /* try next */
    }
  }
  // HEAD 全部失败不一定是链接不可用（CDN 可能拒绝 HEAD / 节点抽风），
  // 退回第一个候选让下游 video-proxy 用 GET 尝试，避免把可用的视频
  // 误判成“该内容不包含视频或图片”。
  console.log("[xhs] all video HEAD failed, fallback:", candidates[0]);
  return candidates[0];
}

async function xhs(url) {
  try {
    const { html, finalUrl } = await fetchXhsNoteHtml(url);

    console.log("[xhs] finalUrl:", finalUrl);
    console.log("[xhs] html length:", html?.length || 0);

    if (!html) {
      return output(400, "请求失败，未获取到页面内容");
    }

    // 检查是否被小红书拦截或跳转到了非笔记页
    if (
      (finalUrl.includes("xhslink.com") || finalUrl.includes("xhslink.cn")) &&
      !html.includes("__INITIAL_STATE__")
    ) {
      return output(
        400,
        "短链重定向失败，请尝试复制小红书 App 内的分享链接"
      );
    }

    if (
      !finalUrl.includes("xiaohongshu.com") &&
      !html.includes("__INITIAL_STATE__")
    ) {
      return output(
        400,
        "无法打开小红书笔记页，请确认短链有效或使用 App 分享链接"
      );
    }

    let jsonRaw = extractInitialStateJson(html);
    if (!jsonRaw) {
      // 安全验证页/风控拦截的典型特征（页面不含 __INITIAL_STATE__）
      if (
        /安全验证|请完成验证|__AC_NONCE__|geetest|verify|captcha/i.test(html)
      ) {
        console.log("[xhs] blocked by safety check, finalUrl:", finalUrl);
        return output(
          400,
          "小红书触发了安全验证，请稍后重试（或联系站长配置 XHS_COOKIE）"
        );
      }
      // 尝试打印 HTML 片段帮助调试
      console.log("[xhs] HTML preview:", html.substring(0, 500));
      return output(400, "未找到页面数据，小红书可能更新了页面结构");
    }

    jsonRaw = jsonRaw.replace(/undefined/g, "null");

    let decoded;
    try {
      decoded = JSON.parse(jsonRaw);
    } catch (e) {
      console.log("[xhs] JSON parse error:", e.message);
      return output(400, "JSON数据解析失败");
    }

    if (!decoded || typeof decoded !== "object") {
      return output(400, "数据格式错误");
    }

    const noteData = resolveNotePayload(decoded);

    if (!noteData || typeof noteData !== "object") {
      console.log("[xhs] decoded keys:", Object.keys(decoded));
      return output(400, "数据结构不匹配，请检查链接是否为有效的小红书内容");
    }

    // 安全地构建基础数据
    // 小红书号优先取 user.redId（自定义号），缺失时回退 userId
    const userId =
      safeGet(noteData, "user.userId") || safeGet(noteData, "user.id") || "";
    // 互动统计：主路径取 noteData.interactInfo，缺失时从 noteDetailMap 全量兜底
    const interactInfo = noteData.interactInfo || findFirstInteractInfo(decoded);
    const data = {
      author:
        safeGet(noteData, "user.nickName") ||
        safeGet(noteData, "user.nickname") ||
        safeGet(noteData, "user.name") ||
        "",
      authorID: safeGet(noteData, "user.redId") || userId,
      // 博主主页链接：由 userId 拼 profile 首页（前端可点击跳转）
      authorUrl: userId
        ? `https://www.xiaohongshu.com/user/profile/${userId}`
        : "",
      // 博主简介（笔记页 user 可能带，缺失时前端自动隐藏）
      sign:
        safeGet(noteData, "user.description") ||
        safeGet(noteData, "user.desc") ||
        "",
      title: noteData.title || "",
      desc: noteData.desc || noteData.description || "",
      avatar:
        safeGet(noteData, "user.avatar") ||
        safeGet(noteData, "user.avatarUrl") ||
        "",
      // —— 帖子（笔记）信息 ——
      // 发布时间：小红书 time/lastUpdateTime 为毫秒时间戳，统一转成 unix 秒给前端 formatTime
      time: (() => {
        const rawTime = noteData.time ?? noteData.lastUpdateTime;
        return typeof rawTime === "number" && rawTime >= 1e12
          ? Math.floor(rawTime / 1000)
          : (rawTime ?? "");
      })(),
      // 笔记互动统计（interactInfo 各计数可能是字符串，保留原始值交给前端格式化）
      like: safeGet(interactInfo, "likedCount") ?? "",
      favorite: safeGet(interactInfo, "collectedCount") ?? "",
      reply: safeGet(interactInfo, "commentCount") ?? "",
      share: safeGet(interactInfo, "sharedCount") ?? "",
      noteId: noteData.noteId ?? "",
    };

    // 检查视频URL
    let videoUrl = null;
    const videoStream = safeGet(noteData, "video.media.stream");

    if (videoStream && typeof videoStream === "object") {
      // h264 优先（浏览器兼容性最好），h265 兜底；均优先取裸直链
      const h264List = videoStream.h264;
      if (Array.isArray(h264List) && h264List.length > 0 && h264List[0]) {
        videoUrl = await pickStableVideoUrl(h264List[0]);
      }
      if (!videoUrl) {
        const h265List = videoStream.h265;
        if (Array.isArray(h265List) && h265List.length > 0 && h265List[0]) {
          videoUrl = await pickStableVideoUrl(h265List[0]);
        }
      }
    }

    if (videoUrl) {
      console.log("[xhs] videoUrl:", videoUrl);
      // 视频内容
      data.cover = "";
      const imageList = noteData.imageList;
      if (Array.isArray(imageList) && imageList.length > 0 && imageList[0]) {
        const first = imageList[0];
        data.cover = proxifyImage(
          (
            first.urlDefault ||
            first.url ||
            safeGet(first, "infoList.0.url") ||
            ""
          ).replace(/^http:/i, "https:")
        );
      }
      data.url = videoUrl;
      data.type = "video";
      return output(200, "解析成功", data);
    }

    // 检查图片内容
    const imageList = noteData.imageList;
    if (Array.isArray(imageList) && imageList.length > 0) {
      const images = [];
      let cover = "";

      for (let i = 0; i < imageList.length; i++) {
        const img = imageList[i];
        if (img && typeof img === "object") {
          let imageUrl = (
            img.urlDefault ||
            img.url ||
            safeGet(img, "infoList.0.url") ||
            ""
          ).replace(/^http:/i, "https:");
          if (imageUrl) {
            images.push(proxifyImage(imageUrl));
            if (i === 0) cover = proxifyImage(imageUrl);
          }
        }
      }

      if (images.length > 0) {
        data.cover = cover;
        data.images = images;
        data.type = "image";
        return output(200, "解析成功", data);
      }
    }

    return output(404, "该内容不包含视频或图片");
  } catch (error) {
    logger.error("xhs parse error:", error);
    return output(500, "服务器内部错误");
  }
}

export const GET = createApiHandler(xhs);
