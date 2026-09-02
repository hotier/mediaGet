// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import {
  BILI_FAILURE,
  BILI_FAILURE_MSG,
  classifyBiliFailure,
  createBiliCookieGuard,
  createBiliHealthProbe,
} from "@/lib/bilibili-cookie-guard.js";

describe("classifyBiliFailure：失败原因归类", () => {
  it("非 JSON 响应（WAF HTML）且未配 Cookie → no_config，提示重试", () => {
    const out = classifyBiliFailure({ cookieConfigured: false, jsonCode: null });
    expect(out.kind).toBe(BILI_FAILURE.NO_CONFIG);
    expect(out.cookieStale).toBe(false);
    expect(out.msg).toContain("风控");
  });

  it("非 JSON 响应（WAF HTML）且已配 Cookie → cookie_stale（疑似失效）", () => {
    const out = classifyBiliFailure({ cookieConfigured: true, jsonCode: null });
    expect(out.kind).toBe(BILI_FAILURE.COOKIE_STALE);
    expect(out.cookieStale).toBe(true);
  });

  it("-404（稿件不存在）→ not_found，与 Cookie 无关", () => {
    const out = classifyBiliFailure({ cookieConfigured: true, jsonCode: -404 });
    expect(out.kind).toBe(BILI_FAILURE.NOT_FOUND);
    expect(out.cookieStale).toBe(false);
    expect(out.msg).toContain("不存在");
  });

  it("-101 未登录：配 Cookie → cookie_stale；未配 → no_config", () => {
    expect(
      classifyBiliFailure({ cookieConfigured: true, jsonCode: -101 }).kind
    ).toBe(BILI_FAILURE.COOKIE_STALE);
    expect(
      classifyBiliFailure({ cookieConfigured: false, jsonCode: -101 }).kind
    ).toBe(BILI_FAILURE.NO_CONFIG);
  });

  it.each([-352, -412, -799])(
    "风控码 %s：配 Cookie → cookie_stale；未配 → no_config",
    (code) => {
      expect(
        classifyBiliFailure({ cookieConfigured: true, jsonCode: code }).kind
      ).toBe(BILI_FAILURE.COOKIE_STALE);
      expect(
        classifyBiliFailure({ cookieConfigured: false, jsonCode: code }).kind
      ).toBe(BILI_FAILURE.NO_CONFIG);
    }
  );

  it("其它错误码（如 -400）→ other，保持原「解析失败」文案", () => {
    const out = classifyBiliFailure({ cookieConfigured: true, jsonCode: -400 });
    expect(out.kind).toBe(BILI_FAILURE.OTHER);
    expect(out.msg).toBe(BILI_FAILURE_MSG[BILI_FAILURE.OTHER]);
  });

  it("成功码（0）不在本函数语义内（由调用方在成功路径单独处理）", () => {
    const out = classifyBiliFailure({ cookieConfigured: true, jsonCode: 0 });
    expect(out.kind).toBe(BILI_FAILURE.OTHER);
  });
});

describe("createBiliCookieGuard：连续失败告警状态机", () => {
  it("未配置 Cookie 时上报一律不累计、不告警", () => {
    const warn = vi.fn();
    const guard = createBiliCookieGuard({ warn, threshold: 2 });
    guard.note({ configured: false, succeeded: false, challenged: true });
    guard.note({ configured: false, succeeded: false, challenged: true });
    expect(guard.failureStreak).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("连续风控达阈值 → 告警一次；此后不重复告警", () => {
    const warn = vi.fn();
    const guard = createBiliCookieGuard({ warn, threshold: 3 });
    guard.note({ configured: true, succeeded: false, challenged: true });
    guard.note({ configured: true, succeeded: false, challenged: true });
    expect(warn).not.toHaveBeenCalled();
    expect(guard.failureStreak).toBe(2);
    // 第三次触发告警
    guard.note({ configured: true, succeeded: false, challenged: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(guard.failureStreak).toBe(3);
    // 第四次不重复告警
    guard.note({ configured: true, succeeded: false, challenged: true });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("任一次成功解析 → 计数与告警复位", () => {
    const warn = vi.fn();
    const guard = createBiliCookieGuard({ warn, threshold: 3 });
    guard.note({ configured: true, succeeded: false, challenged: true });
    guard.note({ configured: true, succeeded: false, challenged: true });
    guard.note({ configured: true, succeeded: false, challenged: true });
    expect(warn).toHaveBeenCalledTimes(1);
    guard.note({ configured: true, succeeded: true, challenged: false });
    expect(guard.failureStreak).toBe(0);
    expect(guard.staleAlerted).toBe(false);
    // 复位后重新累计又可告警
    guard.note({ configured: true, succeeded: false, challenged: true });
    guard.note({ configured: true, succeeded: false, challenged: true });
    guard.note({ configured: true, succeeded: false, challenged: true });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("非风控失败（视频不存在等）不累计", () => {
    const warn = vi.fn();
    const guard = createBiliCookieGuard({ warn, threshold: 2 });
    guard.note({ configured: true, succeeded: false, challenged: false });
    guard.note({ configured: true, succeeded: false, challenged: false });
    expect(guard.failureStreak).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("reset() 手动清空", () => {
    const guard = createBiliCookieGuard({ threshold: 2 });
    guard.note({ configured: true, succeeded: false, challenged: true });
    expect(guard.failureStreak).toBe(1);
    guard.reset();
    expect(guard.failureStreak).toBe(0);
    expect(guard.staleAlerted).toBe(false);
  });
});

describe("createBiliHealthProbe：nav isLogin 健康探测", () => {
  it("isLogin=true → ok", async () => {
    const fetchNav = vi.fn().mockResolvedValue({
      code: 0,
      data: { isLogin: true },
    });
    const probe = createBiliHealthProbe({ fetchNav });
    await expect(probe()).resolves.toMatchObject({ ok: true, code: 0 });
  });

  it("isLogin=false（Cookie 已过期）→ ok=false", async () => {
    const fetchNav = vi.fn().mockResolvedValue({
      code: 0,
      data: { isLogin: false },
    });
    const probe = createBiliHealthProbe({ fetchNav });
    const res = await probe();
    expect(res.ok).toBe(false);
  });

  it("nav 异常（网络失败/非 JSON）→ ok=false 且不抛错", async () => {
    const fetchNav = vi.fn().mockRejectedValue(new Error("boom"));
    const probe = createBiliHealthProbe({ fetchNav });
    const res = await probe();
    expect(res.ok).toBe(false);
    expect(res.code).toBe(null);
  });

  it("TTL 内缓存：多次调用只探测一次；过期后重新探测", async () => {
    const fetchNav = vi.fn().mockResolvedValue({
      code: 0,
      data: { isLogin: true },
    });
    const probe = createBiliHealthProbe({ fetchNav, ttlMs: 60_000 });
    await probe();
    await probe();
    await probe();
    expect(fetchNav).toHaveBeenCalledTimes(1);

    // 模拟 TTL 过期：改用假定时器推进时间
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 61_000);
      await probe();
      expect(fetchNav).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
