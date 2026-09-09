// kugou 取直链纯逻辑单测（无网络）：URL 组装 / 归一 / 响应解析与失败归类
import { describe, expect, it } from "vitest";
import { SelfSearchError, SELF_SEARCH_FAILURE } from "@/lib/self-search/errors";
import {
  buildKugouPlayUrl,
  kugouCoverUrl,
  normalizeKugouHash,
  parseKugouPlayInfo,
  parseKugouSongInfoMeta,
} from "@/lib/self-search/kugou";

describe("kugou 官方试听直链 · 纯逻辑", () => {
  it("normalizeKugouHash：小写/空格归一为大写 32 位 hex；非法为空", () => {
    expect(normalizeKugouHash("48c685f679ffc7cf08b8a8341ca9db44")).toBe(
      "48C685F679FFC7CF08B8A8341CA9DB44"
    );
    expect(normalizeKugouHash("  48C685F679FFC7CF08B8A8341CA9DB44  ")).toBe(
      "48C685F679FFC7CF08B8A8341CA9DB44"
    );
    expect(normalizeKugouHash("")).toBe("");
    expect(normalizeKugouHash("short")).toBe("");
    expect(normalizeKugouHash("Z".repeat(32))).toBe(""); // 非 hex 字母
  });

  it("buildKugouPlayUrl 指向官方 getSongInfo", () => {
    const url = buildKugouPlayUrl("48C685F679FFC7CF08B8A8341CA9DB44");
    expect(url).toBe(
      "https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=48C685F679FFC7CF08B8A8341CA9DB44"
    );
  });

  it("免费曲：http url 升级 https，返回 br/meta（多歌手走 authors 结构化）", () => {
    const parsed = parseKugouPlayInfo({
      status: 1,
      url: "http://sharefs.kugou.com/202609092258/xxx/file.mp3",
      bitRate: 128,
      songName: "%E6%99%B4%E5%A4%A9",
      authors: [{ author_name: "%E8%93%9D%E5%BF%83%E7%BE%BD" }],
      album_img: "http://imge.kugou.com/stdmusic/{size}/abc.jpg",
      extra: { "128filesize": 2829338 },
    });
    expect(parsed.url).toMatch(/^https:\/\/sharefs\.kugou\.com\//);
    expect(parsed.br).toBe(128);
    expect(parsed.size).toBe(2829338);
    expect(parsed.meta.name).toBe("晴天");
    expect(parsed.meta.artists).toEqual(["蓝心羽"]);
    expect(parsed.meta.coverUrl).toBe("https://imge.kugou.com/stdmusic/400/abc.jpg");
  });

  it("VIP/付费：url 空 + privilege 族 >0 / error 提示 → 归类 vip-only", () => {
    const sample = {
      status: 0,
      url: "",
      error: "需要付费",
      pay_type: 3,
      privilege: 10,
      sqprivilege: 10,
      "128privilege": 10,
      bitRate: 0,
    };
    expect(() => parseKugouPlayInfo(sample)).toThrowError(SelfSearchError);
    try {
      parseKugouPlayInfo(sample);
    } catch (e) {
      expect(e).toBeInstanceOf(SelfSearchError);
      if (e instanceof SelfSearchError) expect(e.code).toBe(SELF_SEARCH_FAILURE.VIP_ONLY);
    }
  });

  it("无 url 且无 VIP 迹象 → not-found", () => {
    try {
      parseKugouPlayInfo({ status: 1, url: "", error: "" });
      expect.unreachable("应抛错");
    } catch (e) {
      expect(e).toBeInstanceOf(SelfSearchError);
      if (e instanceof SelfSearchError) expect(e.code).toBe(SELF_SEARCH_FAILURE.NOT_FOUND);
    }
  });

  it("结构异常（非对象/数组/空）→ sources-down", () => {
    for (const bad of [null, undefined, "text", [], 42]) {
      expect(() => parseKugouPlayInfo(bad)).toThrowError(SelfSearchError);
    }
    try {
      parseKugouPlayInfo("text");
    } catch (e) {
      expect(e).toBeInstanceOf(SelfSearchError);
      if (e instanceof SelfSearchError) expect(e.code).toBe(SELF_SEARCH_FAILURE.SOURCES_DOWN);
    }
  });

  it("parseKugouSongInfoMeta：无 authors 时按、分隔作者名兜底；无封面返回空串", () => {
    const meta = parseKugouSongInfoMeta({
      songName: "广东爱情故事",
      author_name: "%E5%B9%BF%E4%B8%9C%E9%9B%A8%E7%A5%9E%E3%80%81%E6%AF%9B%E4%BC%AF%E5%90%88",
    });
    expect(meta.name).toBe("广东爱情故事");
    expect(meta.artists).toEqual(["广东雨神", "毛伯合"]);
    expect(meta.album).toBe("");
    expect(meta.coverUrl).toBe("");

    expect(parseKugouSongInfoMeta(null)).toEqual({
      name: "",
      artists: [],
      album: "",
      coverUrl: "",
    });
  });

  it("kugouCoverUrl：{size} 模板替换为指定尺寸并升级 https；空输入返回空串", () => {
    expect(kugouCoverUrl("http://imge.kugou.com/stdmusic/{size}/x.jpg", 200)).toBe(
      "https://imge.kugou.com/stdmusic/200/x.jpg"
    );
    expect(kugouCoverUrl("")).toBe("");
    expect(kugouCoverUrl(null)).toBe("");
  });
});
