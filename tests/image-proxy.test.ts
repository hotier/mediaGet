// @ts-nocheck
/**
 * 图片代理 CDN 容错测试：
 * - 主地址 fetch 失败/非 2xx 时按序尝试 fallback 备选（快手头像多 CDN 容错）
 * - 备选请求携带对应图床的防盗链 Referer
 * - 全部失败返回 502
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/image/route.js";

const goodJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a]).buffer;

function imageRequest(url, fallback) {
  let qs = `url=${encodeURIComponent(url)}`;
  if (fallback) qs += `&fallback=${encodeURIComponent(fallback)}`;
  return new Request(`http://127.0.0.1/api/image?${qs}`, {
    headers: { "x-forwarded-for": "203.0.113.42" },
  });
}

describe("image proxy CDN fallback", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("主地址失败（5xx）时回退到 fallback 备选，并带快手 Referer", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 502 }))
      .mockResolvedValueOnce(
        new Response(goodJpeg, { headers: { "content-type": "image/jpeg" } })
      );
    vi.stubGlobal("fetch", fetchMock);

    // 注意：代理按主 URL 进程内缓存，各用例需用不同主 URL 避免互相命中
    const res = await GET(
      imageRequest(
        "https://p2-pro.a.yximgs.com/uhead/x1==_s.jpg",
        "https://p1-pro.a.yximgs.com/uhead/x1==_s.jpg"
      )
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");

    const fallbackCall = fetchMock.mock.calls[1];
    expect(fallbackCall[0]).toContain("p1-pro.a.yximgs.com");
    expect(fallbackCall[1].headers.Referer).toBe("https://www.kuaishou.com/");
  });

  it("主地址网络异常（fetch 抛错）时回退到 fallback 备选", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        new Response(goodJpeg, { headers: { "content-type": "image/jpeg" } })
      );
    vi.stubGlobal("fetch", fetchMock);

    const res = await GET(
      imageRequest(
        "https://p2-pro.a.yximgs.com/uhead/x2==_s.jpg",
        "https://p1-pro.a.yximgs.com/uhead/x2==_s.jpg"
      )
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("主地址与备选全部失败时返回 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 404 }))
    );

    const res = await GET(
      imageRequest(
        "https://p2-pro.a.yximgs.com/uhead/x3==_s.jpg",
        "https://p1-pro.a.yximgs.com/uhead/x3==_s.jpg"
      )
    );

    expect(res.status).toBe(502);
    expect(await res.text()).toContain("404");
  });
});
