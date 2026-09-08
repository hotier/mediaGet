// @ts-nocheck
import { describe, it, expect } from "vitest";
import { zzcSign } from "@/lib/qqmusic-sign";
import {
  SONGMID_RE,
  QQMUSIC_FAILURE,
  isQqMusicShortUrl,
  extractSongIds,
  buildSongInfoUrl,
  parseSongInfo,
  buildAlbumCoverUrl,
  randomGuid,
  extractUinFromCookie,
  buildVkeyRequestBody,
  extractPlayUrl,
  classifyQqmusicFailure,
  createQqmusicCookieGuard,
} from "@/lib/qqmusic";

// —— zzc 签名（向量取自参考实现 jixunmoe/qmweb-sign 官方测试） ——

describe("zzcSign：QQ音乐 musicu.fcg 请求签名", () => {
  it.each([
    ["123", "zzcec1b555gzqzg7laztguyjl2bu20r6x1w50c55f60"],
    ["hello world", "zzcfb3415bc4nfoxmd9uik71mkomtubjfjp141a1cbbcc"],
    ["jixun.uk", "zzcf47b78apso27mjjbbzgbof0szikfkvyqc7fc3a2b5"],
  ])("%s → %s", (input, expected) => {
    expect(zzcSign(input)).toBe(expected);
  });

  it("签名以 zzc 开头且整体小写", () => {
    const sign = zzcSign('{"req_0":{}}');
    expect(sign.startsWith("zzc")).toBe(true);
    expect(sign).toBe(sign.toLowerCase());
    // 总长 = zzc(3) + 首段7 + b64段(20字节去 \ / + =，随 payload 21~27) + 尾段8
    expect(sign.length).toBeGreaterThanOrEqual(39);
    expect(sign.length).toBeLessThanOrEqual(45);
  });
});

// —— URL 识别 ——

describe("extractSongIds：四种歌曲链接形态", () => {
  const MID = "0039MnYb0qxYhV";

  it("现网歌曲页 /n/ryqq/songDetail/", () => {
    expect(extractSongIds(`https://y.qq.com/n/ryqq/songDetail/${MID}`)).toEqual({
      songmid: MID,
      songid: "",
    });
  });

  it("现网歌曲页带查询参数与尾斜杠", () => {
    expect(
      extractSongIds(`https://y.qq.com/n/ryqq/songDetail/${MID}?no=1/`)
    ).toEqual({ songmid: MID, songid: "" });
  });

  it("旧版歌曲页 /n/yqq/song/<mid>.html", () => {
    expect(extractSongIds(`https://y.qq.com/n/yqq/song/${MID}.html`)).toEqual({
      songmid: MID,
      songid: "",
    });
  });

  it("App 分享 webview playsong.html（songid + songmid）", () => {
    expect(
      extractSongIds(
        `https://i.y.qq.com/v8/playsong.html?songid=97773&songmid=${MID}&adtag=qqshare`
      )
    ).toEqual({ songmid: MID, songid: "97773" });
  });

  it("仅带 songid 的 webview 链接", () => {
    expect(
      extractSongIds("https://i.y.qq.com/v8/playsong.html?songid=97773")
    ).toEqual({ songmid: "", songid: "97773" });
  });

  it("非 y.qq.com 域名返回 null（mp.weixin.qq.com 不误判）", () => {
    expect(extractSongIds("https://mp.weixin.qq.com/s/abc123")).toBeNull();
    expect(extractSongIds("https://kg.qq.com/node/play?s=abc")).toBeNull();
  });

  it("songmid 含非法字符时丢弃", () => {
    expect(
      extractSongIds("https://y.qq.com/n/ryqq/songDetail/not%20valid!")
    ).toBeNull();
  });

  it("乱串输入不抛异常", () => {
    expect(extractSongIds("")).toBeNull();
    expect(extractSongIds("not a url")).toBeNull();
  });
});

describe("isQqMusicShortUrl：App 分享短链识别", () => {
  it("c6.y.qq.com 短链", () => {
    expect(
      isQqMusicShortUrl("https://c6.y.qq.com/base/fcgi-bin/u?__=AbCdEfGh=")
    ).toBe(true);
  });

  it("歌曲页与外域链接", () => {
    expect(isQqMusicShortUrl(`https://y.qq.com/n/ryqq/songDetail/abc123`)).toBe(
      false
    );
    expect(isQqMusicShortUrl("https://v.douyin.com/abc/")).toBe(false);
    // 无协议裸域名：new URL 抛异常 → 一律不视为短链（后端只收 http(s) 链接）
    expect(isQqMusicShortUrl("y.qq.com/base/fcgi-bin/u?__=x")).toBe(false);
  });
});

// —— 元数据接口组装与解析 ——

describe("buildSongInfoUrl", () => {
  it("songmid 优先", () => {
    expect(buildSongInfoUrl({ songmid: "abc", songid: "1" })).toBe(
      "https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?songmid=abc&format=json"
    );
  });

  it("无 songmid 时用 songid", () => {
    expect(buildSongInfoUrl({ songid: "97773" })).toBe(
      "https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?songid=97773&format=json"
    );
  });
});

const SONG_FIXTURE = {
  code: 0,
  data: [
    {
      mid: "0039MnYb0qxYhV",
      id: 97773,
      name: "晴天",
      singer: [
        { mid: "0025NhlN2yWrP4", name: "周杰伦", type: 0 },
        { mid: "", name: "假声名", type: 1 },
      ],
      album: {
        id: 8220,
        mid: "000MkMni19ClKG",
        name: "叶惠美",
      },
      interval: 269,
      file: { media_mid: "0039MnYb0qxYhV" },
    },
  ],
};

describe("parseSongInfo：响应归一", () => {
  it("提取歌名/歌手/专辑/时长", () => {
    const meta = parseSongInfo(SONG_FIXTURE);
    expect(meta).toEqual({
      songmid: "0039MnYb0qxYhV",
      songid: "97773",
      name: "晴天",
      singers: ["周杰伦", "假声名"],
      albumName: "叶惠美",
      albumMid: "000MkMni19ClKG",
      interval: 269,
    });
  });

  it("空响应/缺 mid 返回 null", () => {
    expect(parseSongInfo(null)).toBeNull();
    expect(parseSongInfo({ code: 0, data: [] })).toBeNull();
    expect(parseSongInfo({ code: 0, data: [{}] })).toBeNull();
  });

  it("album 缺失时字段归零而非抛错", () => {
    const meta = parseSongInfo({
      code: 0,
      data: [{ mid: "00abc", id: 1, name: "x", singer: [] }],
    });
    expect(meta.albumMid).toBe("");
    expect(meta.singers).toEqual([]);
  });
});

describe("buildAlbumCoverUrl", () => {
  it("按 albummid 拼图床地址", () => {
    expect(buildAlbumCoverUrl("000MkMni19ClKG")).toBe(
      "https://y.gtimg.cn/music/photo_new/T002R500x500M000000MkMni19ClKG.jpg"
    );
  });
  it("无 albummid 返回空串", () => {
    expect(buildAlbumCoverUrl("")).toBe("");
  });
});

// —— vkey 接口组装与解析 ——

describe("buildVkeyRequestBody / extractUinFromCookie / randomGuid", () => {
  it("请求体含 songmid/uin/loginflag，签名输入即请求体串", () => {
    const body = buildVkeyRequestBody({ songmid: "0039MnYb0qxYhV", uin: "123" });
    const parsed = JSON.parse(body);
    expect(parsed.req_0.module).toBe("music.vkey.GetVkeyServerBase");
    expect(parsed.req_0.method).toBe("CgiGetVkey");
    expect(parsed.req_0.param.songmid).toEqual(["0039MnYb0qxYhV"]);
    expect(parsed.req_0.param.uin).toBe("123");
    expect(parsed.req_0.param.loginflag).toBe(1);
    expect(parsed.req_0.param.guid).toMatch(/^\d{10}$/);
  });

  it("randomGuid 为 10 位数字", () => {
    for (let i = 0; i < 20; i++) expect(randomGuid()).toMatch(/^\d{10}$/);
  });

  it.each([
    ["uin=o1234567890; qm_keyst=xxx", "1234567890"],
    ["qqmusic_uin=987654321; other=1", "987654321"],
    ["SESSDATA=xxx; uin=abc", "0"],
    ["", "0"],
  ])("extractUinFromCookie(%s) → %s", (cookie, expected) => {
    expect(extractUinFromCookie(cookie)).toBe(expected);
  });
});

describe("extractPlayUrl：vkey 响应解析", () => {
  it("取首个非空 purl 并归一 https", () => {
    const { code, purl } = extractPlayUrl({
      req_0: {
        code: 0,
        data: {
          midurlinfo: [
            { purl: "", songmid: "a" },
            {
              purl: "//dl.stream.qqmusic.qq.com/M800xxx.mp3?vkey=1&guid=2",
              songmid: "b",
            },
          ],
        },
      },
    });
    expect(code).toBe(0);
    expect(purl).toBe("https://dl.stream.qqmusic.qq.com/M800xxx.mp3?vkey=1&guid=2");
  });

  it("路径形态 purl 补 dl.stream 域名", () => {
    const { purl } = extractPlayUrl({
      req_0: { code: 0, data: { midurlinfo: [{ purl: "/M800x.mp3?vkey=1" }] } },
    });
    expect(purl).toBe("https://dl.stream.qqmusic.qq.com/M800x.mp3?vkey=1");
  });

  it("空 purl 与风控码透传", () => {
    const { code, purl } = extractPlayUrl({
      req_0: { code: 500003, subcode: 860100001 },
    });
    expect(code).toBe(500003);
    expect(purl).toBe("");
  });

  it("异常响应返回 null code", () => {
    const { code, purl } = extractPlayUrl(null);
    expect(code).toBeNull();
    expect(purl).toBe("");
  });
});

// —— 失败归类 ——

describe("classifyQqmusicFailure", () => {
  it("元数据缺失 → not-found", () => {
    const f = classifyQqmusicFailure({ metaFound: false });
    expect(f.type).toBe(QQMUSIC_FAILURE.NOT_FOUND);
  });

  it("音频网络异常 → sources-down", () => {
    const f = classifyQqmusicFailure({ metaFound: true, audioError: true });
    expect(f.type).toBe(QQMUSIC_FAILURE.SOURCES_DOWN);
  });

  it("风控码：未配 Cookie → need-cookie；已配 → sign-stale", () => {
    expect(
      classifyQqmusicFailure({ metaFound: true, audioCode: 500003 }).type
    ).toBe(QQMUSIC_FAILURE.NEED_COOKIE);
    expect(
      classifyQqmusicFailure({
        metaFound: true,
        audioCode: 500003,
        cookieConfigured: true,
      }).type
    ).toBe(QQMUSIC_FAILURE.SIGN_STALE);
  });

  it("code 0 但无 purl → vip-only", () => {
    expect(
      classifyQqmusicFailure({ metaFound: true, audioCode: 0, hasPurl: false }).type
    ).toBe(QQMUSIC_FAILURE.VIP_ONLY);
  });

  it("拿到 purl → null", () => {
    expect(
      classifyQqmusicFailure({ metaFound: true, audioCode: 0, hasPurl: true })
    ).toBeNull();
  });
});

// —— Cookie 守卫 ——

describe("createQqmusicCookieGuard", () => {
  it("未配置 Cookie 不累计不告警", () => {
    const guard = createQqmusicCookieGuard({ threshold: 2 });
    expect(guard.note({ configured: false, succeeded: false, challenged: true })).toBe(
      false
    );
    expect(guard.failureStreak).toBe(0);
  });

  it("连续 challenged 失败达阈值只告警一次", () => {
    const warns = [];
    const guard = createQqmusicCookieGuard({ threshold: 3, warn: (n) => warns.push(n) });
    const args = { configured: true, succeeded: false, challenged: true };
    guard.note(args);
    guard.note(args);
    expect(guard.note(args)).toBe(true);
    expect(warns).toEqual([3]);
    expect(guard.note(args)).toBe(false);
    expect(warns).toHaveLength(1);
  });

  it("成功复位计数与告警状态", () => {
    const guard = createQqmusicCookieGuard({ threshold: 2 });
    const fail = { configured: true, succeeded: false, challenged: true };
    guard.note(fail);
    guard.note({ ...fail, succeeded: true });
    expect(guard.failureStreak).toBe(0);
    guard.note(fail);
    guard.note(fail);
    expect(guard.staleAlerted).toBe(true);
  });

  it("非风控失败（VIP-only）不累计", () => {
    const guard = createQqmusicCookieGuard({ threshold: 2 });
    guard.note({ configured: true, succeeded: false, challenged: false });
    expect(guard.failureStreak).toBe(0);
  });
});

// ——songmid 校验规则 ——

describe("SONGMID_RE", () => {
  it.each(["0039MnYb0qxYhV", "abc123"])("接受常规 mid：%s", (mid) => {
    expect(SONGMID_RE.test(mid)).toBe(true);
  });
  it.each(["", "abc!@#", "x"])("拒绝非法 mid：%s", (mid) => {
    expect(SONGMID_RE.test(mid)).toBe(false);
  });
});
