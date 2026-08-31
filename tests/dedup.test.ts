// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createApiHandler } from "@/lib/api-middleware";
import * as apiUtils from "@/lib/api-utils";

describe("api-middleware: same-URL concurrency dedup", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(apiUtils, "rateLimit").mockReturnValue(true);
    vi.spyOn(apiUtils, "isValidUrl").mockReturnValue(true);
    vi.spyOn(apiUtils, "sanitizeUrl").mockImplementation((url) => url);
    vi.spyOn(apiUtils, "getClientIP").mockReturnValue("203.0.113.42");
  });

  it("merges concurrent requests for the same URL into one upstream parse", async () => {
    let release;
    const parseSpy = vi
      .fn()
      .mockImplementation(
        () => new Promise((resolve) => (release = resolve))
      );
    const handler = createApiHandler(parseSpy, { shouldCache: false });

    const url = "https://example.com/video/1";
    const req = (u) =>
      new Request(`http://127.0.0.1/api/test?url=${encodeURIComponent(u)}`);
    const p1 = handler(req(url));
    const p2 = handler(req(url));

    // flush 微任务：让第一个请求注册的上游解析真正执行
    await Promise.resolve();
    // 并发窗口内目标平台只应被请求一次
    expect(parseSpy).toHaveBeenCalledTimes(1);

    release({ code: 1, msg: "ok" });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect((await r1.json()).code).toBe(200);
    expect((await r2.json()).code).toBe(200);
    expect(parseSpy).toHaveBeenCalledTimes(1);
  });

  it("parses again for the same URL after the previous one completed", async () => {
    const parseSpy = vi.fn().mockResolvedValue({ code: 1, msg: "ok" });
    const handler = createApiHandler(parseSpy, { shouldCache: false });

    const url = "https://example.com/video/2";
    const req = (u) =>
      new Request(`http://127.0.0.1/api/test?url=${encodeURIComponent(u)}`);
    await handler(req(url));
    await handler(req(url));

    // 第一次完成后 inflight 条目已移除，第二次重新解析
    expect(parseSpy).toHaveBeenCalledTimes(2);
  });
});
