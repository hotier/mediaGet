/**
 * B 站 BILIBILI_COOKIE 守卫 —— 低维护 Cookie 方案的核心纯逻辑（无网络依赖，可单测）。
 *
 * 背景：B 站对「无登录态 + 数据中心/海外出口 IP」的 api.bilibili.com 请求会返回
 * -412（WAF 拦成 HTML）/ -352 / -799 等风控；配置含 SESSDATA 的登录 Cookie 是穿透
 * 这类风控的通用手段（实测：无 Cookie 直调 view 被 WAF 拦成 HTML，带登录 Cookie 放行）。
 * 但 Cookie 会过期（有效期数月~1 年，勾选「记住我」可延长）。Cookie 一旦失效，
 * 服务会退化成「无 Cookie 匿名」的风控状态。本模块做两件事：
 *
 *   1. classifyBiliFailure —— 把一次 B 站 API 失败归类为 no_config / cookie_stale /
 *      ip_risked / not_found / other，并产出对访问者友好、对维护者有指向的 msg，
 *      让「该换 Cookie」和「临时风控」一眼可分。
 *   2. createBiliCookieGuard —— 连续失败告警状态机：配置了 Cookie 仍连续命中风控
 *      → 只告警一次的醒目日志（提醒更新 BILIBILI_COOKIE）；任一次成功解析自动复位。
 *      （与 DOUYIN_COOKIE 失效自检同思路，B 站版）
 *   3. createBiliHealthProbe —— 显式健康探测：带 Cookie 请求 /x/web-interface/nav，
 *      其 data.isLogin 精确反映 SESSDATA 是否仍有效（比「连续失败」更快定位）。
 */

/** 失败归类枚举 */
export const BILI_FAILURE = {
  OK: "ok",
  NOT_FOUND: "not_found", // 稿件不存在/已删除（-404），与 Cookie 无关
  NO_CONFIG: "no_config", // 未配置 Cookie 被风控 → 提示维护者配置
  COOKIE_STALE: "cookie_stale", // 已配置 Cookie 仍被风控 → Cookie 疑似失效
  OTHER: "other", // 其余失败（参数错/服务器异常等），保持原「解析失败」
};

/** 各归类对访问者展示的 msg（文案刻意简短；详细运维提示走日志） */
export const BILI_FAILURE_MSG = {
  [BILI_FAILURE.NO_CONFIG]: "B站接口被风控拦截，请稍后重试",
  [BILI_FAILURE.COOKIE_STALE]:
    "B站接口被风控拦截（服务器 Cookie 疑似失效），请稍后重试",
  [BILI_FAILURE.NOT_FOUND]: "视频不存在或已删除",
  [BILI_FAILURE.OTHER]: "解析失败！",
};

/**
 * 把一次失败响应归类。
 * @param {{ cookieConfigured?: boolean, jsonCode?: number|null }} input
 *        jsonCode 为 null 表示响应非 JSON（WAF HTML / -412 形态，bilibiliRequest 返回 null）。
 * @returns {{ kind: string, cookieStale: boolean, msg: string }}
 */
export function classifyBiliFailure({
  cookieConfigured = false,
  jsonCode = null,
} = {}) {
  const stale = () => ({
    kind: BILI_FAILURE.COOKIE_STALE,
    cookieStale: true,
    msg: BILI_FAILURE_MSG[BILI_FAILURE.COOKIE_STALE],
  });
  const noConfig = () => ({
    kind: BILI_FAILURE.NO_CONFIG,
    cookieStale: false,
    msg: BILI_FAILURE_MSG[BILI_FAILURE.NO_CONFIG],
  });

  // 非 JSON（WAF HTML 拦截）：配置了 Cookie 仍被拦 → 大概率 Cookie 失效/被标记
  if (jsonCode === null) {
    return cookieConfigured ? stale() : noConfig();
  }

  switch (jsonCode) {
    case -404: // 稿件不存在/已删除
      return {
        kind: BILI_FAILURE.NOT_FOUND,
        cookieStale: false,
        msg: BILI_FAILURE_MSG[BILI_FAILURE.NOT_FOUND],
      };
    case -101: // 未登录（带失效 SESSDATA 也会触发）
      return cookieConfigured ? stale() : noConfig();
    case -352: // 风控校验失败（环境/凭证不被信任）
    case -412: // 请求被拦截（偶发以 JSON 形态返回）
    case -799: // 空间类接口风控，需登录
      return cookieConfigured ? stale() : noConfig();
    default:
      return {
        kind: BILI_FAILURE.OTHER,
        cookieStale: false,
        msg: BILI_FAILURE_MSG[BILI_FAILURE.OTHER],
      };
  }
}

/**
 * 创建「配置了 Cookie 仍连续命中风控 → 只告警一次」的状态机。
 * @param {{ warn?: (streak: number) => void, threshold?: number }} options
 * @returns {{ note: (e: {configured, succeeded, challenged}) => boolean, reset: () => void }}
 *          note 返回本次是否触发了一次性失效告警。
 */
export function createBiliCookieGuard({ warn, threshold = 5 } = {}) {
  let failureStreak = 0;
  let staleAlerted = false;

  return {
    note({ configured, succeeded, challenged }) {
      if (!configured) return false;
      if (succeeded) {
        // 任一次带 Cookie 的解析成功 → 出口可用，复位计数与告警
        failureStreak = 0;
        staleAlerted = false;
        return false;
      }
      if (!challenged) return false; // 视频不存在等非风控失败不累计
      failureStreak += 1;
      if (failureStreak >= threshold && !staleAlerted) {
        staleAlerted = true;
        if (warn) warn(failureStreak);
        return true;
      }
      return false;
    },
    get failureStreak() {
      return failureStreak;
    },
    get staleAlerted() {
      return staleAlerted;
    },
    reset() {
      failureStreak = 0;
      staleAlerted = false;
    },
  };
}

/**
 * 显式健康探测缓存：带 Cookie 请求 nav 接口，用 data.isLogin 精确判定登录态。
 * @param {{ fetchNav: () => Promise<any>, ttlMs?: number }} options
 * @returns {() => Promise<{ ok: boolean, code: number|null, checkedAt: number }>}
 */
export function createBiliHealthProbe({ fetchNav, ttlMs = 5 * 60 * 1000 }) {
  let cache = null; // { checkedAt, ok, code }
  return async function probeHealth() {
    if (cache && Date.now() - cache.checkedAt < ttlMs) return cache;
    let res = null;
    try {
      res = await fetchNav();
    } catch {
      res = null;
    }
    const ok = Boolean(
      res && res.code === 0 && res.data && res.data.isLogin === true
    );
    cache = {
      checkedAt: Date.now(),
      ok,
      code: res && typeof res.code === "number" ? res.code : null,
    };
    return cache;
  };
}
