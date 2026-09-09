/**
 * 自研音乐搜索 —— 错误类型与统一失败分类（纯逻辑，可单测）。
 */
export const SELF_SEARCH_FAILURE = {
  SOURCE_UNAVAILABLE: "source-unavailable", // source 不在自研搜索白名单
  SOURCES_DOWN: "sources-down", // 该源搜索接口不可用/接口变更/风控
};

export class SelfSearchError extends Error {
  constructor(code, msg) {
    super(msg);
    this.name = "SelfSearchError";
    this.code = code;
  }
}
