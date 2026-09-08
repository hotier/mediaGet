// @ts-nocheck
import { describe, it, expect } from "vitest";
import {
  MUSIC_PLATFORM_LABEL,
  MUSIC_PLATFORMS,
  extractMusicUrl,
  parseMusicLink,
  isFollowableShareUrl,
  normalizePlatformKey,
} from "@/lib/music-link";
import {
  appendCoverParam,
  buildNeteaseDetailUrl,
  normalizeNeteaseSongId,
  parseNeteaseDetailJson,
} from "@/lib/netease-meta";

// —— 平台元信息 ——

describe("MUSIC_PLATFORMS 平台元信息", () => {
  it("四平台 label 完整且 netease 标为 ready（当前即可解析播放）", () => {
    expect(MUSIC_PLATFORMS.map((p) => p.key)).toEqual([
      "netease",
      "tencent",
      "kugou",
      "kuwo",
    ]);
    expect(MUSIC_PLATFORMS.find((p) => p.key === "netease")?.resolve).toBe("ready");
    for (const p of MUSIC_PLATFORMS) {
      expect(MUSIC_PLATFORM_LABEL[p.key]).toBeTruthy();
    }
  });
});

// —— 分享文本 URL 抽取 ——

describe("extractMusicUrl", () => {
  it("裸链接原样返回", () => {
    expect(extractMusicUrl("https://music.163.com/song?id=186016")).toBe(
      "https://music.163.com/song?id=186016"
    );
  });

  it("网易云 APP 分享文本：仅取正文首个 http 链接（含 hash 路由）", () => {
    const text =
      "分享周杰伦的单曲《晴天》: https://music.163.com/#/song?id=186016 (@网易云音乐)";
    expect(extractMusicUrl(text)).toBe("https://music.163.com/#/song?id=186016");
  });

  it("链接被引号/括号包裹时剥离包裹字符", () => {
    expect(extractMusicUrl("歌曲链接『https://music.163.com/song?id=186016』")).toBe(
      "https://music.163.com/song?id=186016"
    );
    expect(extractMusicUrl("(https://y.qq.com/n/ryqq/songDetail/0039MnYb0p1iXz)")).toBe(
      "https://y.qq.com/n/ryqq/songDetail/0039MnYb0p1iXz"
    );
  });

  it("URL 尾部黏着 @平台字样时截掉（链接本身完整）", () => {
    expect(extractMusicUrl("https://music.163.com/song?id=186016@网易云音乐")).toBe(
      "https://music.163.com/song?id=186016"
    );
  });

  it("非链接 / 无协议 / 空文本返回空串", () => {
    expect(extractMusicUrl("周杰伦 晴天")).toBe("");
    expect(extractMusicUrl("music.163.com/song?id=186016")).toBe("");
    expect(extractMusicUrl("")).toBe("");
    expect(extractMusicUrl("   ")).toBe("");
    expect(extractMusicUrl(null)).toBe("");
  });

  it("小程序协议等前置噪音不影响抽取首个 http 链接", () => {
    const text =
      "#小程序://网易云音乐/周杰伦/晴天，正文链接 https://music.163.com/song?id=186016";
    expect(extractMusicUrl(text)).toBe("https://music.163.com/song?id=186016");
  });
});

// —— 平台识别与曲目 ID 提取 ——

describe("parseMusicLink · 网易云", () => {
  it.each([
    ["https://music.163.com/song?id=186016", "186016"],
    ["https://y.music.163.com/m/song?id=2652820720", "2652820720"],
    ["https://music.163.com/#/song?id=186016", "186016"],
    ["https://music.163.com/song?id=347230&userid=1", "347230"],
  ])("%s → songId=%s", (url, id) => {
    const r = parseMusicLink(url);
    expect(r?.platform).toBe("netease");
    expect(r?.songId).toBe(id);
  });

  it("短链落地形态：/m/song 的 id 排在 fx-/uct2 等追踪参数中间也能提取", () => {
    const r = parseMusicLink(
      "https://y.music.163.com/m/song?fx-wechatnew=t1&fx-wxqd=&fx-wordtest=&id=26093064&PlayerStyles_SynchronousSharing=t3&H5_DownloadVIPGift=&fx-listentest=t3&uct2=7UBWV1vBfzxSg109a1AgNA==&app_version=9.5.85&dlt=0846"
    );
    expect(r?.platform).toBe("netease");
    expect(r?.songId).toBe("26093064");
  });

  it("song? 后带其它参数（id 非首参）同样可提取", () => {
    expect(
      parseMusicLink("https://music.163.com/song?from=groupmessage&isrc=&id=186016")
        ?.songId
    ).toBe("186016");
  });

  it("歌单 / 歌手页等非单曲链接拒绝（不含 song 片段）", () => {
    expect(parseMusicLink("https://music.163.com/#/playlist?id=1234567890")).toBeNull();
    expect(parseMusicLink("https://music.163.com/song?id=abc")).toBeNull();
  });
});

describe("parseMusicLink · QQ音乐", () => {
  it("y.qq.com 详情页 songDetail 提取 songmid", () => {
    const r = parseMusicLink("https://y.qq.com/n/ryqq/songDetail/0039MnYb0p1iXz");
    expect(r?.platform).toBe("tencent");
    expect(r?.songId).toBe("0039MnYb0p1iXz");
  });

  it("旧版 playsong.html?songmid= 形态", () => {
    const r = parseMusicLink("https://i.y.qq.com/v8/playsong.html?songmid=0039MnYb0qxYhV");
    expect(r?.platform).toBe("tencent");
    expect(r?.songId).toBe("0039MnYb0qxYhV");
  });

  it("QQ 歌单页不误识别为单曲", () => {
    expect(
      parseMusicLink("https://y.qq.com/n/ryqq/playlist/1234567890")
    ).toBeNull();
  });
});

describe("parseMusicLink · 酷狗", () => {
  it("www.kugou.com/song/#hash= 提取 hash", () => {
    const r = parseMusicLink(
      "https://www.kugou.com/song/#hash=1234567890ABCDEF1234567890ABCDEF&album_id=123"
    );
    expect(r?.platform).toBe("kugou");
    expect(r?.songId).toBe("1234567890ABCDEF1234567890ABCDEF");
  });

  it("短链 t1.kugou.com 无 hash 时识别失败（交由 follow 处理）", () => {
    expect(parseMusicLink("https://t1.kugou.com/song.html?id=abc123")).toBeNull();
  });
});

describe("parseMusicLink · 酷我", () => {
  it("play_detail 页面提取 rid", () => {
    const r = parseMusicLink("https://www.kuwo.cn/play_detail/26378264");
    expect(r?.platform).toBe("kuwo");
    expect(r?.songId).toBe("26378264");
  });
  it("URL 带 query 亦可提取", () => {
    const r = parseMusicLink("https://www.kuwo.cn/play_detail/26378264?from=baidu");
    expect(r?.songId).toBe("26378264");
  });
});

describe("parseMusicLink · 不支持的平台 / 脏输入", () => {
  it.each([
    "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://www.bilibili.com/video/BV1xx411c7mD",
    "https://example.com/song?id=123",
    "ftp://music.163.com/song?id=186016",
    "音乐链接",
  ])("拒绝 %s", (url) => {
    expect(parseMusicLink(url)).toBeNull();
  });
  it("超短/空输入拒绝", () => {
    expect(parseMusicLink("")).toBeNull();
    expect(parseMusicLink("https://a.co/x")).toBeNull();
  });
});

describe("isFollowableShareUrl（官方短链重定向白名单）", () => {
  it.each([
    "https://163cn.tv/x1y2Z",
    "https://t1.kugou.com/AbCdEf1234567",
    "https://c.y.qq.com/base/fcgi-bin/u?__=xxxxxx",
  ])("允许 %s", (url) => {
    expect(isFollowableShareUrl(url)).toBe(true);
  });
  it("非短链域 / 非 http 拒绝", () => {
    expect(isFollowableShareUrl("https://music.163.com/song?id=186016")).toBe(false);
    expect(isFollowableShareUrl("https://evil.com/r?u=")).toBe(false);
    expect(isFollowableShareUrl("ftp://163cn.tv/x")).toBe(false);
    expect(isFollowableShareUrl("")).toBe(false);
  });
});

describe("normalizePlatformKey", () => {
  it("大小写/空白归一", () => {
    expect(normalizePlatformKey(" NetEase ")).toBe("netease");
    expect(normalizePlatformKey("KUGOU")).toBe("kugou");
  });
  it("非法值返回空串", () => {
    expect(normalizePlatformKey("baidu")).toBe("");
    expect(normalizePlatformKey("")).toBe("");
    expect(normalizePlatformKey(42)).toBe("");
    expect(normalizePlatformKey(null)).toBe("");
  });
});

// —— 网易官方 song/detail 元数据层 ——

describe("网易云 songId 归一", () => {
  it("接受典型长度数字", () => {
    expect(normalizeNeteaseSongId("186016")).toBe("186016");
    expect(normalizeNeteaseSongId(" 2652820720 ")).toBe("2652820720");
  });
  it("拒绝非纯数字 / 超长 / 空", () => {
    expect(normalizeNeteaseSongId("abc")).toBe("");
    expect(normalizeNeteaseSongId("186016x")).toBe("");
    expect(normalizeNeteaseSongId("")).toBe("");
    expect(normalizeNeteaseSongId("1".repeat(20))).toBe("");
  });
});

describe("buildNeteaseDetailUrl", () => {
  it("携带 id 与 ids=[songId]", () => {
    const u = buildNeteaseDetailUrl("186016");
    expect(u).toBe("https://music.163.com/api/song/detail?id=186016&ids=[186016]");
  });
});

describe("appendCoverParam", () => {
  it("http 统一升级 https 并追加 param 缩略", () => {
    expect(
      appendCoverParam("http://p2.music.126.net/xxx.jpg", 300)
    ).toBe("https://p2.music.126.net/xxx.jpg?param=300y300");
  });
  it("已有 query 时以 & 追加；空/相对路径返回空串", () => {
    expect(
      appendCoverParam("https://p2.music.126.net/a.jpg?x=1", 300)
    ).toBe("https://p2.music.126.net/a.jpg?x=1&param=300y300");
    expect(appendCoverParam("")).toBe("");
    expect(appendCoverParam("/relative.jpg")).toBe("");
  });
});

describe("parseNeteaseDetailJson", () => {
  it("完整字段归一（封面取专辑模糊图并追加 param）", () => {
    const r = parseNeteaseDetailJson({
      songs: [
        {
          name: "晴天",
          artists: [{ name: "周杰伦", img1v1Url: "https://p1.music.126.net/a.jpg" }],
          album: { name: "叶惠美", blurPicUrl: "https://p2.music.126.net/b.jpg" },
          fee: 1,
        },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.meta).toEqual({
      name: "晴天",
      artist: ["周杰伦"],
      album: "叶惠美",
      coverUrl: "https://p2.music.126.net/b.jpg?param=300y300",
    });
  });

  it("无专辑图时回退首艺人头像", () => {
    const r = parseNeteaseDetailJson({
      songs: [{ name: "x", artists: [{ name: "a", img1v1Url: "http://p1.music.126.net/a.jpg" }] }],
    });
    expect(r.ok).toBe(true);
    expect(r.meta.coverUrl).toBe("https://p1.music.126.net/a.jpg?param=300y300");
  });

  it("songs 为空 / 缺失 name → not-found；脏数据 → bad-data", () => {
    expect(parseNeteaseDetailJson({ songs: [] }).kind).toBe("not-found");
    expect(parseNeteaseDetailJson({ songs: [{ id: "1" }] }).kind).toBe("not-found");
    for (const bad of [null, undefined, [], "oops", 42]) {
      expect(parseNeteaseDetailJson(bad).kind).toBe("bad-data");
    }
  });
});
