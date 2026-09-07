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
      "https://a.yt/api/v1/videos/dQw4w9WgXcQ?fields=videoId%2Ctitle%2Cauthor%2ClengthSeconds%2CthumbnailUrl%2CformatStreams%2CadaptiveFormats"
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
