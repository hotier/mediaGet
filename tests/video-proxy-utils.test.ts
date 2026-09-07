// @ts-nocheck
import { describe, it, expect } from "vitest";
import { buildVideoProxyUrl, needsVideoProxy } from "@/utils/videoProxy";

/**
 * videoProxy 工具纯逻辑测试（无网络）：
 * 重点覆盖 YouTube 媒体域（googlevideo / Piped pipedproxy）的网络可达性代理判定，
 * 及原有防盗链域名（xhs / douyin / weibo / twimg）判定不回归。
 */
describe("videoProxy utils: needsVideoProxy 域名判定", () => {
  it("YouTube googlevideo 媒体域需要代理（网络可达性）", () => {
    expect(
      needsVideoProxy(
        "https://rr5---sn-npoe7ney.googlevideo.com/videoplayback?expire=1&id=abc"
      )
    ).toBe(true);
    expect(needsVideoProxy("https://googlevideo.com/videoplayback?x=1")).toBe(
      true
    );
  });

  it("Piped pipedproxy 代理域需要代理（子域形态不固定，包含判断）", () => {
    expect(needsVideoProxy("https://pipedproxy.ducks.party/videoplayback?x=1")).toBe(
      true
    );
    expect(
      needsVideoProxy("https://pipedproxy-abc12.leptons.xyz/videoplayback?x=1")
    ).toBe(true);
    expect(
      needsVideoProxy("https://pipedproxy-x.projectsegfau.lt/videoplayback?x=1")
    ).toBe(true);
  });

  it("原防盗链域名判定不回归", () => {
    expect(needsVideoProxy("https://www.douyin.com/aweme/v1/play/?x=1")).toBe(true);
    expect(needsVideoProxy("https://sns-video-qc.xhscdn.com/abc.mp4")).toBe(true);
    expect(needsVideoProxy("https://video.twimg.com/abc.mp4")).toBe(true);
    expect(needsVideoProxy("https://f.video.weibocdn.com/abc.mp4")).toBe(true);
  });

  it("无需代理的直链原样判定为 false", () => {
    // B站 CDN 直链可播
    expect(needsVideoProxy("https://upos-sz-mirror08c.bilivideo.com/abc.m4s")).toBe(
      false
    );
    // YouTube 页面域不是媒体域，不需要代理（如 oEmbed/封面直链场景误传）
    expect(needsVideoProxy("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
      false
    );
    expect(needsVideoProxy("https://i.ytimg.com/vi/abc/maxresdefault.jpg")).toBe(
      false
    );
  });

  it("非法 URL 安全返回 false", () => {
    expect(needsVideoProxy("not a url")).toBe(false);
    expect(needsVideoProxy("")).toBe(false);
  });
});

describe("videoProxy utils: buildVideoProxyUrl 包装", () => {
  it("需要代理的 URL 包装为 /api/video-proxy 并整体编码", () => {
    const u = "https://rr5---sn-npoe7ney.googlevideo.com/videoplayback?x=1&y=2";
    expect(buildVideoProxyUrl(u)).toBe(`/api/video-proxy?url=${encodeURIComponent(u)}`);
  });

  it("无需代理的 URL 原样返回", () => {
    const u = "https://upos-sz-mirror08c.bilivideo.com/abc.m4s";
    expect(buildVideoProxyUrl(u)).toBe(u);
  });
});
