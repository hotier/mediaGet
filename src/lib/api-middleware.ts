// 通用 API 中间件函数
import {
  getCachedResponse,
  setCacheResponse,
  rateLimit,
  isValidUrl,
  sanitizeUrl,
  getClientIP,
  getCorsHeaders,
  logger,
  errorResponse,
  serverErrorResponse,
  parseErrorResponse,
  isBlockedIP,
  beijingNow,
} from "@/lib/api-utils";
import { normalizeResult } from "@/lib/normalize-result";
import { extractUrlFromShareText } from "@/lib/share-text";
import { recordParse } from "@/lib/analytics";
import { honeypotResponse } from "@/lib/honeypot";
import { getResultCache, putResultCache, resultStale } from "@/lib/result-cache";
import { platformFetchLimiter } from "@/lib/anti-bot";

/**
 * 安全的状态码 - 确保在 200-599 范围内
 */
export function safeStatus(code: number): number {
  const num = Number(code);
  if (Number.isNaN(num)) return 500;
  if (num < 200) return 500;
  if (num > 599) return 500;
  return Math.round(num);
}

/**
 * fmt=text 纯文本输出（iOS 快捷指令等轻量调用方使用）：
 * - 成功：输出 "标题\n直链"，直链优先级 data.url → data.videos[0].url（B 站）→ data.images[0]（图文）
 * - 失败：输出错误信息 msg
 * 免去调用方解析 JSON。
 */
export function textModeResponse(result: Record<string, unknown>): string {
  const code = Number(result.code);
  if (code !== 200 || !result.data || typeof result.data !== "object") {
    return String(result.msg ?? "解析失败");
  }
  const d = result.data as Record<string, unknown>;
  const title =
    (typeof d.title === "string" && d.title) ||
    (typeof d.desc === "string" && d.desc) ||
    "未命名内容";
  const videos = Array.isArray(d.videos)
    ? (d.videos as Record<string, unknown>[])
    : [];
  const images = Array.isArray(d.images) ? (d.images as string[]) : [];
  const url =
    (typeof d.url === "string" && d.url) ||
    (typeof videos[0]?.url === "string" && videos[0].url) ||
    (typeof images[0] === "string" && images[0]) ||
    "";
  return [title, url].join("\n");
}

export interface ApiHandlerOptions {
  shouldCache?: boolean;
  responseHeaders?: Record<string, string>;
  // 统一入口专用的共享结果缓存（Cloudflare Cache API，跨 isolate，TTL 24h）：
  // 缓存的是补全 platform 后的最终归一化结果，与 shouldCache 的进程内存缓存隔离；
  // 命中时探测主直链，明确死链（签名过期）视为未命中重新解析。见 lib/result-cache.js
  sharedCache?: boolean;
}

type ParseFunction = (url: string) => Promise<Record<string, unknown> | null> | Record<string, unknown> | null;

// 同一 URL 的并发去重表：key = `${routeName}:${sanitizedUrl}` → 进行中的解析 Promise。
// 多人同时打开同一分享链接时共享同一次上游解析（目标平台只被请求一次），
// 完成后自动移除，下一次同 URL 请求由缓存层（内存 / 共享结果缓存）兜底。
const inflightParses = new Map<string, Promise<Record<string, unknown> | null>>();

// 平台专用路由（/api/douyin 等）的域名白名单（route 名 → 域名后缀 + 中文名）。
// 与 lib/platforms.ts 的 PLATFORM_INFO.domains/shortDomains 对齐（route 名与平台 key 命名
// 不完全一致，如 /api/xhs→小红书、/api/ppxia→皮皮虾，故在此集中维护一份按 route 名的映射）。
// 匹配规则：hostname === d || hostname.endsWith("." + d)，短链域名（v.douyin.com 等）
// 由主域名 douyin.com 的 endsWith 覆盖，无需重复列出。
const ROUTE_DOMAIN_MAP: Record<string, { name: string; hosts: string[] }> = {
  douyin: { name: "抖音", hosts: ["douyin.com", "iesdouyin.com", "snssdk.com", "wtturl.cn"] },
  bilibili: { name: "哔哩哔哩", hosts: ["bilibili.com", "b23.tv"] },
  xhs: { name: "小红书", hosts: ["xiaohongshu.com", "xhslink.com", "xhslink.cn"] },
  kuaishou: { name: "快手", hosts: ["kuaishou.com", "kuaishoup.com"] },
  weibo: { name: "微博", hosts: ["weibo.com"] },
  lvzhou: { name: "绿洲", hosts: ["weibo.cn"] },
  ppxia: { name: "皮皮虾", hosts: ["pipix.com"] },
  pipigx: { name: "皮皮搞笑", hosts: ["pipigx.com"] },
  huoshan: { name: "火山", hosts: ["huoshan.com"] },
  weishi: { name: "微视", hosts: ["weishi.qq.com"] },
  xigua: { name: "西瓜视频", hosts: ["ixigua.com"] },
  zuiyou: { name: "最右", hosts: ["izuiyou.com", "xiaochuankeji.com", "xiaochuankeji.cn"] },
  quanmin: { name: "度小视", hosts: ["quanmin.baidu.com", "xspshare.baidu.com"] },
  lishipin: { name: "梨视频", hosts: ["pearvideo.com"] },
  huya: { name: "虎牙", hosts: ["huya.com"] },
  acfun: { name: "AcFun", hosts: ["acfun.cn"] },
  meipai: { name: "美拍", hosts: ["meipai.com"] },
  doupai: { name: "逗拍", hosts: ["doupai.cc"] },
  quanminkge: { name: "全民K歌", hosts: ["kg.qq.com", "quanmin.kg.qq.com"] },
  sixroom: { name: "六间房", hosts: ["6.cn"] },
  xinpianchang: { name: "新片场", hosts: ["xinpianchang.com"] },
  haokan: { name: "好看视频", hosts: ["haokan.baidu.com", "haokan.hao123.com"] },
  twitter: { name: "X (Twitter)", hosts: ["twitter.com", "x.com", "t.co"] },
  tiktok: { name: "TikTok", hosts: ["tiktok.com", "vm.tiktok.com", "vt.tiktok.com"] },
};

// 通用 API 处理函数
export const createApiHandler = (
  parseFunction: ParseFunction,
  options: ApiHandlerOptions = {}
): ((request: Request) => Promise<Response>) => {
  const {
    shouldCache = true,
    responseHeaders = {},
    sharedCache = false,
  } = options;

  const extraHeaders = {
    ...responseHeaders,
  };

  return async (request: Request): Promise<Response> => {
    const startTime = Date.now();
    // fmt=text 纯文本模式（iOS 快捷指令等轻量调用方）：成功输出 "标题\n直链"，
    // 失败输出错误信息，免去 JSON 解析
    const textMode = new URL(request.url).searchParams.get("fmt") === "text";
    const corsHeaders = getCorsHeaders(request.headers.get('origin') || '') as Record<string, string>;
    const headers = { ...corsHeaders, ...extraHeaders };

    // 统一响应出口：fmt=text 时输出纯文本，否则输出 JSON
    const respond = (body: unknown, status = 200) => {
      if (textMode && body && typeof body === "object" && !Array.isArray(body)) {
        return new Response(
          textModeResponse(body as Record<string, unknown>),
          {
            status,
            headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
          }
        );
      }
      return Response.json(body, { status, headers });
    };

    // 统一入口（/api/parse）内部转发到平台路由时带 x-parse-internal 标记：
    // 此时不重复记录行为分析（避免一次解析写两条 parse/parser 记录），
    // 统计只由最外层请求记录一次。
    const isInternalRequest = request.headers.get("x-parse-internal") === "1";

    // 获取客户端IP
    const clientIP = getClientIP(request);
    logger.log(`API request from IP: ${clientIP}`);

    // 平台使用统计：生产环境 logger.log 不输出，这里用 console.log 确保线上可观测。
    // 从 URL 路径推断平台（如 /api/bilibili -> bilibili），用于排查各平台是否有人使用。
    // routeMatch 提升到函数级，供成功分支的行为分析记录复用。
    let routeMatch: RegExpMatchArray | null = null;
    try {
      const pathname = new URL(request.url).pathname;
      routeMatch = pathname.match(/\/api\/([a-z0-9]+)/i);
      if (routeMatch) {
        console.log(
          `[usage] route=${routeMatch[1]} time=${beijingNow()}`
        );
      }
    } catch {
      // 日志失败不影响主流程
    }

    // IP 黑名单拦截（蜜罐模式）：绕过前端、直连解析接口的爬虫/脚本（名单见 api-utils.js）。
    // 命中不再 403 拒绝，而是返回 200 + 结构化蜜罐数据（宣传公众号），
    // 让脚本误以为抓取成功、继续消费，实际拿到的是引导文案（见 lib/honeypot.ts）。
    // 放在 rateLimit 之前（静态 Set/前缀查询零成本）。
    if (isBlockedIP(clientIP)) {
      logger.warn(`黑名单 IP 命中蜜罐: ip=${clientIP} route=${String(routeMatch?.[1] || "")}`);
      const honeypot = normalizeResult(honeypotResponse(String(routeMatch?.[1] || "")));
      return respond(honeypot);
    }

    // 每次解析打印一条流水日志（console.log 保证生产环境也输出，对齐 [usage] 风格；
    // logger.log 仅开发环境输出，成功解析在生产上会没日志）
    const logParse = (
      status: string,
      code: number | string,
      durationMs: number,
      reason?: string
    ) => {
      const route = String(routeMatch?.[1] || "");
      const safeUrl = sanitizedUrl || "";
      const shortUrl =
        safeUrl.length > 60 ? safeUrl.slice(0, 60) + "..." : safeUrl;
      console.log(
        `[parse] route=${route} time=${beijingNow()} url=${shortUrl} status=${status} code=${code} duration=${durationMs}ms${
          reason ? ` reason=${reason.slice(0, 80)}` : ""
        }`
      );
    };

    // 检查速率限制。
    // 内部平台转发（x-parse-internal，即 unifiedParser 经 platformRoutes 调用
    // /api/parser 的请求）不再重复计数：外层统一入口已计一次，且内部 Request
    // 没有 IP 头会记到 'unknown' 桶，多次解析会把该桶打满导致误判 429。
    if (!isInternalRequest && !rateLimit(clientIP)) {
      return respond(errorResponse("请求过于频繁，请稍后再试", 429), safeStatus(429));
    }

    const { searchParams } = new URL(request.url);
    let url = searchParams.get("url");

    if (!url) {
      return respond(errorResponse("url为空", 400), safeStatus(400));
    }

    // 验证URL格式；支持分享文案：粘贴整段分享文本（含标题/引导语）时自动提取其中链接。
    // 提取逻辑与前端（src/utils/share.ts）共用 src/lib/share-text.ts，保证前后端一致。
    // 注意不能只依赖 isValidUrl 判断：WHATWG URL 解析对含空格/中文的字符串宽容
    // （new URL() 会自动 percent 编码不抛错），分享文案会因此"通过"校验而原样进入解析。
    // 因此无条件先提取，仅当提取结果与原文不同（说明输入是分享文案）时才替换。
    const extracted = extractUrlFromShareText(url);
    if (extracted && extracted !== url) {
      logger.log(`分享文案中提取到链接: ${extracted.substring(0, 80)}`);
      url = extracted;
    } else if (!isValidUrl(url)) {
      return respond(errorResponse("无效的URL格式", 400), safeStatus(400));
    }

    // 安全检查：防止SSRF攻击
    const sanitizedUrl = sanitizeUrl(url);
    if (!sanitizedUrl) {
      logger.warn(`SSRF attempt blocked from IP: ${clientIP}, URL: ${url.substring(0, 100)}`);
      return respond(errorResponse("URL包含不允许访问的地址", 400), safeStatus(400));
    }

    // 平台域名白名单校验：/api/douyin 等专用接口只接受本平台域名链接。
    // 否则任意 URL（如 threads.com）都会被当成抖音尝试解析——先 fetch 外部站、
    // 再报「无法提取视频 ID」，白费流量且报错误导。统一入口（/api/parse）与
    // 内部转发（/api/parser）不在映射表内，跳过（/api/parse 已有 identifyPlatform 校验）。
    const routeName = String(routeMatch?.[1] || "");
    const routeDomain = ROUTE_DOMAIN_MAP[routeName];
    if (routeDomain) {
      try {
        const hostname = new URL(sanitizedUrl).hostname.toLowerCase();
        const isAllowed = routeDomain.hosts.some(
          (d) => hostname === d || hostname.endsWith(`.${d}`)
        );
        if (!isAllowed) {
          logParse(
            "failed",
            400,
            Date.now() - startTime,
            `域名(${hostname})不属于${routeDomain.name}平台`
          );
          logger.warn(
            `平台域名不匹配: route=${routeName} host=${hostname} url=${sanitizedUrl.substring(0, 100)}`
          );
          return respond(
            errorResponse(`该链接（${hostname}）不属于${routeDomain.name}平台，已拒绝解析，请粘贴正确的${routeDomain.name}分享链接`, 400),
            safeStatus(400)
          );
        }
      } catch {
        // URL 已通过 isValidUrl/sanitizeUrl，这里解析失败属异常，按拒绝处理
        return respond(errorResponse("无效的URL格式", 400), safeStatus(400));
      }
    }

    // 统一入口的共享结果缓存：
    // 命中先探测主直链，明确死链（签名过期）视为未命中走重新解析，
    // 避免把过期直链发给前端黑屏
    if (sharedCache) {
      const cachedResult = await getResultCache(sanitizedUrl);
      if (cachedResult) {
        const stale = await resultStale(cachedResult);
        if (!stale) {
          logParse("cache-hit", 200, Date.now() - startTime);
          return respond(cachedResult, safeStatus(cachedResult.code || 200));
        }
        logParse("cache-stale", 200, Date.now() - startTime, "缓存直链已失效，重新解析");
      }
    }

    if (shouldCache) {
      const cached = getCachedResponse(sanitizedUrl);
      if (cached) {
        const duration = Date.now() - startTime;
        logParse("cached", 200, duration);
        return respond(cached);
      }
    }

    // isDedup 提升到 try 外声明：catch 分支也要引用它（判断是否为并发复用请求），
    // 若声明在 try 块内，catch 引用会抛 ReferenceError 并掩盖真实错误
    let isDedup = false;
    try {
      // —— 同一 URL 并发去重 ——
      // 只有第一个请求真实抓取目标平台，后续并发请求复用同一个「解析 Promise」，
      // 完成后自动移出（重复打开由缓存层兜底）。同时把平台级节流挂在「真正要
      // 抓取」的那个请求上，避免并发请求提前耗尽平台配额。
      const inflightKey = `${routeName}:${sanitizedUrl}`;
      let rawResultPromise = inflightParses.get(inflightKey);
      if (rawResultPromise) {
        isDedup = true;
        logParse("dedup", 200, Date.now() - startTime, "同一链接并发请求，复用进行中的解析");
      } else {
        // 平台级上游节流：只统计「缓存未命中、即将真实抓取」的请求，
        // 防止多用户合计把单一出口 IP 打进目标平台风控（见 lib/anti-bot.js）。
        if (!platformFetchLimiter.take(routeName)) {
          logParse("limited", 429, Date.now() - startTime, "平台级节流");
          return respond(errorResponse("该平台解析请求较多，请稍后再试", 429), safeStatus(429));
        }
        // Promise.resolve().then 包装：即使 parseFunction 同步 throw 也转成 rejection
        rawResultPromise = Promise.resolve().then(() => parseFunction(sanitizedUrl));
        inflightParses.set(inflightKey, rawResultPromise);
        rawResultPromise.then(
          () => inflightParses.delete(inflightKey),
          () => inflightParses.delete(inflightKey)
        );
      }

      logger.log(`Parsing URL: ${sanitizedUrl.substring(0, 80)}...`);
      const rawResult = await rawResultPromise;

      if (!rawResult) {
        const duration = Date.now() - startTime;
        logParse("failed", 400, duration, "解析失败（无返回结果）");
        logger.warn(`Parse failed after ${duration}ms for URL: ${sanitizedUrl.substring(0, 80)}`);
        // 失败也记录：便于发现未支持/失效的平台与链接。
        // 注意：必须 await —— CF Workers 响应返回后 isolate 冻结，
        // fire-and-forget 的 Turso 写入请求会被丢弃（线上曾因此零入库）。
        if (!isInternalRequest && !isDedup) {
          await recordParse({
            platform: String(routeMatch?.[1] || ""),
            url: sanitizedUrl,
            ip: clientIP,
            status: "failed",
            reason: "解析失败（无返回结果）",
          }).catch(() => {});
        }
        return respond(parseErrorResponse("解析失败"), safeStatus(400));
      }

      // 统一响应模型：成功结果在出口统一归一化（code=200 + data 统一字段契约）
      const result = normalizeResult(rawResult);

      // 解析结果（成功/失败）异步记录行为分析。
      // 必须 await（同 CF Workers isolate 冻结问题），写入失败静默不影响主流程
      if (result?.code === 200) {
        if (!isInternalRequest && !isDedup) {
          await recordParse({
            platform: String(result.platform || routeMatch?.[1] || ""),
            url: sanitizedUrl,
            ip: clientIP,
            status: "success",
          }).catch(() => {});
        }
        logParse("success", 200, Date.now() - startTime);
      } else {
        if (!isInternalRequest && !isDedup) {
          await recordParse({
            platform: String(result?.platform || routeMatch?.[1] || ""),
            url: sanitizedUrl,
            ip: clientIP,
            status: "failed",
            reason: String(result?.msg || "解析失败"),
          }).catch(() => {});
        }
        logParse(
          "failed",
          Number(result?.code || 0),
          Date.now() - startTime,
          String(result?.msg || "")
        );
      }

      if (shouldCache) {
        setCacheResponse(sanitizedUrl, result);
      }

      // 共享结果缓存：写入最终归一化结果（含 platform），好友/他人再打开同一
      // 分享链接时 24h 内直接命中，不再全量重新解析
      if (sharedCache) {
        await putResultCache(sanitizedUrl, result);
      }

      return respond(result);
    } catch (error: unknown) {
      const duration = Date.now() - startTime;
      const errMsg = error instanceof Error ? error.message : "Unknown error";
      logParse("error", 500, duration, errMsg);
      logger.error(`API error after ${duration}ms:`, errMsg);
      if (!isInternalRequest && !isDedup) {
        await recordParse({
          platform: String(routeMatch?.[1] || ""),
          url: sanitizedUrl,
          ip: clientIP,
          status: "failed",
          reason: errMsg,
        }).catch(() => {});
      }
      return respond(serverErrorResponse(error), safeStatus(500));
    }
  };
};
