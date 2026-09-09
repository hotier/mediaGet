/**
 * 自研音乐搜索 —— 错误类型与统一失败分类（纯逻辑，可单测）。
 */
export const SELF_SEARCH_FAILURE = {
  SOURCE_UNAVAILABLE: "source-unavailable", // source 不在自研搜索白名单
  SOURCES_DOWN: "sources-down", // 该源搜索/取链接口不可用/接口变更/风控
  NOT_FOUND: "not-found", // 曲目无可用音源（下架/该平台无此曲）
  VIP_ONLY: "vip-only", // 曲目为 VIP/付费，免费档拿不到试听直链
};

export class SelfSearchError extends Error {
  constructor(code, msg) {
    super(msg);
    this.name = "SelfSearchError";
    this.code = code;
  }
}
