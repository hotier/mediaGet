// @ts-nocheck
/**
 * YouTube 纯 HTTP 多源方案 —— 纯函数层单测（不发任何网络请求）
 */
import { describe, it, expect } from "vitest";
import {
  extractVideoId,
  pickYoutubeFormat,
  normalizeBase,
  buildInvidiousCandidates,
  buildPipedCandidates,
  parseInvidiousStreams,
  parsePipedStreams,
  describeYoutubeFailure,
  buildSuccess,
  buildEmbedOnlyResult,
  officialVideosUrl,
  officialChannelsUrl,
  parseV3IsoDuration,
  normalizeV3Video,
  normalizeV3Channel,
} from "@/lib/youtube";

describe("youtube source helpers", () => {
  it("extractVideoId 覆盖分享/短链/Shorts", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s")).toBe(
      "dQw4w9WgXcQ"
    );
    expect(extractVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractVideoId("【推荐】https://youtube.com/shorts/AbC123xYz 快看")).toBe(
      "AbC123xYz"
    );
    expect(extractVideoId("https://example.com/watch?v=x123")).toBeNull();
  });

  it("normalizeBase 兼容裸域名与完整 URL", () => {
    expect(normalizeBase("piped.example.com")).toBe("https://piped.example.com");
    expect(normalizeBase("https://piped.example.com/")).toBe("https://piped.example.com");
    expect(normalizeBase("")).toBe("");
  });

  it("buildInvidiousCandidates 组装带 fields 的 API 地址", () => {
    const list = buildInvidiousCandidates("dQw4w9WgXcQ", ["a.yt", "https://b.yt/"]);
    expect(list).toHaveLength(2);
    expect(list[0].kind).toBe("invidious");
    expect(list[0].url).toBe(
      "https://a.yt/api/v1/videos/dQw4w9WgXcQ?fields=videoId%2Ctitle%2Cauthor%2CauthorId%2CauthorUrl%2CauthorThumbnails%2Cdescription%2ClengthSeconds%2CthumbnailUrl%2CsubCountText%2CviewCount%2ClikeCount%2Cpublished%2CformatStreams%2CadaptiveFormats"
    );
    expect(list[1].url).toContain("https://b.yt/api/v1/videos/");
  });

  it("buildPipedCandidates 组装 /streams 地址", () => {
    const list = buildPipedCandidates("AbC123xYz", ["piped.x.io"]);
    expect(list).toHaveLength(1);
    expect(list[0].kind).toBe("piped");
    expect(list[0].url).toBe("https://piped.x.io/streams/AbC123xYz");
  });

  it("parseInvidiousStreams：合流 / 分离视频 / 分离音频 → 统一 formats", () => {
    const parsed = parseInvidiousStreams({
      title: "测试视频",
      author: "Up主",
      thumbnailUrl: "https://th",
      lengthSeconds: 200,
      // —— B站对齐富信息字段 ——
      authorId: "UCAbC123xYz",
      authorUrl: "/channel/UCAbC123xYz",
      authorThumbnails: [
        { url: "https://av-s", width: 48, height: 48 },
        { url: "https://av-l", width: 176, height: 176 },
      ],
      description: "Invidious 视频简介",
      viewCount: 12345,
      likeCount: 678,
      published: 1700000000,
      subCountText: "1.2M",
      formatStreams: [
        {
          url: "https://fs720",
          container: "mp4",
          type: 'video/mp4; codecs="avc1.4d401f, mp4a.40.2"',
          qualityLabel: "720p",
          resolution: "1280x720",
        },
      ],
      adaptiveFormats: [
        {
          url: "https://v1080",
          container: "mp4",
          type: 'video/mp4; codecs="avc1.640028"',
          qualityLabel: "1080p",
          resolution: "1920x1080",
        },
        {
          url: "https://a140",
          type: 'audio/mp4; codecs="mp4a.40.2"',
          encoding: "mp4a.40.2",
          audioQuality: "AUDIO_QUALITY_MEDIUM",
        },
      ],
    });

    expect(parsed.formats).toHaveLength(3);
    expect(parsed.title).toBe("测试视频");
    expect(parsed.author).toBe("Up主");
    expect(parsed.durationMs).toBe(200000);
    // 富信息归一化：头像取最大宽 / 频道链接补全 / 订阅缩写文本转数字
    expect(parsed.avatar).toBe("https://av-l");
    expect(parsed.authorUrl).toBe("https://www.youtube.com/channel/UCAbC123xYz");
    expect(parsed.desc).toBe("Invidious 视频简介");
    expect(parsed.viewCount).toBe(12345);
    expect(parsed.likeCount).toBe(678);
    expect(parsed.subscriberCount).toBe(1200000);
    expect(parsed.published).toBe(1700000000);

    const [muxed, videoOnly, audioOnly] = parsed.formats;
    expect(muxed).toMatchObject({
      url: "https://fs720",
      acodec: "mp4a",
      height: 720,
      vcodec: expect.stringMatching(/avc1/),
    });
    expect(videoOnly).toMatchObject({ acodec: "none", height: 1080, url: "https://v1080" });
    expect(audioOnly).toMatchObject({ vcodec: "none", acodec: "mp4a", url: "https://a140" });

    // 竞速后仍走原有 pickYoutubeFormat：优先合流 mp4（合流即不再需要分离音轨）
    const { best, audio } = pickYoutubeFormat({ formats: parsed.formats });
    expect(best.url).toBe("https://fs720");
    expect(audio.url).toBe("https://a140");

    // 去掉合流后：退化到 1080 分离流 + 最佳音轨
    const onlySeparate = pickYoutubeFormat({
      formats: [videoOnly, audioOnly],
    });
    expect(onlySeparate.best.url).toBe("https://v1080");
    expect(onlySeparate.audio.url).toBe("https://a140");
  });

  it("parsePipedStreams：分离流映射 + 元数据", () => {
    const parsed = parsePipedStreams({
      title: "Piped Title",
      uploader: "Chan",
      thumbnailUrl: "https://th2",
      duration: 90,
      // —— B站对齐富信息字段 ——
      description: "Piped 视频简介",
      uploaderUrl: "/channel/UCabc123XYZ",
      uploaderAvatar: "https://avatar-yt",
      uploaderSubscriberCount: 88400,
      uploadDate: "2024-05-01T10:00:00.000Z",
      views: 999,
      likes: 88,
      videoStreams: [
        {
          url: "https://pv",
          quality: "720p",
          videoOnly: true,
          mimeType: 'video/webm; codecs="vp9"',
          bitrate: 1500000,
        },
      ],
      audioStreams: [
        { url: "https://pa", mimeType: 'audio/webm; codecs="opus"', bitrate: 128000 },
      ],
    });

    expect(parsed.durationMs).toBe(90000);
    expect(parsed.formats).toHaveLength(2);
    // 富信息归一化：Piped 字段名 → 与 Invidious 一致的统一输出
    expect(parsed.avatar).toBe("https://avatar-yt");
    expect(parsed.authorUrl).toBe("https://www.youtube.com/channel/UCabc123XYZ");
    expect(parsed.desc).toBe("Piped 视频简介");
    expect(parsed.viewCount).toBe(999);
    expect(parsed.likeCount).toBe(88);
    expect(parsed.subscriberCount).toBe(88400);
    expect(parsed.published).toBe("2024-05-01T10:00:00.000Z");
    const [v, a] = parsed.formats;
    expect(v).toMatchObject({
      url: "https://pv",
      acodec: "none",
      height: 720,
      vcodec: expect.stringMatching(/vp9/),
    });
    expect(a).toMatchObject({ vcodec: "none", acodec: "mp4a", url: "https://pa", abr: 128 });
  });

  it("空/异常响应不崩溃", () => {
    expect(parseInvidiousStreams(null).formats).toEqual([]);
    expect(parseInvidiousStreams({}).formats).toEqual([]);
    expect(parsePipedStreams({ error: "Video unavailable" }).formats).toEqual([]);
    expect(parsePipedStreams("oops").formats).toEqual([]);
  });
});

describe("buildEmbedOnlyResult 官方嵌入降级", () => {
  it("oEmbed 确认存在但无直链 → 无 url/audioUrl 的嵌入成功结果", () => {
    const r = buildEmbedOnlyResult("dQw4w9WgXcQ", {
      ok: true,
      title: "测试标题",
      author: "作者",
      cover: "https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      authorUrl: "https://www.youtube.com/@作者频道",
    });
    expect(r.code).toBe(200);
    expect(r.data).toMatchObject({
      videoId: "dQw4w9WgXcQ",
      embedUrl: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
      title: "测试标题",
      author: "作者",
      authorUrl: "https://www.youtube.com/@作者频道",
      type: "video",
      embedOnly: true,
      source: "oembed",
    });
    expect(r.data.url).toBeUndefined();
    expect(r.data.audioUrl).toBeUndefined();
    // oEmbed 降级只能拿到频道主页，简介/统计/头像等富字段不虚报为空
    expect(r.data.desc).toBeUndefined();
    expect(r.data.avatar).toBeUndefined();
    expect(r.data.subscriberCount).toBeUndefined();
    expect(r.data.authorId).toBeUndefined();
    expect(r.data.sign).toBeUndefined();
    expect(r.data.videoCount).toBeUndefined();
    expect(r.data.channelViews).toBeUndefined();
  });

  it("缺省元数据有兜底默认值", () => {
    const r = buildEmbedOnlyResult("AbC123xYz", { ok: true });
    expect(r.data.title).toBe("YouTube 视频");
    expect(r.data.embedOnly).toBe(true);
  });
});

describe("describeYoutubeFailure 失败分类", () => {
  it("实例返回 LOGIN_REQUIRED/Sign in to confirm → bot-gated 提示", () => {
    const attempts = [
      {
        tag: "piped:pipedapi.ducks.party",
        ok: false,
        status: 500,
        reason:
          "SignInConfirmNotBotException: YouTube probably temporarily blocked anonymous watch access with this IP, got error LOGIN_REQUIRED: \"Sign in to confirm that you're not a bot\"",
      },
      { tag: "piped:pipedapi.leptons.xyz", ok: false, status: 502, reason: "Error 502: Bad gateway" },
    ];
    const f = describeYoutubeFailure(attempts, { ok: true });
    expect(f.type).toBe("bot-gated");
    expect(f.msg).toContain("登录验证");
  });

  it("age-restricted 文案同样识别为 bot-gated", () => {
    const f = describeYoutubeFailure(
      [{ tag: "piped:x", ok: false, status: 500, reason: "Video is age-restricted" }],
      { ok: true }
    );
    expect(f.type).toBe("bot-gated");
  });

  it("oEmbed 正常但实例全部不可用 → sources-down", () => {
    const f = describeYoutubeFailure(
      [
        { tag: "piped:a", ok: false, status: 403, reason: "HTTP 403" },
        { tag: "piped:b", ok: false, status: 0, reason: "fetch failed" },
      ],
      { ok: true, title: "某视频" }
    );
    expect(f.type).toBe("sources-down");
    expect(f.msg).toContain("稍后重试");
  });

  it("oEmbed 404 → not-found", () => {
    const f = describeYoutubeFailure(
      [{ tag: "piped:a", ok: false, status: 403, reason: "HTTP 403" }],
      { ok: false, status: 404 }
    );
    expect(f.type).toBe("not-found");
    expect(f.msg).toContain("不存在");
  });

  it("无任何尝试 → no-sources", () => {
    const f = describeYoutubeFailure([], null);
    expect(f.type).toBe("no-sources");
  });
});

describe("official YouTube Data API v3（可选元数据源）", () => {
  it("officialVideosUrl / officialChannelsUrl 组装查询参数", () => {
    const vu = officialVideosUrl("dQw4w9WgXcQ", "AIzaKey");
    expect(vu).toContain("part=snippet,contentDetails,statistics");
    expect(vu).toContain("id=dQw4w9WgXcQ");
    expect(vu).toContain("key=AIzaKey");

    const cu = officialChannelsUrl("UCAbC123xYz", "AIzaKey");
    expect(cu).toContain("part=snippet,statistics");
    expect(cu).toContain("id=UCAbC123xYz");
    expect(cu).toContain("key=AIzaKey");
  });

  it("parseV3IsoDuration：ISO-8601 时长 → 毫秒", () => {
    expect(parseV3IsoDuration("PT4M13S")).toBe(253000);
    expect(parseV3IsoDuration("PT1H2M3S")).toBe(3723000);
    expect(parseV3IsoDuration("PT15S")).toBe(15000);
    expect(parseV3IsoDuration("P1DT2H")).toBe(93600000);
    expect(parseV3IsoDuration("")).toBe(0);
    expect(parseV3IsoDuration("not-a-duration")).toBe(0);
  });

  it("normalizeV3Video：videos.list 响应 → 统一元数据", () => {
    const meta = normalizeV3Video({
      items: [
        {
          snippet: {
            title: "官方标题",
            channelId: "UCAbC123xYz",
            channelTitle: "官方频道",
            publishedAt: "2024-05-01T10:00:00Z",
            description: "官方简介\n第二行",
            thumbnails: {
              default: { url: "https://i.ytimg.com/vi/x/default.jpg" },
              maxres: { url: "https://i.ytimg.com/vi/x/maxresdefault.jpg" },
            },
          },
          contentDetails: { duration: "PT4M13S" },
          statistics: { viewCount: "12345", likeCount: "678" },
        },
      ],
    });
    expect(meta.ok).toBe(true);
    expect(meta.official).toBe(true);
    expect(meta.title).toBe("官方标题");
    expect(meta.author).toBe("官方频道");
    expect(meta.authorUrl).toBe("https://www.youtube.com/channel/UCAbC123xYz");
    // 封面取最高清缩略图；简介 / 时长 / 时间戳 / 统计统一归一
    expect(meta.cover).toBe("https://i.ytimg.com/vi/x/maxresdefault.jpg");
    expect(meta.desc).toBe("官方简介\n第二行");
    expect(meta.durationMs).toBe(253000);
    expect(meta.published).toBe(1714557600);
    expect(meta.viewCount).toBe(12345);
    expect(meta.likeCount).toBe(678);
  });

  it("normalizeV3Video：空 items（不存在/私密）→ null；缺统计不虚报", () => {
    expect(normalizeV3Video({ items: [] })).toBeNull();
    expect(normalizeV3Video(null)).toBeNull();
    const meta = normalizeV3Video({
      items: [{ snippet: { title: "t", publishedAt: "bad" }, contentDetails: {}, statistics: {} }],
    });
    expect(meta.published).toBeUndefined();
    expect(meta.viewCount).toBeUndefined();
    expect(meta.durationMs).toBe(0);
  });

  it("normalizeV3Channel：补头像/订阅/@频道号/简介/投稿数/累计播放；隐藏订阅不覆盖", () => {
    const base = {
      ok: true,
      official: true,
      title: "t",
      channelId: "UCAbC123xYz",
      authorUrl: "https://www.youtube.com/channel/UCAbC123xYz",
      avatar: "",
    };
    const full = normalizeV3Channel(
      {
        items: [
          {
            snippet: {
              thumbnails: { default: { url: "https://av-s" }, medium: { url: "https://av-m" } },
              customUrl: "@MrBeast",
              description: "频道简介\n第二行",
            },
            statistics: {
              subscriberCount: "88400",
              videoCount: "1234",
              viewCount: "99887766",
            },
          },
        ],
      },
      base
    );
    expect(full.avatar).toBe("https://av-m");
    expect(full.subscriberCount).toBe(88400);
    // 频道号 customUrl 去 @ 存 authorId；主页链接升级为 handle 形式
    expect(full.authorId).toBe("MrBeast");
    expect(full.authorUrl).toBe("https://www.youtube.com/@MrBeast");
    expect(full.sign).toBe("频道简介\n第二行");
    expect(full.videoCount).toBe(1234);
    expect(full.channelViews).toBe(99887766);

    const hidden = normalizeV3Channel(
      {
        items: [
          { snippet: { thumbnails: {} }, statistics: { hiddenSubscriberCount: true, subscriberCount: "123" } },
        ],
      },
      base
    );
    expect(hidden.avatar).toBe("");
    expect(hidden.subscriberCount).toBeUndefined();
    // 无 customUrl / 简介 / 统计时不新增虚报字段，保留原频道主页链接
    expect(hidden.authorId).toBeUndefined();
    expect(hidden.sign).toBeUndefined();
    expect(hidden.videoCount).toBeUndefined();
    expect(hidden.channelViews).toBeUndefined();
    expect(hidden.authorUrl).toBe("https://www.youtube.com/channel/UCAbC123xYz");
  });
});

describe("buildSuccess 元数据合并（官方 v3 优先于实例/oEmbed）", () => {
  // 模拟一次竞速成功的直链源结果（富字段齐全）
  const makeRace = (parsedOverrides = {}) => ({
    kind: "piped",
    base: "piped.example.com",
    parsed: {
      formats: [
        {
          format_id: "f0",
          ext: "mp4",
          vcodec: "avc1",
          acodec: "mp4a",
          height: 720,
          url: "https://dl.example.com/v.mp4",
        },
      ],
      title: "实例标题",
      author: "实例作者",
      cover: "https://inst-cover",
      durationMs: 90000,
      avatar: "https://inst-avatar",
      authorUrl: "https://www.youtube.com/channel/UCinst",
      desc: "实例简介",
      published: "2024-01-01T00:00:00.000Z",
      viewCount: 999,
      likeCount: 88,
      subscriberCount: 100,
      ...parsedOverrides,
    },
  });

  it("official meta 存在时以官方字段优先，直链仍来自竞速源", () => {
    const r = buildSuccess(
      makeRace(),
      {
        ok: true,
        official: true,
        title: "官方标题",
        author: "官方频道",
        cover: "https://maxres",
        avatar: "https://yt-avatar",
        authorUrl: "https://www.youtube.com/channel/UCAbC123xYz",
        desc: "官方简介",
        durationMs: 253000,
        published: 1714557600,
        viewCount: 12345,
        likeCount: 678,
        subscriberCount: 88400,
        // 频道级信息（官方 v3 channels.list 补全）
        authorId: "MrBeast",
        sign: "频道官方简介",
        videoCount: 4321,
        channelViews: 87654321,
      },
      "dQw4w9WgXcQ"
    );
    expect(r.data.title).toBe("官方标题");
    expect(r.data.author).toBe("官方频道");
    expect(r.data.cover).toBe("https://maxres");
    expect(r.data.avatar).toBe("https://yt-avatar");
    expect(r.data.desc).toBe("官方简介");
    expect(r.data.time).toBe(1714557600);
    expect(r.data.views).toBe(12345);
    expect(r.data.like).toBe(678);
    expect(r.data.subscriberCount).toBe(88400);
    expect(r.data.duration).toBe(253000);
    // 频道级信息随官方源透传（authorId 为去 @ 的 handle，前端展示时补 @）
    expect(r.data.authorId).toBe("MrBeast");
    expect(r.data.sign).toBe("频道官方简介");
    expect(r.data.videoCount).toBe(4321);
    expect(r.data.channelViews).toBe(87654321);
    // 直链 / 清晰度不能被官方元数据覆盖
    expect(r.data.url).toBe("https://dl.example.com/v.mp4");
    expect(r.data.qualityLabel).toBe("720p");
    expect(r.data.videoId).toBe("dQw4w9WgXcQ");
  });

  it("无 official（oEmbed 兜底）时实例字段优先、oEmbed 只补缺失项", () => {
    const r = buildSuccess(
      makeRace(),
      {
        ok: true,
        title: "oEmbed标题",
        author: "oEmbed作者",
        cover: "https://oembed-cover",
        authorUrl: "https://www.youtube.com/@x",
      },
      "dQw4w9WgXcQ"
    );
    expect(r.data.title).toBe("实例标题");
    expect(r.data.author).toBe("实例作者");
    expect(r.data.cover).toBe("https://inst-cover");
    expect(r.data.avatar).toBe("https://inst-avatar");
    expect(r.data.desc).toBe("实例简介");
    expect(r.data.views).toBe(999);
    // 无官方 v3 时频道级字段不虚报为空
    expect(r.data.authorId).toBeUndefined();
    expect(r.data.sign).toBeUndefined();
    expect(r.data.videoCount).toBeUndefined();
    expect(r.data.channelViews).toBeUndefined();

    // 实例缺失时才轮到 oEmbed 兜底
    const fallback = buildSuccess(
      makeRace({ title: "", author: "", cover: "" }),
      {
        ok: true,
        title: "oEmbed标题",
        author: "oEmbed作者",
        cover: "https://oembed-cover",
      },
      "x12345"
    );
    expect(fallback.data.title).toBe("oEmbed标题");
    expect(fallback.data.author).toBe("oEmbed作者");
    expect(fallback.data.cover).toBe("https://oembed-cover");
  });
});

describe("buildEmbedOnlyResult 官方 v3 富元数据降级", () => {
  it("oEmbed 确认存在仍不虚报富字段（与旧行为一致）", () => {
    const r = buildEmbedOnlyResult("dQw4w9WgXcQ", {
      ok: true,
      title: "oEmbed标题",
      author: "作者",
      authorUrl: "https://www.youtube.com/@作者频道",
    });
    expect(r.data.source).toBe("oembed");
    expect(r.data.desc).toBeUndefined();
    expect(r.data.avatar).toBeUndefined();
    expect(r.data.subscriberCount).toBeUndefined();
    expect(r.data.time).toBeUndefined();
  });

  it("官方 v3 确认存在（embedOnly）→ 富信息一并下发", () => {
    const r = buildEmbedOnlyResult("dQw4w9WgXcQ", {
      ok: true,
      official: true,
      title: "官方标题",
      author: "官方频道",
      cover: "https://maxres",
      avatar: "https://yt-avatar",
      authorUrl: "https://www.youtube.com/channel/UCAbC123xYz",
      desc: "官方简介",
      durationMs: 253000,
      published: 1714557600,
      viewCount: "12345",
      likeCount: "678",
      subscriberCount: 88400,
      authorId: "MrBeast",
      sign: "频道官方简介",
      videoCount: 4321,
      channelViews: 87654321,
    });
    expect(r.data.embedOnly).toBe(true);
    expect(r.data.source).toBe("youtube-v3");
    expect(r.data.title).toBe("官方标题");
    expect(r.data.avatar).toBe("https://yt-avatar");
    expect(r.data.desc).toBe("官方简介");
    expect(r.data.duration).toBe(253000);
    expect(r.data.time).toBe(1714557600);
    expect(r.data.views).toBe(12345);
    expect(r.data.like).toBe(678);
    expect(r.data.subscriberCount).toBe(88400);
    // 频道级信息一并下发（embedOnly 富信息卡也能展示）
    expect(r.data.authorId).toBe("MrBeast");
    expect(r.data.sign).toBe("频道官方简介");
    expect(r.data.videoCount).toBe(4321);
    expect(r.data.channelViews).toBe(87654321);
    // 降级态仍无下载直链
    expect(r.data.url).toBeUndefined();
    expect(r.data.audioUrl).toBeUndefined();
  });
});

describe("buildSuccess 清晰度档位下发（B站同款 qualities）", () => {
  const fmt = (id: string, height: number, ext = "mp4") => ({
    format_id: id,
    ext,
    vcodec: "avc1",
    acodec: "mp4a",
    height,
    url: `https://dl.example.com/${id}.${ext}`,
  });
  const race = (formats: unknown[]) => ({
    kind: "piped",
    base: "piped.example.com",
    parsed: {
      formats,
      title: "实例标题",
      author: "实例作者",
      cover: "https://inst-cover",
      durationMs: 90000,
      avatar: "https://inst-avatar",
      authorUrl: "https://www.youtube.com/channel/UCinst",
      desc: "实例简介",
      published: "2024-01-01T00:00:00.000Z",
      viewCount: 999,
      likeCount: 88,
      subscriberCount: 100,
    },
  });

  it("多档合流按高度降序去重下发（同高优先 mp4），最高档即默认直链", () => {
    const r = buildSuccess(
      race([
        fmt("f18", 360),
        fmt("f22", 720),
        fmt("f43", 360, "webm"),
        fmt("f999", 720, "webm"),
      ]),
      { ok: false },
      "dQw4w9WgXcQ"
    );
    expect(r.data.qualities.map((q: { label: string }) => q.label)).toEqual([
      "720p",
      "360p",
    ]);
    // 去重后 720p 保留 mp4 直链，且 best（默认档）居首
    expect(r.data.qualities[0].url).toBe("https://dl.example.com/f22.mp4");
    expect(r.data.url).toBe("https://dl.example.com/f22.mp4");
    expect(r.data.qualityLabel).toBe("720p");
  });

  it("仅单档合流时不下发 qualities（前端走 qualityLabel 徽标，不渲染下拉）", () => {
    const r = buildSuccess(race([fmt("f18", 360)]), { ok: false }, "dQw4w9WgXcQ");
    expect(r.data.qualities).toBeUndefined();
    expect(r.data.qualityLabel).toBe("360p");
  });

  it("全部为分离流（无声视频）时不下发 qualities，best 回退第一分离流", () => {
    const videoOnly = {
      format_id: "ad0",
      ext: "mp4",
      vcodec: "avc1",
      acodec: "none",
      height: 1080,
      url: "https://dl.example.com/ad0.mp4",
    };
    const r = buildSuccess(race([videoOnly]), { ok: false }, "dQw4w9WgXcQ");
    expect(r.data.qualities).toBeUndefined();
    expect(r.data.url).toBe(videoOnly.url);
  });
});
