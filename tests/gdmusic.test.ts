// @ts-nocheck
import { describe, it, expect, afterEach } from "vitest";
import {
  GD_MUSIC_API,
  getUpstreamBases,
  GD_SOURCES,
  GD_SOURCE_LIST,
  GD_SEARCH_SOURCE_LIST,
  GD_BRS,
  GD_DEFAULT_SOURCE,
  GD_DEFAULT_BR,
  GD_PIC_SIZES,
  GD_PIC_DEFAULT_SIZE,
  MUSIC_FAILURE,
  isSupportedSource,
  isSearchableSource,
  normalizeBr,
  normalizeSource,
  normalizeId,
  normalizePicId,
  normalizeKeyword,
  normalizeCount,
  normalizePage,
  normalizePicSize,
  buildUpstreamUrl,
  buildTrackUrl,
  buildSearchUrl,
  buildPicUrl,
  parseTrackResponse,
  parseSearchResponse,
  parsePicResponse,
} from "@/lib/gdmusic";

// —— 常量与白名单 ——

describe("GD 音乐源常量", () => {
  it("默认 source=netease，默认 br=999", () => {
    expect(GD_DEFAULT_SOURCE).toBe("netease");
    expect(GD_DEFAULT_BR).toBe(999);
  });

  it("source 清单包含文档列出的主流源", () => {
    for (const s of ["netease", "tencent", "kuwo", "tidal", "qobuz", "joox", "bilibili", "apple", "ytmusic", "spotify"]) {
      expect(GD_SOURCES).toHaveProperty(s);
    }
  });

  it("GD_SOURCE_LIST 与 GD_SOURCES 键一致", () => {
    expect(GD_SOURCE_LIST).toEqual(Object.keys(GD_SOURCES));
  });

  it("br 支持 128/192/320/740/999", () => {
    expect(GD_BRS).toEqual([128, 192, 320, 740, 999]);
  });

  it("pic 封面尺寸仅 300/500，默认 300", () => {
    expect(GD_PIC_SIZES).toEqual([300, 500]);
    expect(GD_PIC_DEFAULT_SIZE).toBe(300);
  });

  it("失败类型枚举完整", () => {
    expect(MUSIC_FAILURE).toEqual({
      NOT_FOUND: "not-found",
      SOURCE_UNAVAILABLE: "source-unavailable",
      SOURCES_DOWN: "sources-down",
    });
  });
});

// —— source / br / id 校验 ——

describe("isSupportedSource", () => {
  it.each([...GD_SOURCE_LIST])("接受 %s", (s) => {
    expect(isSupportedSource(s)).toBe(true);
  });
  it.each(["", "baidu", "qq", "Netease", " netease "])("拒绝 %j", (s) => {
    expect(isSupportedSource(s)).toBe(false);
  });
});

describe("normalizeBr", () => {
  it.each(["128", "192", 320, "740", "999"])("接受 %s", (br) => {
    expect(normalizeBr(br)).toBe(Number(br));
  });
  it.each(["", "0", "96", "abc", null, undefined])("拒绝 %j", (br) => {
    expect(normalizeBr(br)).toBeNull();
  });
});

describe("normalizeSource / normalizeId", () => {
  it("source 转小写去空白", () => {
    expect(normalizeSource(" NetEase ")).toBe("netease");
    expect(normalizeSource("")).toBe("");
  });

  it("id 兼容各源形态（数字/base62/base64）", () => {
    expect(normalizeId("347230")).toBe("347230");
    expect(normalizeId("3Nf9d2xG_aB-")).toBe("3Nf9d2xG_aB-");
    // JOOX 为标准 base64（含 +/=），如 bLnv0PqDX_qAlIqapc+Okw==
    expect(normalizeId("bLnv0PqDX_qAlIqapc+Okw==")).toBe("bLnv0PqDX_qAlIqapc+Okw==");
  });

  it("id 空/超长/含空格控制符被清空", () => {
    expect(normalizeId("")).toBe("");
    expect(normalizeId("  ")).toBe("");
    expect(normalizeId("abc 123")).toBe("");
    expect(normalizeId("a".repeat(200))).toBe("");
    expect(normalizeId("!@#$%^")).toBe("");
  });
});

describe("normalizePicId（pic_id 形态比曲目 id 更宽）", () => {
  it.each([
    "109951173569626660", // 网易云数字
    "120/s3s94/93/211513640.jpg", // 酷我路径型
    "6ceeacac2d30aa13", // JOOX 十六进制
    "da3ff24e-2898-4ac7-b9ab-1f7bb0ee01e4", // JOOX UUID
  ])("接受 %s", (pic) => {
    expect(normalizePicId(pic)).toBe(pic);
  });
  it("空/纯空白/含空格/超长被清空", () => {
    expect(normalizePicId("")).toBe("");
    expect(normalizePicId("  ")).toBe("");
    expect(normalizePicId(" a b")).toBe("");
    expect(normalizePicId("a".repeat(300))).toBe("");
  });
});

// —— 上游 URL 组装 ——

describe("buildTrackUrl", () => {
  it("默认 source=netease & br=999，按 types→source→id→br 排序", () => {
    expect(buildTrackUrl({ id: "347230" })).toBe(
      "https://music-api.gdstudio.xyz/api.php?types=url&source=netease&id=347230&br=999"
    );
  });

  it("指定 source/br 且特殊字符被编码", () => {
    expect(buildTrackUrl({ source: "tencent", id: "0039MnYb0qxYhV", br: 320 })).toBe(
      "https://music-api.gdstudio.xyz/api.php?types=url&source=tencent&id=0039MnYb0qxYhV&br=320"
    );
    expect(buildTrackUrl({ id: "a b" })).toContain("id=a+b");
  });

  it("自定义 base 可注入（单测用），extra 追加在末尾", () => {
    const url = buildUpstreamUrl({
      source: "netease",
      id: "1",
      br: 128,
      base: "http://localhost/api.php",
      count: 3,
    });
    expect(url).toBe("http://localhost/api.php?types=url&source=netease&id=1&br=128&count=3");
    expect(GD_MUSIC_API).toBe("https://music-api.gdstudio.xyz/api.php");
  });
});

// —— types=url 响应解析 ——

describe("parseTrackResponse", () => {
  it("成功：取 http(s) 直链与数字 br/size", () => {
    const r = parseTrackResponse({
      url: "https://m701.music.126.net/xxx.mp3",
      br: 128,
      size: 5217010,
      from: "music.gdstudio.xyz",
    });
    expect(r).toEqual({
      ok: true,
      data: { url: "https://m701.music.126.net/xxx.mp3", br: 128, size: 5217010 },
    });
  });

  it("br/size 缺失时归零而非抛错", () => {
    const r = parseTrackResponse({ url: "http://cdn.example/a.mp3" });
    expect(r.ok).toBe(true);
    expect(r.data.br).toBe(0);
    expect(r.data.size).toBe(0);
  });

  it("url 为空（曲目不存在）→ not-found", () => {
    const r = parseTrackResponse({ url: "", br: 0, size: 0, from: "music.gdstudio.xyz" });
    expect(r).toEqual({ ok: false, kind: "not-found" });
  });

  it("source 非法 → rejected 并带 detail", () => {
    const r = parseTrackResponse({ detail: "Value of `source` is not supported." });
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("rejected");
    expect(r.detail).toContain("not supported");
  });

  it("非对象 / 空响应 → bad-data", () => {
    expect(parseTrackResponse(null).kind).toBe("bad-data");
    expect(parseTrackResponse(undefined).kind).toBe("bad-data");
    expect(parseTrackResponse([]).kind).toBe("bad-data");
    expect(parseTrackResponse("oops").kind).toBe("bad-data");
  });

  it("非 http 开头的 url 不视为成功", () => {
    const r = parseTrackResponse({ url: "//cdn.example/x.mp3" });
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("not-found");
  });
});

// —— types=search 关键词搜索 ——

describe("可搜索 source 白名单（搜索子集）", () => {
  it("包含实测开放的 netease/kuwo/joox", () => {
    expect(GD_SEARCH_SOURCE_LIST).toEqual(["netease", "kuwo", "joox"]);
    for (const s of GD_SEARCH_SOURCE_LIST) {
      expect(isSearchableSource(s)).toBe(true);
      expect(isSupportedSource(s)).toBe(true); // 仍是直链白名单子集
    }
  });
  it("拒绝当前上游未开放搜索的 source", () => {
    for (const s of ["tencent", "apple", "spotify", "ytmusic", "tidal", "baidu", ""]) {
      expect(isSearchableSource(s)).toBe(false);
    }
  });
});

describe("normalizeKeyword", () => {
  it("普通关键词原样保留、收拢多空白", () => {
    expect(normalizeKeyword(" 晴天 ")).toBe("晴天");
    expect(normalizeKeyword("周杰伦  晴天")).toBe("周杰伦 晴天");
  });
  it("空/纯空白/仅控制符/超长均返回空串", () => {
    expect(normalizeKeyword("")).toBe("");
    expect(normalizeKeyword("   ")).toBe("");
    expect(normalizeKeyword("\u0000\u0001")).toBe("");
    expect(normalizeKeyword("a".repeat(101))).toBe("");
  });
});

describe("normalizeCount / normalizePage", () => {
  it("缺失/非法取默认 20，超上限钳制", () => {
    expect(normalizeCount()).toBe(20);
    expect(normalizeCount("abc")).toBe(20);
    expect(normalizeCount("0")).toBe(20);
    expect(normalizeCount("-3")).toBe(20);
    expect(normalizeCount("15")).toBe(15);
    expect(normalizeCount("99")).toBe(20);
  });
  it("页码缺失/非法取 1，超上限钳制 20", () => {
    expect(normalizePage()).toBe(1);
    expect(normalizePage("0")).toBe(1);
    expect(normalizePage("x")).toBe(1);
    expect(normalizePage("2")).toBe(2);
    expect(normalizePage("99")).toBe(20);
  });
});

describe("normalizePicSize", () => {
  it("仅接受 300/500，缺失/非法回落默认 300", () => {
    expect(normalizePicSize()).toBe(300);
    expect(normalizePicSize("300")).toBe(300);
    expect(normalizePicSize(500)).toBe(500);
    expect(normalizePicSize("700")).toBe(300);
    expect(normalizePicSize("abc")).toBe(300);
    expect(normalizePicSize(0)).toBe(300);
  });
});

describe("buildSearchUrl", () => {
  it("默认 source=netease，参数序 types→source→name→pages→count", () => {
    expect(buildSearchUrl({ keyword: "晴天" })).toBe(
      "https://music-api.gdstudio.xyz/api.php?types=search&source=netease&name=%E6%99%B4%E5%A4%A9&pages=1&count=20"
    );
  });
  it("指定 source/page/count，关键词特殊字符被编码", () => {
    const url = buildSearchUrl({
      source: "kuwo",
      keyword: "a b&c",
      page: 2,
      count: 20,
      base: "http://localhost/api.php",
    });
    expect(url).toBe(
      "http://localhost/api.php?types=search&source=kuwo&name=a+b%26c&pages=2&count=20"
    );
  });
});

describe("buildPicUrl", () => {
  it("默认 source=netease & size=300，参数序 types→source→id→size", () => {
    expect(buildPicUrl({ id: "109951173569626660" })).toBe(
      "https://music-api.gdstudio.xyz/api.php?types=pic&source=netease&id=109951173569626660&size=300"
    );
  });
  it("可指定 source/size，路径类 pic_id（酷我）被 URL 编码", () => {
    expect(
      buildPicUrl({ source: "kuwo", id: "120/s3s94/93/211513640.jpg", size: 500 })
    ).toBe(
      "https://music-api.gdstudio.xyz/api.php?types=pic&source=kuwo&id=120%2Fs3s94%2F93%2F211513640.jpg&size=500"
    );
  });
});

describe("parseSearchResponse", () => {
  it("成功：数组归一为 items（url_id 优先作直链 id，pic_id 透传）", () => {
    const r = parseSearchResponse([
      {
        id: "2652820720",
        name: "晴天",
        artist: ["周杰伦"],
        album: "叶惠美",
        pic_id: "109951173569626660",
        url_id: "2652820720",
        source: "netease",
      },
      {
        id: "abc123",
        name: "晴天 (Cover)",
        artist: ["小汤圆"],
        album: "",
        url_id: "different_id",
        source: "netease",
      },
    ]);
    expect(r.ok).toBe(true);
    expect(r.items).toEqual([
      {
        id: "2652820720",
        urlId: "2652820720",
        picId: "109951173569626660",
        name: "晴天",
        artist: ["周杰伦"],
        album: "叶惠美",
        source: "netease",
        lyricId: "2652820720",
      },
      {
        id: "abc123",
        urlId: "different_id",
        name: "晴天 (Cover)",
        artist: ["小汤圆"],
        album: "",
        picId: "",
        source: "netease",
        lyricId: "abc123",
      },
    ]);
  });

  it("artist 为字符串时包一层数组；缺失 album/source/pic_id 归一为空串", () => {
    const r = parseSearchResponse([{ id: "1", name: "x", artist: "独唱" }]);
    expect(r.ok).toBe(true);
    expect(r.items[0].artist).toEqual(["独唱"]);
    expect(r.items[0].album).toBe("");
    expect(r.items[0].source).toBe("");
    expect(r.items[0].picId).toBe("");
  });

  it("脏条目（缺 id/歌名）被过滤，空数组合法返回空 items", () => {
    const r = parseSearchResponse([{ name: "no-id" }, { id: "no-name" }, 42, null]);
    expect(r.ok).toBe(true);
    expect(r.items).toEqual([]);
  });

  it("source 非法 → rejected 并带 detail", () => {
    const r = parseSearchResponse({ detail: "Value of `source` is not supported." });
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("rejected");
  });

  it("非数组/空响应 → bad-data", () => {
    for (const bad of [null, undefined, "oops", { code: 1 }, 123]) {
      expect(parseSearchResponse(bad).kind).toBe("bad-data");
    }
  });
});

// —— types=pic 专辑封面换取 ——

describe("parsePicResponse", () => {
  it("成功：http 封面统一升级 https（酷我图床返回 http）", () => {
    const r = parsePicResponse({
      url: "http://img2.kuwo.cn/star/albumcover/300/s3s94/93/211513640.jpg",
      from: "music.gdstudio.xyz",
    });
    expect(r).toEqual({
      ok: true,
      url: "https://img2.kuwo.cn/star/albumcover/300/s3s94/93/211513640.jpg",
    });
  });
  it("成功：https 封面原样保留", () => {
    const r = parsePicResponse({
      url: "https://p2.music.126.net/F0fTkmBTVykCa2o7Vgu1rQ==/109951173569626660.jpg?param=300y300",
    });
    expect(r.ok).toBe(true);
    expect(r.url).toContain("https://p2.music.126.net/");
  });
  it("url 为空（无封面）→ not-found", () => {
    expect(parsePicResponse({ url: "" }).kind).toBe("not-found");
  });
  it("source 非法 → rejected 并带 detail", () => {
    const r = parsePicResponse({ detail: "Value of `source` is not supported." });
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("rejected");
  });
  it("非对象 / 空响应 → bad-data", () => {
    for (const bad of [null, undefined, [], "oops", 123]) {
      expect(parsePicResponse(bad).kind).toBe("bad-data");
    }
  });
});

// —— 上游多基址链配置（getUpstreamBases） ——

describe("getUpstreamBases 多源链配置", () => {
  const DEFAULT_BASE = "https://music-api.gdstudio.xyz/api.php";

  afterEach(() => {
    delete process.env.MUSIC_API_BASE;
    delete process.env.MUSIC_API_BASES;
  });

  it("未配置任何环境变量 → 公共默认实例", () => {
    expect(getUpstreamBases()).toEqual([DEFAULT_BASE]);
  });

  it("仅 MUSIC_API_BASE → 单基址链（兼容历史单源覆盖）", () => {
    process.env.MUSIC_API_BASE = "https://self-host.example/api.php/";
    expect(getUpstreamBases()).toEqual(["https://self-host.example/api.php"]);
  });

  it("MUSIC_API_BASES 逗号/空白/中文分隔 → 有序多基址链", () => {
    process.env.MUSIC_API_BASES =
      "https://a.example/api.php, https://b.example/api.php；https://c.example/api.php";
    expect(getUpstreamBases()).toEqual([
      "https://a.example/api.php",
      "https://b.example/api.php",
      "https://c.example/api.php",
    ]);
  });

  it("两变量都配置时以 MUSIC_API_BASES 为准（MUSIC_API_BASE 被忽略）", () => {
    process.env.MUSIC_API_BASES = "https://a.example/api.php";
    process.env.MUSIC_API_BASE = "https://legacy.example/api.php";
    expect(getUpstreamBases()).toEqual(["https://a.example/api.php"]);
  });

  it("重复基址按序去重；非法条目被剔除，全非法时回落默认", () => {
    process.env.MUSIC_API_BASES =
      "https://a.example/api.php,https://a.example/api.php,ftp://bad.example/,/relative/path";
    expect(getUpstreamBases()).toEqual(["https://a.example/api.php"]);

    delete process.env.MUSIC_API_BASES;
    process.env.MUSIC_API_BASE = "  not-a-url  ";
    expect(getUpstreamBases()).toEqual([DEFAULT_BASE]);
  });
});
