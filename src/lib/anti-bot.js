/**
 * 反爬风控工具集 —— 对外抓取（解析外部平台）时的通用防线。
 *
 * 背景：解析类服务的上游抓取来自「单一出口 IP」，个别用户连刷即可把该 IP 打进
 * 目标平台风控（抖音 argus / B站 -352 / 快手页面降级等），导致全站解析失败。
 * per-IP 限流（api-utils.rateLimit）挡不住「多用户合计」，故在此提供平台维度的
 * 节流与风控特征分类，供各平台路由 / 中间件统一使用。
 *
 * 设计：
 * - platformFetchLimiter：滑动窗口节流，key = 平台 route 名。接入点放在
 *   api-middleware 的「缓存未命中、即将真实抓取」分支，缓存命中不消耗配额；
 *   同一 URL 的并发请求共享一次配额（见并发去重）。
 * - classifyRisk：把 403 / 验证码 / JS 风控特征 归为 ip_risked / cookie_stale /
 *   rate_limited / content_gone，供路由决定「报错 / 退避重试 / 换通道」。
 * - sleep：请求节奏平滑（退避重试用）。
 *
 * 环境说明：进程内存实现。Docker/Node 单实例语义精确；Serverless 每 isolate
 * 独立，命中率打折但无害 —— 平台节流作为纵深，边缘层另有 CF Rate Limiting 等兜底。
 */

/** 简单延时（重试退避 / 请求节奏平滑） */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 创建滑动窗口节流器（按 key 分组计数）。
 * @param {{ windowMs?: number, max: number, onBlocked?: (key: string) => void, skipInTest?: boolean }} options
 * @returns {{ take: (key: string) => boolean, reset: () => void }}
 */
export function createSlidingWindowLimiter({
  windowMs = 60_000,
  max,
  onBlocked,
  skipInTest = false,
}) {
  const buckets = new Map(); // key -> number[]（时间戳）
  return {
    /** 尝试取一次配额：成功返回 true，超限返回 false */
    take(key) {
      if (!key) return true;
      if (skipInTest && process.env.VITEST === "true") return true; // 单测高频解析避免误伤
      const now = Date.now();
      const list = (buckets.get(key) || []).filter((t) => now - t < windowMs);
      if (list.length >= max) {
        if (onBlocked) onBlocked(key);
        return false;
      }
      list.push(now);
      buckets.set(key, list);
      return true;
    },
    /** 清空全部计数（测试辅助） */
    reset() {
      buckets.clear();
    },
  };
}

/**
 * 平台级上游抓取节流器：窗口 60s，默认每平台 30 次。
 * 正常用户（含缓存命中）远达不到；连刷脚本 / 突发流量触发后返回 429 请稍后重试，
 * 把对目标平台的请求频率压在不触发风控的区间内。
 */
export const platformFetchLimiter = createSlidingWindowLimiter({
  windowMs: 60_000,
  max: 30,
  skipInTest: true,
  onBlocked: (platform) => {
    console.warn(`[anti-bot] 平台级节流触发: platform=${platform}（保护出口 IP）`);
  },
});

/** 风控响应分类 */
export const RISK_TYPES = {
  OK: "ok", // 正常响应
  RATE_LIMITED: "rate_limited", // 限流（429 / 限流文案）
  IP_RISKED: "ip_risked", // IP 被风控（验证码 / JS 风控壳 / 403）
  COOKIE_STALE: "cookie_stale", // 已带 cookie 仍被风控 → cookie 大概率失效
  CONTENT_GONE: "content_gone", // 内容不存在 / 已删除
  UNKNOWN: "unknown",
};

/**
 * 通用风控特征分类：依据 HTTP 状态码 + 响应体特征，判断一次上游请求是否被反爬拦截。
 * 各平台路由已有更精确的专属检测（如 douyin-extract.isChallengeHtml）时优先用专属检测；
 * 本工具用于尚未覆盖 / 新增平台的通用兜底。
 * @param {{ status?: number, text?: string, hasCookie?: boolean }} input
 * @returns {{ type: string, reasons: string[] }}
 */
export function classifyRisk({ status, text = "", hasCookie = false } = {}) {
  const reasons = [];
  const body = String(text || "").toLowerCase();
  const has = (keywords) => keywords.some((k) => body.includes(k));

  if (status === 429 || has(["too many requests", "请求过于频繁", "rate limit"])) {
    reasons.push("rate_limited");
  }
  if (status === 403 || status === 401) {
    reasons.push("http_forbidden");
  }
  if (has(["验证码", "captcha", "安全验证", "人机", "滑动拼图", "geetest"])) {
    reasons.push("captcha");
  }
  if (has(["_$jsvmprt", "argus-csp-token", "precollect", "__ac_signature"])) {
    reasons.push("js_challenge");
  }
  if (has(["not found", "页面不存在", "已删除", "内容不存在", "404"])) {
    reasons.push("content_gone");
  }

  let type = RISK_TYPES.UNKNOWN;
  if (reasons.includes("rate_limited")) type = RISK_TYPES.RATE_LIMITED;
  else if (reasons.includes("captcha") || reasons.includes("js_challenge")) {
    type = hasCookie ? RISK_TYPES.COOKIE_STALE : RISK_TYPES.IP_RISKED;
  } else if (reasons.includes("http_forbidden")) type = RISK_TYPES.IP_RISKED;
  else if (reasons.includes("content_gone")) type = RISK_TYPES.CONTENT_GONE;
  else if (reasons.length === 0) type = RISK_TYPES.OK;
  return { type, reasons };
}
