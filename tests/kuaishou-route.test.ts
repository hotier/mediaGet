// @ts-nocheck
/**
 * 快手专用路由兜底逻辑测试：
 * - 主解析失败（parseKuaishou 返回 null）→ 自动走 public17Parse 兜底
 * - 兜底也失败 → 返回 404 提示
 * - 主解析成功 → 不走兜底直接返回
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/kuaishou/route.js";
import * as kuaishouCore from "@/lib/kuaishouCore";
import * as douyinFallback from "@/lib/douyinFallback";

function makeRequest(url) {
  return new Request(`http://127.0.0.1/api/kuaishou?url=${encodeURIComponent(url)}`, {
    headers: { "x-forwarded-for": "203.0.113.42" },
  });
}

describe("kuaishou route fallback", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.VITEST = "true";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("主解析成功时直接返回，不走兜底", async () => {
    vi.spyOn(kuaishouCore, "parseKuaishou").mockResolvedValue({
      code: 200,
      msg: "解析成功",
      data: { photoUrl: "https://v.kwaicdn.com/x.mp4", source: "main" },
      platform: "kuaishou",
    });
    const fallbackSpy = vi
      .spyOn(douyinFallback, "public17Parse")
      .mockResolvedValue({ ok: true, key: "17change", url: "https://fb.mp4" });

    const res = await GET(makeRequest("https://www.kuaishou.com/short-video/abc123"));
    const json = await res.json();

    expect(json.code).toBe(200);
    expect(json.data.photoUrl).toBe("https://v.kwaicdn.com/x.mp4");
    expect(json.data.source).toBe("main");
    expect(fallbackSpy).not.toHaveBeenCalled();
  });

  it("主解析返回 null 时走 17change 兜底并成功", async () => {
    vi.spyOn(kuaishouCore, "parseKuaishou").mockResolvedValue(null);
    vi.spyOn(douyinFallback, "public17Parse").mockResolvedValue({
      ok: true,
      key: "17change",
      url: "https://v23-3.kwaicdn.com/upic/x.mp4",
      title: "测试视频",
      cover: "https://p66.a.kwimgs.com/cover.jpg",
      author: "测试作者",
    });

    const res = await GET(makeRequest("https://www.kuaishou.com/f/abc123"));
    const json = await res.json();

    expect(json.code).toBe(200);
    expect(json.data.photoUrl).toMatch(/^https?:\/\//);
    expect(json.data.source).toBe("17change");
    expect(json.data.caption).toBe("测试视频");
    expect(json.data.authorName).toBe("测试作者");
  });

  it("主解析失败且兜底也失败时返回 404", async () => {
    vi.spyOn(kuaishouCore, "parseKuaishou").mockResolvedValue(null);
    vi.spyOn(douyinFallback, "public17Parse").mockResolvedValue({
      ok: false,
      error: "17change: 响应无视频地址",
    });

    const res = await GET(makeRequest("https://www.kuaishou.com/f/fallback404"));
    const json = await res.json();

    expect(json.code).toBe(404);
    expect(json.msg).toContain("解析失败");
  });

  it("主解析返回非 200 结果时走兜底", async () => {
    vi.spyOn(kuaishouCore, "parseKuaishou").mockResolvedValue({
      code: 404,
      msg: "解析失败",
      data: null,
    });
    vi.spyOn(douyinFallback, "public17Parse").mockResolvedValue({
      ok: true,
      key: "17change",
      url: "https://v23-3.kwaicdn.com/upic/y.mp4",
    });

    const res = await GET(makeRequest("https://www.kuaishou.com/photo/xyz"));
    const json = await res.json();

    expect(json.code).toBe(200);
    expect(json.data.photoUrl).toBe("https://v23-3.kwaicdn.com/upic/y.mp4");
  });

  it("头像走站内代理：保留 _s 变体、携带 CDN fallback、不外泄内部字段", async () => {
    vi.spyOn(kuaishouCore, "parseKuaishou").mockResolvedValue({
      code: 200,
      msg: "解析成功",
      data: {
        photoUrl: "https://v.kwaicdn.com/x.mp4",
        authorAvatar:
          "https://p2-pro.a.yximgs.com/uhead/AB/2022/09/14/14/x==_s.jpg",
        authorAvatarFallbacks: [
          "https://p1-pro.a.yximgs.com/uhead/AB/2022/09/14/14/x==_s.jpg",
        ],
        coverUrl: "https://p5.a.yximgs.com/upic/x.jpg",
        source: "main",
      },
      platform: "kuaishou",
    });

    // 注意：createApiHandler 对同 URL 有进程内缓存，须用与其它用例不同的链接
    const res = await GET(
      makeRequest("https://www.kuaishou.com/short-video/avatar-fallback")
    );
    const json = await res.json();

    expect(json.code).toBe(200);
    // 头像必须走站内代理
    expect(json.data.authorAvatar).toContain("/api/image?url=");
    // 必须保留 _s 变体（uhead 上 _c/_b/原图变体实测 404，替换会导致破图）
    expect(json.data.authorAvatar).toContain("_s.jpg");
    expect(json.data.authorAvatar).not.toContain("_c.jpg");
    // CDN 备选必须传给代理（主节点如 p2-pro 可能 DNS 失效）
    expect(json.data.authorAvatar).toContain("&fallback=");
    expect(json.data.authorAvatar).toContain("p1-pro.a.yximgs.com");
    // 内部字段不对外暴露
    expect(json.data.authorAvatarFallbacks).toBeUndefined();
    // 封面同样走代理
    expect(json.data.coverUrl).toContain("/api/image?url=");
  });
});