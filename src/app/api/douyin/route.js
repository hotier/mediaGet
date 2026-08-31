import { createApiHandler } from "@/lib/api-middleware";
import { logger, beijingNow } from "@/lib/api-utils";
import { douyinPublicFallback } from "@/lib/douyinFallback";
import { sleep } from "@/lib/anti-bot";
import { request as httpsRequest } from "node:https";
import {
  hasValidData,
  tryParseEmbedded,
  parseVideoData,
  extractFilterReason,
  isChallengeHtml,
  extractIdFromUrl,
  extractTtwid,
  isUserProfileUrl,
  extractUserFromRouter,
} from "@/lib/douyin-extract";

// Docker 自托管下 Node runtime 对外网 fetch 通常比 Edge 沙箱更稳定（抖音等站）
export const runtime = "nodejs";

// 多组 UA 轮询（参考 video-unwatermark sharepage.py 的 DOUYIN_HEADER_SETS）。
// 顺序关键：抖音 App UA（aweme/...）实测是唯一会下发 ttwid 的 UA，
// 必须先用它建立 ttwid，再带 ttwid 用其他 UA 请求数据。
// 最小化请求头 — 过多的 sec-ch-ua / desktop 头与 mobile UA 混用会触发抖音反爬
const MOBILE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9",
};

const UA_SETS = [
  {
    "User-Agent":
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 aweme/32.7.0 NetType/WIFI Channel/App Store",
    Accept: "text/html,application/xhtml+xml",
    "Accept-Language": "zh-CN,zh;q=0.9",
  },
  MOBILE_HEADERS,
  {
    "User-Agent":
      "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
  },
];

// 北京时间格式化已抽到 lib/api-utils.js 的 beijingNow()，各路由共用

// ---------------------------------------------------------------------------
// ttwid 跨请求复用：抖音匿名 ttwid 与具体视频无关、短期有效，缓存最近一次有效值，
// 下个链接直接带上，省掉一半握手请求，也避免「每次都是全新会话」这一典型爬虫特征。
// 进程内存即可（Serverless 每 isolate 独立，命中率打折但无害）。
// ---------------------------------------------------------------------------
let cachedTtwid = { value: "", expiresAt: 0 };
const TTWID_TTL_MS = 10 * 60 * 1000; // 10 分钟窗口

function getCachedTtwid() {
  if (cachedTtwid.value && Date.now() < cachedTtwid.expiresAt) {
    return cachedTtwid.value;
  }
  return "";
}

function rememberTtwid(ttwid) {
  if (ttwid && ttwid !== cachedTtwid.value) {
    cachedTtwid = { value: ttwid, expiresAt: Date.now() + TTWID_TTL_MS };
  }
}

// ---------------------------------------------------------------------------
// DOUYIN_COOKIE 失效自检：配置了 cookie 仍连续命中风控 → cookie 大概率已过期/
// 被平台标记，打一条明确告警（只告警一次，直到下一次成功解析后重置），
// 避免「cookie 已失效还在每条都带它重试」的无效消耗。
// ---------------------------------------------------------------------------
let cookieFailureStreak = 0;
let cookieStaleAlerted = false;

function noteDouyinOutcome({ cookieConfigured, succeeded, challenged }) {
  if (!cookieConfigured) return;
  if (succeeded) {
    cookieFailureStreak = 0;
    cookieStaleAlerted = false;
    return;
  }
  if (!challenged) return; // 非风控失败（视频不存在等）不累计
  cookieFailureStreak += 1;
  if (cookieFailureStreak >= 5 && !cookieStaleAlerted) {
    cookieStaleAlerted = true;
    logger.warn(
      `[${beijingNow()}] DOUYIN_COOKIE 疑似失效：连续 ${cookieFailureStreak} 次请求命中抖音风控，请更新环境变量 DOUYIN_COOKIE（浏览器里复制有效 cookie）`
    );
  }
}

async function douyin(url) {
  try {
    const DOUYIN_COOKIE = process.env.DOUYIN_COOKIE || "";

    // ---- Step 1: 从短链 / 分享链接中提取视频 ID 和完整重定向 URL ----
    const extractResult = await extractIdAndRedirectUrl(url);
    // 短链实际跳转到用户主页（/share/user/ 或带 sec_uid）：
    // 不是视频链接，给出明确提示而非笼统的「无法解析视频 ID」
    if (extractResult?.type === "user") {
      logger.warn(
        `[${beijingNow()}] 解析抖音链接失败：用户主页链接（${url.slice(0, 60)}）`
      );
      return {
        code: 400,
        msg: "该链接是抖音用户主页，不是视频链接：请打开具体视频或图文，点「分享」复制链接后再解析",
      };
    }
    if (!extractResult || extractResult.networkError) {
      logger.warn(
        `[${beijingNow()}] 解析抖音链接失败：${
          extractResult?.networkError ? "短链访问异常（网络/DNS）" : "无法提取视频 ID"
        }（${url.slice(0, 60)}）`
      );
      return {
        code: 400,
        msg: extractResult?.networkError
          ? "访问抖音短链失败（网络/DNS 异常）：请确认当前网络能打开该抖音链接，或稍后重试"
          : "无法解析视频 ID：请确保链接格式正确且视频可访问",
      };
    }
    const { id, type: contentType, redirectUrl, ttwid } = extractResult;
    const sharePath = contentType === "note" ? "note" : "video";

    // ---- ID 合法性预校验 ----
    // 抖音标准 aweme_id 为 19 位数字（首位通常为 7）。17-19 位视为合法
    // （兼容历史/note/story 类型）；明显非法的伪 ID（如日志中出现的
    // 000000000503073 这类 15 位）直接返回，不发请求，节省服务器流量。
    if (!/^\d{17,19}$/.test(id)) {
      logger.warn(`Douyin invalid video id format: ${id}`);
      return {
        code: 400,
        msg: "解析失败：链接中的视频 ID 格式不正确，请确认链接来自抖音分享",
      };
    }

    // ---- Step 2: 从分享页获取 SSR 数据 ----
    // 优先使用完整重定向 URL（含 share_version / share_sign 等参数）以降低被过滤概率
    let shareUrl = redirectUrl || `https://www.iesdouyin.com/share/${sharePath}/${id}`;
    // 如果 redirectUrl 是 douyin.com 域名，替换为 iesdouyin.com
    if (shareUrl.includes("www.douyin.com")) {
      const params = shareUrl.includes("?") ? shareUrl.split("?")[1] : "";
      shareUrl = `https://www.iesdouyin.com/share/${sharePath}/${id}${params ? "?" + params : ""}`;
    }

    // 抖音二次握手机制：匿名首次访问只下发 ttwid cookie（无需登录），
    // 带 ttwid 的第二次请求才会返回视频数据。维护一个极简 cookie jar。
    // 优先复用跨请求缓存（见模块顶部 rememberTtwid），减少握手请求。
    let ttwidCookie = ttwid || getCachedTtwid();
    // 整体请求预算：2 轮 × 3 组 UA × 4 URL 最坏可能很慢，用 20s 硬上限兜底
    const startTime = Date.now();
    const buildFetchHeaders = (ua) => {
      const headers = { ...ua };
      const cookies = [];
      if (ttwidCookie && !DOUYIN_COOKIE.includes("ttwid=")) {
        cookies.push(ttwidCookie);
      }
      if (DOUYIN_COOKIE) {
        cookies.push(DOUYIN_COOKIE);
      }
      if (cookies.length > 0) {
        headers.Cookie = cookies.join("; ");
      }
      return headers;
    };

    // 尝试多个域名 / 路径以应对机房 IP 被反爬的情况
    const tryUrls = [
      shareUrl,
      `https://www.iesdouyin.com/share/${sharePath}/${id}`,
      `https://m.douyin.com/share/${sharePath}/${id}`,
      `https://www.douyin.com/video/${id}`,
    ];

    let videoInfo = null;
    let lastHtml = "";
    // 记录最后一次成功解析出 _ROUTER_DATA 的数据（即使 item_list 为空）：
    // 抖音对已删除/不存在的视频会返回 filter_list 而非数据，需要据此给准确报错
    let lastRouterData = null;
    // 反爬命中的域名计数（用于最终一行汇总，避免逐 URL 刷日志）
    let challengeCount = 0;

    // 最多两轮 × 多组 UA × 多 URL：
    // 第一轮拿 ttwid（可能无数据），第二轮带 ttwid 拿数据。
    // 修复点（2026-08-22，参考 video-unwatermark sharepage.py）：
    // 带 ttwid 的分享页会同时携带 argus 风控脚本与真实 _ROUTER_DATA，
    // 因此必须先尝试解析数据、数据有效即胜出；反爬特征仅用于无数据时归类报错，
    // 绝不能因为页面含 argus-csp-token 就跳过 —— 那是此前解析全部失败的根因。
    for (let round = 0; round < 2 && !videoInfo; round++) {
      for (const ua of UA_SETS) {
        for (const fetchUrl of tryUrls) {
          if (videoInfo) break;
          if (Date.now() - startTime > 20000) break;
          try {
            const response = await fetch(fetchUrl, {
              headers: buildFetchHeaders(ua),
              signal: AbortSignal.timeout(8000),
            });
            const html = await response.text();
            lastHtml = html;

            // 从响应头收集 ttwid，供后续请求使用（App UA 才会下发）；
            // 同时写入跨请求缓存，供下一个链接复用
            const newTtwid = extractTtwid(response);
            if (newTtwid && ttwidCookie !== newTtwid) {
              ttwidCookie = newTtwid;
            }
            rememberTtwid(newTtwid);

            // 检查是否被重定向到国际版
            if (html.includes("tiktok.com") || html.includes("访问受限")) {
              continue;
            }

            // 先解析内嵌数据（_ROUTER_DATA / RENDER_DATA / _SSR_DATA）
            const parsed = tryParseEmbedded(html);
            if (parsed) {
              if (hasValidData(parsed)) {
                videoInfo = parsed;
                break;
              }
              // 空壳 / 被过滤：保留结构供后续给出准确报错
              lastRouterData = parsed;
            } else if (isChallengeHtml(html)) {
              // 页面完全无数据块且带反爬特征：命中 challenge，计数供报错
              challengeCount++;
              // 节奏平滑：被风控后略作停顿再试下一组 UA/URL，避免闪电风暴
              if (Date.now() - startTime <= 20000) {
                await sleep(800);
              }
            }
          } catch {
            /* 网络异常跳过该 URL，尝试下一个 */
          }
        }
      }
    }

    if (!videoInfo) {
      // 优先给出抖音服务端的过滤原因（如 SYSTEM_ITEM_NOT_EXIST = 视频不存在/已删除）
      const filterReason = extractFilterReason(lastRouterData);

      // 视频真实存在（无过滤原因）但分享页拿不到数据 → 公共解析 API 兜底
      // （参考 video-unwatermark 的 webparser 引擎：17change/douyin.wtf/yujn/tenapi 竞速）
      if (!filterReason) {
        try {
          const fb = await douyinPublicFallback(url);
          if (fb.ok && fb.url) {
            logger.log(
              `[${beijingNow()}] 解析抖音链接 ${id} 成功（公共解析兜底 ${fb.key}）`
            );
            return {
              code: 200,
              msg: "解析成功",
              data: {
                author: "",
                uid: "",
                avatar: "",
                like: 0,
                time: 0,
                title: fb.title || "视频",
                cover: fb.cover || "",
                type: "video",
                url: fb.url,
                duration: 0,
              },
            };
          }
        } catch (error) {
          logger.warn(
            `[${beijingNow()}] 解析抖音链接 ${id} 公共解析兜底异常: ${error.message}`
          );
        }
      }

      if (filterReason) {
        logger.warn(
          `[${beijingNow()}] 解析抖音链接 ${id} 失败：抖音服务端过滤（${filterReason}）`
        );
        return {
          code: 201,
          msg: `解析失败：抖音服务端过滤了该内容（${filterReason}），视频可能已删除或为隐私内容`,
        };
      }
      // 所有请求都命中反爬 JS challenge（argus / _$jsvmprt）：IP 被抖音风控，
      // 需配置 DOUYIN_COOKIE（带有效浏览器 cookie）或更换网络出口
      const isAntiBot = challengeCount > 0;
      if (isAntiBot) {
        logger.warn(
          `[${beijingNow()}] 解析抖音链接 ${id} 失败：抖音风控拦截（${challengeCount} 次请求均被反爬）`
        );
        // cookie 失效自检：带 cookie 仍连续命中风控 → 累计并告警（见模块顶部）
        noteDouyinOutcome({ cookieConfigured: !!DOUYIN_COOKIE, succeeded: false, challenged: true });
        return {
          code: 201,
          msg: "解析失败：抖音风控拦截了本次请求（网络出口被限流），请稍后重试，或联系站长配置有效的抖音 Cookie",
        };
      }
      // 记录部分响应内容用于诊断（截取前 500 字符）
      const snippet = lastHtml.replace(/\s+/g, " ").slice(0, 500);
      logger.warn(
        `[${beijingNow()}] 解析抖音链接 ${id} 失败：未获取到页面数据。Response: ${snippet}`
      );
      // 已自动携带匿名 ttwid 仍拿不到数据：多为视频不存在 / 已删除 / 被过滤
      return {
        code: 201,
        msg: "解析失败：未能从页面获取视频数据，可能是视频不存在、已删除或页面结构变化",
      };
    }

    if (!videoInfo.loaderData) {
      logger.warn(
        `[${beijingNow()}] 解析抖音链接 ${id} 失败：视频数据结构异常`
      );
      return {
        code: 201,
        msg: "解析失败：视频数据结构异常，可能是抖音接口发生变化",
      };
    }

    // ---- Step 3: 提取视频 / 图文数据 ----
    const parseResult = parseVideoData(videoInfo);
    if (parseResult) {
      if (parseResult.code === 200) {
        const t = parseResult.data?.title || "";
        logger.log(
          `[${beijingNow()}] 解析抖音链接 ${id} 成功${t ? `：《${t.slice(0, 30)}》` : ""}`
        );
        // cookie 失效自检：成功即复位计数（见模块顶部 noteDouyinOutcome）
        noteDouyinOutcome({ cookieConfigured: !!DOUYIN_COOKIE, succeeded: true, challenged: false });
        // 博主公开信息（粉丝/关注/获赞）：分享页不返回，需额外请求用户主页。
        // 失败或超时静默忽略，绝不阻塞主解析结果。
        const stats = await fetchUserStats(
          parseResult.data?.secUid,
          buildFetchHeaders
        );
        if (stats) {
          Object.assign(parseResult.data, stats);
          // 抖音号兜底：分享页无 uid 时用博主主页接口返回的短号
          if (!parseResult.data.uid && stats.dyId) {
            parseResult.data.uid = stats.dyId;
          }
          delete stats.dyId;
        }
      } else {
        logger.warn(
          `[${beijingNow()}] 解析抖音链接 ${id} 失败：${parseResult.msg}`
        );
      }
      // secUid 仅用于主页请求，不下发前端；但据它拼出博主主页链接供前端跳转
      if (parseResult.data) {
        const secUid = parseResult.data.secUid;
        if (secUid) {
          parseResult.data.authorUrl = `https://www.douyin.com/user/${secUid}`;
        }
        delete parseResult.data.secUid;
      }
      return parseResult;
    }

    // ---- Step 4: 分享页数据为空 — 提取 filter_list 给出明确错误 ----
    const filterReason = extractFilterReason(videoInfo);
    if (filterReason) {
      logger.warn(
        `[${beijingNow()}] 解析抖音链接 ${id} 失败：抖音服务端过滤（${filterReason}）`
      );
      return {
        code: 201,
        msg: `解析失败：抖音服务端过滤了该内容（${filterReason}），部分视频（如实况图、刚发布的内容）暂不支持解析`,
      };
    }

    logger.warn(
      `[${beijingNow()}] 解析抖音链接 ${id} 失败：未能从页面获取视频数据`
    );
    return {
      code: 201,
      msg: "解析失败：未能从页面获取视频数据，可能是页面结构变化、接口受限或视频已被删除",
    };
  } catch (error) {
    logger.error("Error in douyin function:", error);
    return { code: 500, msg: "服务器内部错误" };
  }
}

/**
 * 获取博主主页公开信息：粉丝数 / 关注数 / 获赞数 / 抖音号。
 * 分享页接口不返回这些，需额外请求博主主页。
 * 策略（2026-08-31 实测）：
 * 1) 优先 SSR 用户主页（www.douyin.com/user/<sec_uid>）：字段最全、粉丝数为站内精确值，
 *    但无登录 Cookie 时大概率被 argus 风控拦截（页面无数据块），故仅在配置了 DOUYIN_COOKIE 时尝试；
 * 2) 老接口兜底 https://www.iesdouyin.com/web/api/v2/user/info/?sec_uid=<sec_uid>：
 *    无需签名、一次请求即返回 JSON，实测稳定。注意其粉丝数字段为 mplatform_followers_count
 *    （抖音 web 展示口径，多端聚合），无站内 follower_count。
 * 失败 / 超时静默返回 null，绝不阻塞主解析流程。
 */
async function fetchUserStats(secUid, buildFetchHeaders) {
  if (!secUid || typeof secUid !== "string" || secUid.length < 8) return null;

  // 1) SSR 用户主页（仅配置了 cookie 时尝试，避免无谓等待被风控的超时）
  if (process.env.DOUYIN_COOKIE) {
    const urls = [
      `https://www.douyin.com/user/${secUid}`,
      `https://www.iesdouyin.com/share/user/${secUid}`,
      `https://www.iesdouyin.com/user/${secUid}`,
    ];
    const startTime = Date.now();
    for (let round = 0; round < 2; round++) {
      for (const ua of UA_SETS) {
        for (const fetchUrl of urls) {
          if (Date.now() - startTime > 15000) return null;
          try {
            const response = await fetch(fetchUrl, {
              headers: buildFetchHeaders(ua),
              signal: AbortSignal.timeout(6000),
            });
            const html = await response.text();
            const parsed = tryParseEmbedded(html);
            if (!parsed) continue;
            const user = extractUserFromRouter(parsed);
            if (!user) continue;
            const followerCount = Number(user.follower_count) || 0;
            const followingCount = Number(user.following_count) || 0;
            const totalFavorited = Number(user.total_favorited) || 0;
            if (followerCount || followingCount || totalFavorited) {
              logger.log(
                `[${beijingNow()}] 抖音博主主页统计获取成功（SSR）：粉丝=${followerCount} 关注=${followingCount} 获赞=${totalFavorited}`
              );
              return {
                followerCount,
                followingCount,
                totalFavorited,
                // 博主签名：仅非空时下发（空串不覆盖分享页已有的值）
                ...(typeof user.signature === "string" && user.signature.trim()
                  ? { sign: user.signature }
                  : {}),
              };
            }
          } catch {
            /* 尝试下一个 URL */
          }
        }
      }
    }
  }

  // 2) 老接口兜底（无需签名，实测稳定）
  try {
    const url = `https://www.iesdouyin.com/web/api/v2/user/info/?sec_uid=${encodeURIComponent(
      secUid
    )}`;
    const response = await fetch(url, {
      headers: {
        ...MOBILE_HEADERS,
        Accept: "application/json, text/plain, */*",
        Referer: "https://www.douyin.com/",
      },
      signal: AbortSignal.timeout(8000),
    });
    const json = await response.json();
    const u = json?.user_info;
    if (!u) return null;
    const followingCount = Number(u.following_count) || 0;
    const totalFavorited = Number(u.total_favorited) || 0;
    // 老接口无站内 follower_count，用 web 展示口径的 mplatform_followers_count
    const followerCount =
      Number(u.mplatform_followers_count || u.follower_count) || 0;
    // 抖音号：自定义号 unique_id 优先，回退数字 short_id
    const dyId = u.unique_id || u.short_id || "";
    if (followerCount || followingCount || totalFavorited || dyId) {
      logger.log(
        `[${beijingNow()}] 抖音博主主页统计获取成功（老接口）：粉丝=${followerCount} 关注=${followingCount} 获赞=${totalFavorited} 抖音号=${dyId}`
      );
      return {
        followerCount,
        followingCount,
        totalFavorited,
        dyId,
        // 博主签名：仅非空时下发（空串不覆盖分享页已有的值）
        ...(typeof u.signature === "string" && u.signature.trim()
          ? { sign: u.signature }
          : {}),
      };
    }
  } catch (e) {
    logger.warn(
      `[${beijingNow()}] 抖音博主主页统计老接口失败: ${e.message}`
    );
  }
  return null;
}

/**
 * DoH（HTTPS DNS）兜底解析：本机 UDP DNS 被污染（典型表现：v.douyin.com /
 * www.iesdouyin.com 解析失败或超时，其他域名正常）时，改走 HTTPS 加密 DNS 查询
 * 真实 IP。dns.alidns.com 走标准 HTTPS，通常不受 UDP 污染影响。
 * 返回 IPv4 地址数组；失败返回空数组。
 */
async function resolveHostViaDoh(hostname) {
  try {
    const res = await fetch(
      `https://dns.alidns.com/resolve?name=${encodeURIComponent(hostname)}&type=A`,
      {
        headers: { Accept: "application/dns-json" },
        signal: AbortSignal.timeout(5000),
      }
    );
    const json = await res.json();
    return (json.Answer || [])
      .filter((a) => a.type === 1)
      .map((a) => a.data);
  } catch {
    return [];
  }
}

/**
 * 指定 IP 直连的 HTTPS GET（绕过系统 DNS 污染）：host/servername 用真实域名
 * 保证 SNI 与 Host 正确，仅消费响应头即可 —— 抖音短链用 302 返回 Location。
 */
function httpsGetViaIp(hostname, ip, pathname, headers) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: ip,
        servername: hostname,
        path: pathname,
        method: "GET",
        // 必须显式带 Host 头：Node 在 host 为 IP 时默认 Host 头是 IP，
        // CDN 按 Host 路由会直接 403
        headers: { ...headers, Host: hostname },
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode, location: res.headers.location });
      }
    );
    req.setTimeout(8000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

/**
 * 从 URL 中提取视频 ID 和完整重定向 URL
 * 返回 { id, type, redirectUrl } 或 null
 * （网络相关逻辑保留在路由层，提取/解析纯函数见 lib/douyin-extract.js）
 */
async function extractIdAndRedirectUrl(url) {
  try {
    const response = await fetch(url, {
      headers: MOBILE_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });
    const finalUrl = response.url || url;

    // 用户主页分享链接（短链跳转到 /share/user/MS4wLjAB...）：
    // 无视频 ID 可提取，返回标记供调用方给出明确报错
    if (isUserProfileUrl(finalUrl)) {
      return { type: "user" };
    }

    // 从响应头收集匿名 ttwid（首次访问抖音会自动下发，无需登录）。
    // 优先复用跨请求缓存，减少短链握手请求；响应头里的新值用于刷新缓存。
    let ttwid = getCachedTtwid();
    const freshTtwid = extractTtwid(response);
    if (freshTtwid) rememberTtwid(freshTtwid);
    if (!ttwid) ttwid = freshTtwid;

    // 从最终 URL 中提取 ID
    const result = extractIdFromUrl(finalUrl);
    if (result) return { ...result, redirectUrl: finalUrl, ttwid };

    // 如果 URL 中找不到，尝试从 HTML 中找
    const html = await response.text();
    const videoCanonical = html.match(
      /href="https:\/\/www\.iesdouyin\.com\/share\/video\/(\d+)/
    );
    if (videoCanonical) {
      return { id: videoCanonical[1], type: "video", redirectUrl: finalUrl, ttwid };
    }
    const noteCanonical = html.match(
      /href="https:\/\/www\.iesdouyin\.com\/share\/note\/(\d+)/
    );
    if (noteCanonical) {
      return { id: noteCanonical[1], type: "note", redirectUrl: finalUrl, ttwid };
    }

    // 尝试从 canonical 中提取
    const canonical = html.match(
      /<link[^>]+rel="canonical"[^>]+href="([^"]+)"/
    );
    if (canonical) {
      const canonicalResult = extractIdFromUrl(canonical[1]);
      if (canonicalResult) {
        return { ...canonicalResult, redirectUrl: canonical[1], ttwid };
      }
    }

    return null;
  } catch (error) {
    // 系统 DNS 解析失败（典型：网络出口对 v.douyin.com 做 DNS 污染，ENOTFOUND
    // 会立即返回）时，用 DoH 解析 IP 直连短链、读 302 Location 提取视频 ID，
    // 让被污染网络下的本地开发也能解析抖音短链。
    const cause = error?.cause || error;
    if (cause?.code === "ENOTFOUND" || cause?.name === "TimeoutError") {
      try {
        const target = new URL(url);
        const ips = await resolveHostViaDoh(target.hostname);
        if (ips.length > 0) {
          const viaIp = await httpsGetViaIp(
            target.hostname,
            ips[0],
            target.pathname,
            MOBILE_HEADERS
          );
          if (viaIp.location) {
            const idResult = extractIdFromUrl(viaIp.location);
            if (idResult) {
              logger.log(
                `[${beijingNow()}] 抖音短链 DNS 兜底成功（DoH 直连）：${target.hostname} -> ${idResult.id}`
              );
              return {
                ...idResult,
                redirectUrl: viaIp.location,
                ttwid: getCachedTtwid(),
              };
            }
          }
        }
      } catch (dohError) {
        logger.warn(
          `[${beijingNow()}] 抖音短链 DoH 兜底解析失败: ${dohError?.message || dohError}`
        );
      }
    }
    logger.error("Error extracting ID:", error);
    // 区分「网络/DNS 不可达」与「链接无效」：前者通常是环境问题（短链域名
    // 被 DNS 污染/出口受限），后者才是用户提供的链接不对，报错需要分开。
    return {
      networkError: true,
      error: error?.message || String(error),
    };
  }
}

export const GET = createApiHandler(douyin);
