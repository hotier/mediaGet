// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SELF_SEARCH_PAGE_MAX,
  SELF_SEARCH_SOURCE_LIST,
  SELF_SEARCH_SOURCE_LABELS,
  hasSelfSearchNextPage,
  selfSearch,
} from "@/lib/self-search";
import { buildNeteaseSearchForm, parseNeteaseSearch, searchNetease } from "@/lib/self-search/netease";
import {
  buildTencentSearchBody,
  buildTencentSearchUrl,
  parseTencentSearch,
} from "@/lib/self-search/tencent";
import { buildKugouSearchUrl, parseKugouSearch } from "@/lib/self-search/kugou";
import { buildKuwoSearchUrl, parseKuwoSearch } from "@/lib/self-search/kuwo";
import {
  buildMiguSearchUrl,
  createMiguSignature,
  parseMiguSearch,
} from "@/lib/self-search/migu";

/** 简单 JSON 响应（Node 18+ 全局 Response） */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("self-search 统一入口", () => {
  it("支持 5 个源，key 沿用 GD 通道命名", () => {
    expect(SELF_SEARCH_SOURCE_LIST).toEqual([
      "netease",
      "tencent",
      "kugou",
      "kuwo",
      "migu",
    ]);
    expect(SELF_SEARCH_SOURCE_LABELS.kugou).toBe("酷狗音乐");
  });

  it("未知 source → SelfSearchError(source-unavailable)", async () => {
    await expect(selfSearch("zzz", "晴天", 1, 20)).rejects.toMatchObject({
      name: "SelfSearchError",
      code: "source-unavailable",
    });
  });

  it("hasSelfSearchNextPage：total 精确算 + 无 total 按回满整页兜底", () => {
    expect(hasSelfSearchNextPage({ page: 1, limit: 20, read: 20, total: 45 })).toBe(true);
    expect(hasSelfSearchNextPage({ page: 3, limit: 20, read: 5, total: 45 })).toBe(false);
    expect(
      hasSelfSearchNextPage({ page: 1, limit: 20, read: 20, total: 0 })
    ).toBe(true);
    expect(hasSelfSearchNextPage({ page: SELF_SEARCH_PAGE_MAX, limit: 20, read: 20, total: 999 })).toBe(
      false
    );
    expect(hasSelfSearchNextPage({ page: 1, limit: 20, read: 0, total: 0 })).toBe(false);
  });
});

describe("网易云（netease）", () => {
  it("buildNeteaseSearchForm：同一 keyword 加密稳定、分页触发 total 标记", () => {
    const p1 = buildNeteaseSearchForm("晴天", 1, 20);
    const p1b = buildNeteaseSearchForm("晴天", 1, 20);
    const p2 = buildNeteaseSearchForm("别", 1, 20);
    expect(p1.params).toMatch(/^[0-9A-F]+$/);
    expect(p1.params.length).toBeGreaterThanOrEqual(64);
    expect(p1b).toEqual(p1);
    expect(p2.params).not.toBe(p1.params);
    const off = buildNeteaseSearchForm("晴天", 2, 20);
    expect(off.params).not.toBe(p1.params);
  });

  it("parseNeteaseSearch：映射 id/歌手/专辑并把封面升级 https", () => {
    const { items, total } = parseNeteaseSearch({
      code: 200,
      data: {
        totalCount: 33,
        resources: [
          {
            baseInfo: {
              simpleSongData: {
                id: 28815250,
                name: "晴天",
                al: { id: 3363272, name: "叶惠美", picUrl: "http://p1.music.126.net/xx.jpg" },
                ar: [{ name: "周杰伦" }],
              },
            },
          },
          { baseInfo: { simpleSongData: null } },
          { baseInfo: {} },
        ],
      },
    });
    expect(total).toBe(33);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "28815250",
      name: "晴天",
      artist: ["周杰伦"],
      album: "叶惠美",
      pic: "https://p1.music.126.net/xx.jpg",
    });
  });

  it("parseNeteaseSearch：结构异常 → sources-down", () => {
    expect(() => parseNeteaseSearch({ code: 400 })).toThrowError(
      expect.objectContaining({ code: "sources-down" })
    );
  });

  it("searchNetease 编排：POST eapi/batch 并解析", async () => {
    const fetchMock = vi.fn(async (url, init) => {
      expect(String(url)).toContain("interface.music.163.com/eapi/batch");
      expect(init.method).toBe("POST");
      expect(init.body).toContain("params=");
      return jsonResponse({ code: 200, data: { totalCount: 1, resources: [] } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await searchNetease("晴天", 1, 20);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.items).toEqual([]);
  });

  it("searchNetease 编排：网络失败重试后 → sources-down", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    await expect(searchNetease("晴天", 1, 20)).rejects.toMatchObject({
      name: "SelfSearchError",
      code: "sources-down",
    });
  });
});

describe("QQ音乐（tencent）", () => {
  it("buildTencentSearchBody/Url：签名带 zzc 前缀、body 指向搜索模块", () => {
    const body = buildTencentSearchBody("晴天", 2, 20);
    expect(body.req.module).toBe("music.search.SearchCgiService");
    expect(body.req.param.page_num).toBe(2);
    const url = buildTencentSearchUrl(body);
    expect(url.startsWith("https://u.y.qq.com/cgi-bin/musics.fcg?sign=zzc")).toBe(true);
  });

  it("parseTencentSearch：songmid 为 id，专辑封面按 albummid 拼 T002 图床", () => {
    const { items, total } = parseTencentSearch({
      code: 0,
      req: {
        code: 0,
        data: {
          meta: { estimate_sum: 123 },
          body: {
            item_song: [
              {
                mid: "003OUlho2HcRHCy",
                title: "晴天",
                file: { media_mid: "003OUlho2HcRHCy" },
                singer: [{ mid: "0025NhlN2yWrP4", name: "周杰伦" }],
                album: { mid: "004Z8Ihr0JIu5s", name: "叶惠美" },
              },
            ],
          },
        },
      },
    });
    expect(total).toBe(123);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "003OUlho2HcRHCy",
      artist: ["周杰伦"],
      album: "叶惠美",
      pic: "https://y.gtimg.cn/music/photo_new/T002R500x500M000004Z8Ihr0JIu5s.jpg",
    });
  });

  it("parseTencentSearch：专辑为空/「空」时退歌手照，无 media_mid 条目被剔除", () => {
    const { items } = parseTencentSearch({
      code: 0,
      req: {
        code: 0,
        data: {
          meta: {},
          body: {
            item_song: [
              {
                mid: "A1",
                title: "晴",
                file: { media_mid: "A1" },
                singer: [{ mid: "S1", name: "周杰伦" }],
                album: { mid: "空", name: "" },
              },
              { mid: "A2", title: "x", file: {} },
            ],
          },
        },
      },
    });
    expect(items).toHaveLength(1);
    expect(items[0].pic).toContain("T001R500x500M000S1");
  });
});

describe("酷狗（kugou）", () => {
  it("buildKugouSearchUrl：URL 带 keyword/page/pagesize", () => {
    const url = buildKugouSearchUrl("晴天", 2, 30);
    expect(url).toContain("songsearch.kugou.com/song_search_v2");
    expect(url).toContain("keyword=%E6%99%B4%E5%A4%A9&page=2&pagesize=30");
  });

  it("parseKugouSearch：decode 中文、按 Audioid 去重、不带封面", () => {
    const { items, total } = parseKugouSearch({
      error_code: 0,
      data: {
        total: 5,
        lists: [
          {
            Audioid: 12345,
            FileHash: "hashA",
            SongName: "%E6%99%B4%E5%A4%A9",
            AlbumName: "%E5%8F%B6%E6%83%A0%E7%BE%8E",
            Singers: [{ name: "%E5%91%A8%E6%9D%B0%E4%BC%A6" }],
          },
          {
            Audioid: 12345,
            FileHash: "hashA",
            SongName: "dup",
          },
        ],
      },
    });
    expect(total).toBe(5);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "12345",
      name: "晴天",
      album: "叶惠美",
      artist: ["周杰伦"],
      pic: "",
    });
  });

  it("parseKugouSearch：error_code 非 0 → sources-down", () => {
    expect(() => parseKugouSearch({ error_code: -1 })).toThrowError(
      expect.objectContaining({ code: "sources-down" })
    );
  });
});

describe("酷我（kuwo）", () => {
  it("buildKuwoSearchUrl：pn 从 0 开始", () => {
    const url = buildKuwoSearchUrl("晴天", 2, 30);
    expect(url).toContain("search.kuwo.cn/r.s");
    expect(url).toContain("&pn=1&rn=30");
  });

  it("parseKuwoSearch：MUSICRID → 数字 rid，ARTIST 按顿号拆分", () => {
    const { items, total } = parseKuwoSearch({
      TOTAL: "128",
      SHOW: "1",
      abslist: [
        {
          MUSICRID: "MUSIC_123456",
          SONGNAME: "%E6%99%B4%E5%A4%A9",
          ARTIST: "%E5%91%A8%E6%9D%B0%E4%BC%A6%E3%80%81%E7%8E%8B%E5%8A%9B%E5%AE%8F",
          ALBUM: "%E5%8F%B6%E6%83%A0%E7%BE%8E",
        },
      ],
    });
    expect(total).toBe(128);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "123456",
      urlId: "123456",
      lyricId: "123456",
      name: "晴天",
      artist: ["周杰伦", "王力宏"],
      album: "叶惠美",
    });
  });

  it("parseKuwoSearch：TOTAL=0 空对象不算结构异常", () => {
    const { items, total } = parseKuwoSearch({ TOTAL: "0", SHOW: "0" });
    expect(items).toEqual([]);
    expect(total).toBe(0);
  });

  it("parseKuwoSearch：无 abslist 且 TOTAL≠0 → sources-down", () => {
    expect(() => parseKuwoSearch({ TOTAL: "9", SHOW: "0" })).toThrowError(
      expect.objectContaining({ code: "sources-down" })
    );
  });
});

describe("咪咕（migu）", () => {
  it("createMiguSignature：同输入稳定、不同输入变化，返回 32 位 hex 与固定 deviceId", () => {
    const time = "1720000000000";
    const a = createMiguSignature(time, "晴天");
    const b = createMiguSignature(time, "晴天");
    const c = createMiguSignature(time, "别");
    expect(a).toEqual(b);
    expect(a.deviceId).toBe("963B7AA0D21511ED807EE5846EC87D20");
    expect(a.sign).toMatch(/^[0-9a-f]{32}$/);
    expect(c.sign).not.toBe(a.sign);
  });

  it("buildMiguSearchUrl：带 text/pageSize/timestamp/sign 头", () => {
    const { url, headers } = buildMiguSearchUrl("晴天", 2, 20, "1720000000000");
    expect(url).toContain("jadeite.migu.cn/music_search/v3/search/searchAll");
    expect(url).toContain("text=%E6%99%B4%E5%A4%A9");
    expect(url).toContain("pageNo=2");
    expect(url).toContain("pageSize=20");
    expect(headers.timestamp).toBe("1720000000000");
    expect(headers.sign).toMatch(/^[0-9a-f]{32}$/);
  });

  it("parseMiguSearch：取 img3 封面并升级 https，copyrightId 去重", () => {
    const { items, total } = parseMiguSearch({
      code: "000000",
      songResultData: {
        totalCount: "8",
        resultList: [
          [
            {
              songId: "129",
              copyrightId: "60054701923",
              name: "晴天",
              album: "叶惠美",
              singerList: [{ name: "周杰伦" }],
              img3: "http://d.musicapp.migu.cn/cover/1.jpg",
              img1: "http://d.musicapp.migu.cn/cover/x.jpg",
            },
            {
              songId: "130",
              copyrightId: "60054701923",
              name: "dup",
              singerList: [{ name: "周杰伦" }],
            },
          ],
        ],
      },
    });
    expect(total).toBe(8);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "129",
      name: "晴天",
      album: "叶惠美",
      artist: ["周杰伦"],
      pic: "https://d.musicapp.migu.cn/cover/1.jpg",
    });
  });

  it("parseMiguSearch：相对封面补域名前缀；code 非 000000 → sources-down", () => {
    const { items } = parseMiguSearch({
      code: "000000",
      songResultData: {
        resultList: [
          [
            {
              songId: "9",
              copyrightId: "c9",
              name: "n",
              img1: "/MIGUM2.0/v1.0/content/resource/1.jpg",
            },
          ],
        ],
      },
    });
    expect(items[0].pic).toBe(
      "https://d.musicapp.migu.cn/MIGUM2.0/v1.0/content/resource/1.jpg"
    );
    expect(() => parseMiguSearch({ code: "000001" })).toThrowError(
      expect.objectContaining({ code: "sources-down" })
    );
  });
});
