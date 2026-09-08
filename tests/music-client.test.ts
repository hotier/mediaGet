import { describe, expect, it } from "vitest";
import { lineBaseLabel, musicLineMeta } from "@/lib/music-client";

describe("music 结果「线路」标注（music-client）", () => {
  it("GD 公共实例基址归名为「GD 公共源」，自建基址按 host 展示", () => {
    expect(lineBaseLabel("https://music-api.gdstudio.xyz/api.php")).toBe("GD 公共源");
    expect(lineBaseLabel("https://music-api.example.com/api.php")).toBe(
      "music-api.example.com"
    );
  });

  it("非法 URL 原样兜底", () => {
    expect(lineBaseLabel("not a url")).toBe("not a url");
  });

  it("proxy 通道：文案含「代理 · 基址短名」，悬浮注明命中上游", () => {
    const meta = musicLineMeta({
      kind: "proxy",
      base: "https://music-api.example.com/api.php",
    });
    expect(meta).toEqual({
      text: "代理 · music-api.example.com",
      title: expect.stringContaining("https://music-api.example.com/api.php"),
      direct: false,
    });
  });

  it("proxy 通道命中 GD 公共实例时文案为「代理 · GD 公共源」", () => {
    const meta = musicLineMeta({
      kind: "proxy",
      base: "https://music-api.gdstudio.xyz/api.php",
    });
    expect(meta?.text).toBe("代理 · GD 公共源");
    expect(meta?.title).toContain("同源代理");
  });

  it("direct 通道：文案为「直连 · GD 公共源」，悬浮注明浏览器直连降级", () => {
    const meta = musicLineMeta({
      kind: "direct",
      base: "https://music-api.gdstudio.xyz/api.php",
    });
    expect(meta).toMatchObject({
      text: "直连 · GD 公共源",
      direct: true,
    });
    expect(meta?.title).toContain("浏览器直连");
  });

  it("无线路（链接解析产物等）→ null", () => {
    expect(musicLineMeta(undefined)).toBeNull();
    expect(musicLineMeta(null)).toBeNull();
    expect(musicLineMeta({ kind: "proxy", base: "" })).toBeNull();
  });
});
