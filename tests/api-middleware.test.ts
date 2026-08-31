// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createApiHandler } from "@/lib/api-middleware";
import * as apiUtils from "@/lib/api-utils";

describe("api-middleware", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(apiUtils, "rateLimit").mockReturnValue(true);
    vi.spyOn(apiUtils, "isValidUrl").mockReturnValue(true);
    vi.spyOn(apiUtils, "sanitizeUrl").mockImplementation((url) => url);
    vi.spyOn(apiUtils, "getClientIP").mockReturnValue("203.0.113.42");
  });

  it("skips cache lookup when shouldCache is false", async () => {
    const getCacheSpy = vi.spyOn(apiUtils, "getCachedResponse");
    const setCacheSpy = vi.spyOn(apiUtils, "setCacheResponse");
    const parseSpy = vi.fn().mockResolvedValue({ code: 1, msg: "ok" });
    const handler = createApiHandler(parseSpy, {
      shouldCache: false,
      responseHeaders: {
        "Cache-Control": "no-store",
      },
    });

    const req = new Request("http://127.0.0.1/api/bilibili?url=https://www.bilibili.com/video/BV1xx411c7mD");
    const res = await handler(req);
    const json = await res.json();

    // 成功 code 在出口统一归一化为 200（bilibili 原返回 1）
    expect(json.code).toBe(200);
    expect(parseSpy).toHaveBeenCalledTimes(1);
    expect(getCacheSpy).not.toHaveBeenCalled();
    expect(setCacheSpy).not.toHaveBeenCalled();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("uses cache by default", async () => {
    vi.spyOn(apiUtils, "getCachedResponse").mockReturnValue({ code: 1, msg: "cached" });
    const parseSpy = vi.fn();
    const handler = createApiHandler(parseSpy);

    const req = new Request("http://127.0.0.1/api/test?url=https://example.com/video");
    const res = await handler(req);
    const json = await res.json();

    expect(json.msg).toBe("cached");
    expect(parseSpy).not.toHaveBeenCalled();
  });

  it("blocks requests when rate limit exceeded", async () => {
    vi.spyOn(apiUtils, "rateLimit").mockReturnValue(false);
    const parseSpy = vi.fn();
    const handler = createApiHandler(parseSpy);

    const req = new Request("http://127.0.0.1/api/test?url=https://example.com/video");
    const res = await handler(req);

    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.code).toBe(429);
    expect(parseSpy).not.toHaveBeenCalled();
  });

  it("blocks SSRF attempts (sanitizeUrl returns null)", async () => {
    vi.spyOn(apiUtils, "sanitizeUrl").mockReturnValue(null);
    const parseSpy = vi.fn();
    const handler = createApiHandler(parseSpy);

    const req = new Request("http://127.0.0.1/api/test?url=http://192.168.1.1/secret");
    const res = await handler(req);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe(400);
    expect(json.msg).toContain("不允许访问");
    expect(parseSpy).not.toHaveBeenCalled();
  });

  it("returns CORS header for allowed origin (*.hotier.cc.cd)", async () => {
    vi.spyOn(apiUtils, "getCachedResponse").mockReturnValue(null);
    const parseSpy = vi.fn().mockResolvedValue({ code: 1, msg: "ok" });
    const handler = createApiHandler(parseSpy, { shouldCache: false });

    const req = new Request("http://127.0.0.1/api/test?url=https://example.com", {
      headers: { Origin: "https://get.hotier.cc.cd" },
    });
    const res = await handler(req);

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://get.hotier.cc.cd");
  });

  it("does not return CORS header for unauthorized origin", async () => {
    vi.spyOn(apiUtils, "getCachedResponse").mockReturnValue(null);
    const parseSpy = vi.fn().mockResolvedValue({ code: 1, msg: "ok" });
    const handler = createApiHandler(parseSpy, { shouldCache: false });

    const req = new Request("http://127.0.0.1/api/test?url=https://example.com", {
      headers: { Origin: "https://evil-site.com" },
    });
    const res = await handler(req);

    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("allows 抖音跳转域名 link.wtturl.cn（不再 400 拒绝）", async () => {
    // 回归：wtturl.cn 加入 douyin 白名单后，链接应进入解析流程（跳过 400）
    const parseSpy = vi.fn().mockResolvedValue({ code: 1, msg: "ok" });
    const handler = createApiHandler(parseSpy, { shouldCache: false });

    const req = new Request(
      "http://127.0.0.1/api/douyin?url=" +
        encodeURIComponent(
          "https://link.wtturl.cn/?target=https%3A%2F%2Fwww.iesdouyin.com%2Fshare%2Fvideo%2F6891626572860706051"
        )
    );
    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(parseSpy).toHaveBeenCalledTimes(1);
  });

  it("returns honeypot (200 + 演示文案) for blacklisted IP instead of 403", async () => {
    // 黑名单 IP 直连解析接口 → 不再 403，而是 200 + 结构化蜜罐数据（演示文案）
    vi.spyOn(apiUtils, "getClientIP").mockReturnValue("120.42.187.174");
    const parseSpy = vi.fn();
    const handler = createApiHandler(parseSpy, { shouldCache: false });

    const req = new Request("http://127.0.0.1/api/douyin?url=https://v.douyin.com/xxxxx/");
    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(parseSpy).not.toHaveBeenCalled();
    const json = await res.json();
    expect(json.code).toBe(200);
    // 蜜罐标志 + 演示文案 + 引导链接
    expect(json.data.honeypot).toBe(true);
    expect(json.msg).toContain("演示内容");
    expect(json.data.url).toContain("get.hotier.cc.cd");
  });

  it("allows non-blacklisted IP through (regression)", async () => {
    const parseSpy = vi.fn().mockResolvedValue({ code: 1, msg: "ok" });
    const handler = createApiHandler(parseSpy, { shouldCache: false });

    const req = new Request("http://127.0.0.1/api/bilibili?url=https://www.bilibili.com/video/BV1xx411c7mD");
    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(parseSpy).toHaveBeenCalledTimes(1);
  });

  it("fmt=text 成功返回纯文本 '标题\\n直链'", async () => {
    const parseSpy = vi.fn().mockResolvedValue({
      code: 200,
      msg: "解析成功",
      platform: "douyin",
      data: { title: "视频标题", url: "https://v.mp4", cover: "c.jpg" },
    });
    const handler = createApiHandler(parseSpy, { shouldCache: false });

    const req = new Request(
      "http://127.0.0.1/api/douyin?fmt=text&url=" +
        encodeURIComponent("https://v.douyin.com/xxxxx/")
    );
    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(await res.text()).toBe("视频标题\nhttps://v.mp4");
  });

  it("fmt=text B站直链从 videos[0].url 兜底", async () => {
    const parseSpy = vi.fn().mockResolvedValue({
      code: 1,
      msg: "解析成功！",
      title: "B站视频",
      user: { name: "UP主" },
      data: [{ title: "P1", video_url: "https://p1.mp4", duration: 180 }],
    });
    const handler = createApiHandler(parseSpy, { shouldCache: false });

    const req = new Request(
      "http://127.0.0.1/api/bilibili?fmt=text&url=" +
        encodeURIComponent("https://www.bilibili.com/video/BV1xx411c7mD")
    );
    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("B站视频\nhttps://p1.mp4");
  });

  it("fmt=text 解析失败返回错误信息", async () => {
    const parseSpy = vi.fn().mockResolvedValue({ code: 400, msg: "解析失败" });
    const handler = createApiHandler(parseSpy, { shouldCache: false });

    const req = new Request(
      "http://127.0.0.1/api/douyin?fmt=text&url=" +
        encodeURIComponent("https://v.douyin.com/xxxxx/")
    );
    const res = await handler(req);

    // 既有行为：解析器返回失败结果时 HTTP 层为 200，错误码在 body（code=400）
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("解析失败");
  });

  it("无 fmt 参数时仍返回 JSON（回归）", async () => {
    const parseSpy = vi.fn().mockResolvedValue({
      code: 200,
      msg: "解析成功",
      data: { title: "t", url: "u.mp4" },
    });
    const handler = createApiHandler(parseSpy, { shouldCache: false });

    const req = new Request(
      "http://127.0.0.1/api/douyin?url=" + encodeURIComponent("https://v.douyin.com/xxxxx/")
    );
    const res = await handler(req);

    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect((await res.json()).data.url).toBe("u.mp4");
  });

  it("支持分享文案：自动提取其中链接并解析（抖音）", async () => {
    // beforeEach 将 isValidUrl mock 为恒 true，此处恢复真实校验以测试文案提取路径
    vi.spyOn(apiUtils, "isValidUrl").mockImplementation(
      (s) => { try { new URL(s); return true; } catch { return false; } }
    );
    const parseSpy = vi.fn().mockResolvedValue({ code: 1, msg: "ok" });
    const handler = createApiHandler(parseSpy, { shouldCache: false });

    const shareText =
      "【这个视频太有意思了】 复制打开抖音，看看 https://v.douyin.com/xxxxx/ 的作品，太搞笑了";
    const req = new Request(
      "http://127.0.0.1/api/douyin?url=" + encodeURIComponent(shareText)
    );
    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(parseSpy).toHaveBeenCalledWith("https://v.douyin.com/xxxxx/");
  });

  it("支持 B站分享文案：链接后跟全角标点也能提取", async () => {
    vi.spyOn(apiUtils, "isValidUrl").mockImplementation(
      (s) => { try { new URL(s); return true; } catch { return false; } }
    );
    const parseSpy = vi.fn().mockResolvedValue({ code: 1, msg: "ok" });
    const handler = createApiHandler(parseSpy, { shouldCache: false });

    const shareText =
      "【哔哩哔哩】https://b23.tv/AbCdEfZ，复制本条信息打开【哔哩哔哩】App查看精彩内容！";
    const req = new Request(
      "http://127.0.0.1/api/bilibili?url=" + encodeURIComponent(shareText)
    );
    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(parseSpy).toHaveBeenCalledWith("https://b23.tv/AbCdEfZ");
  });

  it("支持快手分享文案：链接后跟空格+中文描述也能提取（new URL 宽容编码的回归）", async () => {
    vi.spyOn(apiUtils, "isValidUrl").mockImplementation(
      (s) => { try { new URL(s); return true; } catch { return false; } }
    );
    const parseSpy = vi.fn().mockResolvedValue({ code: 1, msg: "ok" });
    const handler = createApiHandler(parseSpy, { shouldCache: false });

    const shareText =
      "https://v.kuaishou.com/Ku1rFvu1 你的新版奶爸来了唷\"转场 \"cos \"扁鹊\"\"王者荣耀cos 该作品在快手被播放过49.6万次，点击链接，打开【快手】直接观看！";
    const req = new Request(
      "http://127.0.0.1/api/kuaishou?url=" + encodeURIComponent(shareText)
    );
    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(parseSpy).toHaveBeenCalledWith("https://v.kuaishou.com/Ku1rFvu1");
  });

  it("链接后直接跟中文句号（无空格）也能提取", async () => {
    vi.spyOn(apiUtils, "isValidUrl").mockImplementation(
      (s) => { try { new URL(s); return true; } catch { return false; } }
    );
    const parseSpy = vi.fn().mockResolvedValue({ code: 1, msg: "ok" });
    const handler = createApiHandler(parseSpy, { shouldCache: false });

    const shareText = "https://v.kuaishou.com/Ku1rFvu1。你的新版奶爸来了唷";
    const req = new Request(
      "http://127.0.0.1/api/kuaishou?url=" + encodeURIComponent(shareText)
    );
    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(parseSpy).toHaveBeenCalledWith("https://v.kuaishou.com/Ku1rFvu1");
  });

  it("纯文案无链接时仍返回 400", async () => {
    vi.spyOn(apiUtils, "isValidUrl").mockImplementation(
      (s) => { try { new URL(s); return true; } catch { return false; } }
    );
    const parseSpy = vi.fn();
    const handler = createApiHandler(parseSpy, { shouldCache: false });

    const req = new Request(
      "http://127.0.0.1/api/douyin?url=" + encodeURIComponent("这个视频太有意思了，没有链接")
    );
    const res = await handler(req);

    expect(res.status).toBe(400);
    expect(parseSpy).not.toHaveBeenCalled();
  });
});
