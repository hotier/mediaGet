import { afterEach, describe, expect, it } from "vitest";
import {
  crossSearchPlayableSourceKeys,
  lineBaseLabel,
  musicLineMeta,
  resetLxCatalogCache,
  setLxCatalogCacheForTest,
  type LxCatalogData,
} from "@/lib/music-client";

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

describe("crossSearchPlayableSourceKeys（跨源现搜来源 B 的候选音源集合）", () => {
  afterEach(() => {
    resetLxCatalogCache();
  });

  it("未加载 lx 目录时 = 内置 GD 三源 + kugou（官方直链默认收录）；tencent/migu 不收", () => {
    expect(crossSearchPlayableSourceKeys()).toEqual([
      "netease",
      "kuwo",
      "joox",
      "kugou",
    ]);
  });

  it("excludeSource 剔除失败源自身（避免同一源上重复现搜）", () => {
    expect(crossSearchPlayableSourceKeys("netease")).toEqual([
      "kuwo",
      "joox",
      "kugou",
    ]);
  });

  it("lx 目录加载后，扩展可搜索源追加到集合尾部；声明同名内置源的条目被忽略", () => {
    setLxCatalogCacheForTest({
      enabled: true,
      scripts: [{ id: "qdy", name: "qdy", url: "" }],
      sources: [
        { key: "qdy", name: "qdy", actions: { musicSearch: {} }, qualitys: ["128k"] },
        { key: "netease", name: "网易云", actions: { musicSearch: {} }, qualitys: [] },
      ],
      searchSources: [
        { key: "qdy", label: "qdy 源" },
        { key: "netease", label: "网易云（内置重名）" },
      ],
      allSourceKeys: ["qdy", "netease"],
    } as unknown as LxCatalogData);

    const keys = crossSearchPlayableSourceKeys();
    expect(keys).toContain("qdy"); // 新增的 lx 扩展源
    expect(keys.indexOf("qdy")).toBeGreaterThanOrEqual(3); // 追加在末尾
    // 目录里声明与内置重名的源不产生第二份：netease/kuwo 只出现一次
    expect(keys.filter((k) => k === "netease")).toHaveLength(1);
    expect(keys.filter((k) => k === "kuwo")).toHaveLength(1);
    expect(keys).not.toContain("migu"); // 无内置直链的自研源不进跨源候选
  });
});
