import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createSlidingWindowLimiter,
  classifyRisk,
  RISK_TYPES,
} from "@/lib/anti-bot";

afterEach(() => {
  vi.useRealTimers();
});

describe("anti-bot: sliding window limiter", () => {
  it("allows requests within the max quota", () => {
    const limiter = createSlidingWindowLimiter({ windowMs: 60_000, max: 3 });
    expect(limiter.take("douyin")).toBe(true);
    expect(limiter.take("douyin")).toBe(true);
    expect(limiter.take("douyin")).toBe(true);
  });

  it("blocks requests beyond the max quota", () => {
    const limiter = createSlidingWindowLimiter({ windowMs: 60_000, max: 2 });
    expect(limiter.take("douyin")).toBe(true);
    expect(limiter.take("douyin")).toBe(true);
    expect(limiter.take("douyin")).toBe(false);
  });

  it("counts platforms independently", () => {
    const limiter = createSlidingWindowLimiter({ windowMs: 60_000, max: 1 });
    expect(limiter.take("douyin")).toBe(true);
    expect(limiter.take("bilibili")).toBe(true);
    expect(limiter.take("douyin")).toBe(false);
  });

  it("slides the window: expired timestamps free quota again", () => {
    vi.useFakeTimers();
    const limiter = createSlidingWindowLimiter({ windowMs: 1000, max: 1 });
    expect(limiter.take("douyin")).toBe(true);
    expect(limiter.take("douyin")).toBe(false);
    vi.advanceTimersByTime(1100);
    expect(limiter.take("douyin")).toBe(true);
  });

  it("ignores empty keys", () => {
    const limiter = createSlidingWindowLimiter({ windowMs: 1000, max: 0 });
    expect(limiter.take("")).toBe(true);
    expect(limiter.take(undefined as unknown as string)).toBe(true);
  });
});

describe("anti-bot: classifyRisk", () => {
  it("classifies 429 as rate_limited", () => {
    const { type, reasons } = classifyRisk({ status: 429 });
    expect(type).toBe(RISK_TYPES.RATE_LIMITED);
    expect(reasons).toContain("rate_limited");
  });

  it("classifies js challenge without cookie as ip_risked", () => {
    const { type } = classifyRisk({ text: "window._$jsvmprt started..." });
    expect(type).toBe(RISK_TYPES.IP_RISKED);
  });

  it("classifies js challenge with cookie as cookie_stale", () => {
    const { type } = classifyRisk({ text: "argus-csp-token", hasCookie: true });
    expect(type).toBe(RISK_TYPES.COOKIE_STALE);
  });

  it("classifies captcha page as risked", () => {
    const { type } = classifyRisk({ text: "请完成安全验证" });
    expect(type).toBe(RISK_TYPES.IP_RISKED);
  });

  it("classifies deleted content as content_gone", () => {
    const { type } = classifyRisk({ text: "该内容不存在或已删除" });
    expect(type).toBe(RISK_TYPES.CONTENT_GONE);
  });

  it("treats normal response as ok", () => {
    const { type } = classifyRisk({
      status: 200,
      text: "<html>video data</html>",
    });
    expect(type).toBe(RISK_TYPES.OK);
  });
});
