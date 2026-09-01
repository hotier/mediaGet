// Twitter 第三方 fixer 适配器单元测试：
// 用真实抓取的 fxTwitter（孙宇晨推文，浏览器实测返回）与 vxtwitter（本机 curl 实测返回）
// 数据验证字段映射，覆盖纯文本 / 视频 / 图集 / 混合媒体等分支。
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  buildFxResult,
  buildVxtwitterResult,
  buildVideoFixTable,
  cleanTweetText,
  fetchAuthorProfile,
  firstNonNull,
  fixTwimgVideoUrl,
  isSyndicationTombstone,
  parseViaFixer,
  parseVideoId,
  pickBestMp4,
  pickFxTweet,
  pickVxtweet,
  raceFixerResults,
} from "@/app/api/twitter/route";

// 真实 fxTwitter 响应（2026-08-31 浏览器实测，纯文本推文，含引用）
const realFxTwitterJson = {
  code: 200,
  message: "OK",
  tweet: {
    url: "https://x.com/sunyuchentron/status/2094368106751951154",
    id: "2094368106751951154",
    text: "Don't miss Bitcoin",
    author: {
      screen_name: "sunyuchentron",
      url: "https://x.com/sunyuchentron",
      id: "1222182756400037889",
      followers: 610867,
      following: 284,
      likes: 83,
      media_count: 3035,
      name: "孙宇晨（去过太空版）🧑‍🚀",
      description:
        "👨‍💻 企业家 | 🤵‍♂️ 外交官 | 👨‍🚀 宇航员 #712 | 🍌 艺术收藏家",
      avatar_url:
        "https://pbs.twimg.com/profile_images/1955272811448340480/M9982AS6_200x200.jpg",
    },
    replies: 22,
    retweets: 5,
    likes: 125,
    bookmarks: 11,
    quotes: 5,
    created_at: "Mon Aug 31 10:14:02 +0000 2026",
    created_timestamp: 1788171242,
    views: 207718,
    media: { all: [], photos: [], videos: [] },
  },
};

// 真实 vxtwitter 响应（2026-09-01 curl 实测，纯文本推文，含 qrt 引用）
const realVxtwitterJson = {
  allSameType: true,
  conversationID: "2094368106751951154",
  date: "Mon Aug 31 10:14:02 +0000 2026",
  date_epoch: 1788171242,
  hasMedia: false,
  likes: 125,
  mediaURLs: [],
  media_extended: [],
  qrt: null,
  qrtURL: "https://twitter.com/i/status/2094357029901226231",
  replies: 22,
  retweets: 5,
  text: "Don't miss Bitcoin",
  tweetID: "2094368106751951154",
  tweetURL:
    "https://twitter.com/sunyuchentron/status/2094368106751951154",
  user_name: "孙宇晨（去过太空版）🧑‍🚀",
  user_profile_image_url:
    "https://pbs.twimg.com/profile_images/1955272811448340480/M9982AS6_normal.jpg",
  user_screen_name: "sunyuchentron",
};

// 构造的带媒体 fxTwitter 样例：多视频 + 图集 + 混合（media.all 兼容分支）
const fxWithMedia = {
  tweet: {
    text: "带视频和图集",
    created_at: "Mon Aug 31 10:14:02 +0000 2026",
    author: {
      name: "博主",
      screen_name: "author",
      id: "123",
      description: "简介",
      followers: 100,
      following: 10,
      avatar_url: "https://example.com/avatar.jpg",
    },
    likes: 9,
    retweets: 8,
    replies: 7,
    views: 6,
    media: {
      photos: [
        { url: "https://example.com/photo1.jpg" },
        { url: "https://example.com/photo2.jpg" },
      ],
      videos: [
        {
          url: "https://example.com/video1.mp4",
          thumbnail_url: "https://example.com/thumb1.jpg",
          duration: 65,
        },
        {
          url: "https://example.com/video2.mp4",
          thumbnail_url: "https://example.com/thumb2.jpg",
          duration: 10,
        },
      ],
      all: [],
    },
  },
};

// 构造的 vxtwitter 带媒体样例：media_extended 视频 + 图片，及 mediaURLs 兜底
const vxWithMedia = {
  date_epoch: 1788171242,
  likes: 9,
  retweets: 8,
  replies: 7,
  text: "带媒体",
  tweetID: "100",
  user_name: "博主",
  user_screen_name: "author",
  user_profile_image_url: "https://example.com/avatar.jpg",
  media_extended: [
    {
      type: "video",
      url: "https://example.com/video.mp4",
      thumbnail_url: "https://example.com/thumb.jpg",
      duration_millis: 65000,
    },
    {
      type: "video",
      url: "https://example.com/video2.mp4",
      thumbnail_url: "https://example.com/thumb2.jpg",
      duration_millis: 20000,
    },
    {
      type: "image",
      url: "https://example.com/photo.jpg",
    },
  ],
};

const vxMediaUrlsOnly = {
  date_epoch: 1788171242,
  likes: 1,
  retweets: 2,
  replies: 3,
  text: "mediaURLs 兜底",
  tweetID: "101",
  user_name: "博主",
  user_screen_name: "author",
  media_extended: [],
  mediaURLs: [
    "https://video.twimg.com/tweet_video/xx.mp4",
    "https://video.twimg.com/tweet_video/zz.mp4",
    "https://pbs.twimg.com/media/yy.jpg",
  ],
};

describe("fxTwitter 适配器 (buildFxResult)", () => {
  it("解析真实纯文本推文：作者信息 + 互动统计 + type=text", () => {
    const r = buildFxResult(realFxTwitterJson.tweet);
    expect(r?.code).toBe(200);
    const d = r!.data;
    expect(d.title).toBe("Don't miss Bitcoin");
    expect(d.author).toBe("孙宇晨（去过太空版）🧑‍🚀");
    expect(d.uid).toBe("@sunyuchentron");
    expect(d.authorUrl).toBe("https://x.com/sunyuchentron");
    expect(d.sign).toBe("👨‍💻 企业家 | 🤵‍♂️ 外交官 | 👨‍🚀 宇航员 #712 | 🍌 艺术收藏家");
    expect(d.followerCount).toBe(610867);
    expect(d.followingCount).toBe(284);
    expect(d.like).toBe(125);
    expect(d.retweets).toBe(5);
    expect(d.replies).toBe(22);
    expect(d.views).toBe(207718);
    expect(d.type).toBe("text");
    expect(d.url).toBe("");
    expect(d.time).toBe(Date.parse("Mon Aug 31 10:14:02 +0000 2026"));
  });

  it("多视频 + 图集：videos/images 全量收集，type=video", () => {
    const r = buildFxResult(fxWithMedia.tweet);
    const d = r!.data;
    expect(d.type).toBe("video");
    expect(d.url).toBe("https://example.com/video1.mp4");
    expect(d.videos).toEqual([
      expect.objectContaining({
        url: "https://example.com/video1.mp4",
        duration: 65,
        durationFormat: "1:05",
        cover: "https://example.com/thumb1.jpg",
      }),
      expect.objectContaining({
        url: "https://example.com/video2.mp4",
        duration: 10,
        durationFormat: "0:10",
        cover: "https://example.com/thumb2.jpg",
      }),
    ]);
    expect(d.images).toEqual([
      "https://example.com/photo1.jpg",
      "https://example.com/photo2.jpg",
    ]);
    expect(d.cover).toBe("https://example.com/thumb1.jpg");
  });

  it("media.all 混合媒体兼容分支", () => {
    const r = buildFxResult({
      text: "混合",
      created_at: "Mon Aug 31 10:14:02 +0000 2026",
      author: {},
      likes: 0,
      media: {
        photos: [],
        videos: [],
        all: [
          {
            type: "video",
            url: "https://example.com/mix.mp4",
            thumbnail_url: "https://example.com/mix.jpg",
            duration: 10,
          },
          {
            type: "video",
            url: "https://example.com/mix2.mp4",
            thumbnail_url: "https://example.com/mix2.jpg",
            duration: 20,
          },
          { type: "photo", url: "https://example.com/mix1.jpg" },
        ],
      },
    });
    const d = r!.data;
    expect(d.type).toBe("video");
    expect(d.videos![0].url).toBe("https://example.com/mix.mp4");
    expect(d.images).toEqual(["https://example.com/mix1.jpg"]);
  });

  it("media.all 无条件补充：分类子集不全时混合媒体不漏图/不漏视频、不重复", () => {
    const r = buildFxResult({
      text: "混合",
      created_at: "Mon Aug 31 10:14:02 +0000 2026",
      author: {},
      likes: 1,
      media: {
        photos: [],
        videos: [
          {
            url: "https://example.com/v1.mp4",
            thumbnail_url: "https://example.com/t1.jpg",
            duration: 10,
          },
        ],
        all: [
          {
            type: "video",
            url: "https://example.com/v1.mp4",
            thumbnail_url: "https://example.com/t1.jpg",
            duration: 10,
          },
          { type: "photo", url: "https://example.com/p1.jpg" },
          { type: "photo", url: "https://example.com/p2.jpg" },
        ],
      },
    });
    const d = r!.data;
    expect(d.type).toBe("video");
    // 单视频走 url 主媒体，videos 列表不输出（说明 all 中重复视频未重复收集）
    expect(d.url).toBe("https://example.com/v1.mp4");
    expect(d.videos).toBeUndefined();
    expect(d.images).toEqual([
      "https://example.com/p1.jpg",
      "https://example.com/p2.jpg",
    ]);
  });

  it("结构缺失返回 null", () => {
    expect(buildFxResult(null as never)).toBeNull();
    expect(buildFxResult(undefined as never)).toBeNull();
    expect(buildFxResult("str" as never)).toBeNull();
  });

  it("tombstone 结构（删除/不可见）返回 null，不产出空文本推文", () => {
    expect(buildFxResult({ type: "tombstone", text: "unavailable" } as never)).toBeNull();
  });
});

describe("fxTwitter v2 结构兼容 (pickFxTweet)", () => {
  // 依据 FxEmbed 官方文档（docs.fxembed.com/api/twitter/operations/2statusid/）：
  // v2 响应顶层为 { status, thread, author }，作者信息在顶层，转发字段名为 reposts
  it("v2 顶层 status + author 解析，reposts 映射为 retweets", () => {
    const v2Json = {
      status: {
        type: "status",
        id: "20",
        text: "Hello world",
        created_at: "2025-01-01T00:00:00.000Z",
        likes: 100,
        reposts: 20,
        replies: 10,
        views: 5000,
        media: { photos: [], videos: [], all: [] },
      },
      thread: null,
      author: {
        name: "User",
        screen_name: "username",
        avatar_url: "https://pbs.twimg.com/profile_images/avatar.jpg",
        description: "Example account",
        followers: 1000,
        following: 100,
      },
    };
    const r = buildFxResult(pickFxTweet(v2Json));
    const d = r!.data;
    expect(d.author).toBe("User");
    expect(d.uid).toBe("@username");
    expect(d.sign).toBe("Example account");
    expect(d.followerCount).toBe(1000);
    expect(d.followingCount).toBe(100);
    expect(d.retweets).toBe(20);
    expect(d.like).toBe(100);
    expect(d.replies).toBe(10);
    expect(d.views).toBe(5000);
    expect(d.type).toBe("text");
  });

  it("tombstone 视为不可用返回 null", () => {
    const tomb = {
      code: 404,
      status: { type: "tombstone", reason: "deleted", id: "20" },
    };
    expect(pickFxTweet(tomb)).toBeNull();
    expect(buildFxResult(pickFxTweet(tomb))).toBeNull();
  });

  it("新旧结构都能取到推文对象，非法输入返回 null", () => {
    expect(pickFxTweet(realFxTwitterJson)).toBe(realFxTwitterJson.tweet);
    expect(pickFxTweet(null as never)).toBeNull();
    expect(pickFxTweet(undefined as never)).toBeNull();
    expect(pickFxTweet({})).toBeNull();
  });

  it("旧结构 { tweet: { type: tombstone } } 同样视为不可用返回 null", () => {
    const tomb = {
      code: 200,
      tweet: { type: "tombstone", text: "This Post is unavailable." },
    };
    expect(pickFxTweet(tomb)).toBeNull();
  });
});

describe("isSyndicationTombstone：官方 syndication 的删除/受限推文识别", () => {
  // 真实抓取：cdn.syndication.twimg.com 对已删除/成人内容推文返回
  // HTTP 200 + {"__typename":"TweetTombstone","tombstone":{}}（无正文无媒体）
  it("识别真实 tombstone 响应（__typename + tombstone 字段）", () => {
    expect(
      isSyndicationTombstone({ __typename: "TweetTombstone", tombstone: {} })
    ).toBe(true);
    expect(isSyndicationTombstone({ tombstone: {} })).toBe(true);
  });

  it("正常推文 / 非法输入返回 false", () => {
    expect(
      isSyndicationTombstone({
        __typename: "Tweet",
        text: "hello",
        user: { name: "u" },
      })
    ).toBe(false);
    expect(isSyndicationTombstone(null as never)).toBe(false);
    expect(isSyndicationTombstone(undefined as never)).toBe(false);
    expect(isSyndicationTombstone("str" as never)).toBe(false);
  });
});

describe("vxtwitter 适配器 (buildVxtwitterResult + pickVxtweet)", () => {
  it("pickVxtweet 兼容数组与对象两种形态", () => {
    expect(pickVxtweet([realVxtwitterJson])).toBe(realVxtwitterJson);
    expect(pickVxtweet(realVxtwitterJson)).toBe(realVxtwitterJson);
    expect(pickVxtweet(null)).toBeNull();
    expect(pickVxtweet([])).toBeNull();
  });

  it("解析真实纯文本推文：无简介/粉丝/查看量，互动统计齐全", () => {
    const r = buildVxtwitterResult(pickVxtweet(realVxtwitterJson));
    expect(r?.code).toBe(200);
    const d = r!.data;
    expect(d.title).toBe("Don't miss Bitcoin");
    expect(d.author).toBe("孙宇晨（去过太空版）🧑‍🚀");
    expect(d.uid).toBe("@sunyuchentron");
    expect(d.like).toBe(125);
    expect(d.retweets).toBe(5);
    expect(d.replies).toBe(22);
    expect(d.sign).toBeUndefined();
    expect(d.followerCount).toBeUndefined();
    expect(d.views).toBeUndefined();
    expect(d.type).toBe("text");
    expect(d.time).toBe(1788171242 * 1000);
  });

  it("media_extended 视频+图片解析", () => {
    const r = buildVxtwitterResult(vxWithMedia);
    const d = r!.data;
    expect(d.type).toBe("video");
    expect(d.url).toBe("https://example.com/video.mp4");
    expect(d.videos).toEqual([
      expect.objectContaining({
        url: "https://example.com/video.mp4",
        duration: 65,
        durationFormat: "1:05",
      }),
      expect.objectContaining({
        url: "https://example.com/video2.mp4",
        duration: 20,
        durationFormat: "0:20",
      }),
    ]);
    expect(d.images).toEqual(["https://example.com/photo.jpg"]);
  });

  it("mediaURLs 按扩展名兜底拆分视频/图片", () => {
    const r = buildVxtwitterResult(vxMediaUrlsOnly);
    const d = r!.data;
    expect(d.type).toBe("video");
    expect(d.url).toBe("https://video.twimg.com/tweet_video/xx.mp4");
    expect(d.videos![0].url).toBe("https://video.twimg.com/tweet_video/xx.mp4");
    expect(d.images).toEqual(["https://pbs.twimg.com/media/yy.jpg"]);
  });

  it("结构缺失返回 null", () => {
    expect(buildVxtwitterResult(null as never)).toBeNull();
    expect(buildVxtwitterResult(undefined as never)).toBeNull();
  });
});

describe("firstNonNull 并发竞速", () => {
  it("返回首个非空结果，空列表返回 null", async () => {
    expect(await firstNonNull([])).toBeNull();
    expect(await firstNonNull([Promise.resolve(null), Promise.resolve(1)])).toBe(1);
    expect(
      await firstNonNull([Promise.resolve(null), Promise.resolve(null)])
    ).toBeNull();
    expect(await firstNonNull([Promise.resolve(null), Promise.resolve("x")])).toBe(
      "x"
    );
  });
});

describe("raceFixerResults：完整性校验竞速", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockFetch(map: Record<string, unknown | (() => unknown)>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const host = String(url).split("/")[2];
        const entry = map[host];
        if (entry === undefined) throw new Error(`no mock for ${host}`);
        const body = typeof entry === "function" ? entry() : entry;
        return { ok: body !== null, json: async () => body };
      })
    );
  }

  const fxHosts = ["api.fxtwitter.com", "api.fixupx.com", "api.twittpr.com"];

  it("缺 media 字段的 text 响应不短路，等完整媒体结果胜出", async () => {
    mockFetch({
      "api.fxtwitter.com": {
        code: 200,
        status: { type: "status", text: "疑似媒体推文", likes: 1 },
        author: { name: "A", screen_name: "a" },
      },
      "api.fixupx.com": {
        code: 200,
        tweet: {
          text: "带视频",
          media: {
            photos: [],
            videos: [
              {
                url: "https://example.com/v.mp4",
                thumbnail_url: "https://example.com/t.jpg",
                duration: 10,
              },
            ],
            all: [],
          },
          author: { name: "B", screen_name: "b" },
        },
      },
      "api.twittpr.com": null,
      "api.vxtwitter.com": null,
    });
    const r = await raceFixerResults(fxHosts, "2094749764659384710");
    expect(r?.code).toBe(200);
    expect(r!.data.type).toBe("video");
    expect(r!.data.url).toBe("https://example.com/v.mp4");
    expect(r!.data.author).toBe("B");
  });

  it("全部 text 且缺 media：返回兜底 text 结果，不解析失败", async () => {
    mockFetch({
      "api.fxtwitter.com": {
        code: 200,
        status: { type: "status", text: "纯文本无media字段" },
        author: { name: "A", screen_name: "a" },
      },
      "api.fixupx.com": { code: 200, tweet: { text: "纯文本2" } },
      "api.twittpr.com": null,
    });
    const r = await raceFixerResults(fxHosts, "2094749764659384710");
    expect(r?.code).toBe(200);
    expect(r!.data.type).toBe("text");
    expect(["纯文本无media字段", "纯文本2"]).toContain(r!.data.title);
  });

  it("纯文本带 media 空结构：视为完整结果直接返回", async () => {
    mockFetch({
      "api.fxtwitter.com": {
        code: 200,
        tweet: {
          text: "纯文本",
          media: { photos: [], videos: [], all: [] },
          author: { name: "A", screen_name: "a" },
        },
      },
      "api.fixupx.com": null,
      "api.twittpr.com": null,
    });
    const r = await raceFixerResults(fxHosts, "2094749764659384710");
    expect(r?.data.type).toBe("text");
    expect(r!.data.title).toBe("纯文本");
  });

  it("空 host 列表返回 null", async () => {
    expect(await raceFixerResults([], "1")).toBeNull();
  });
});

describe("fetchAuthorProfile / parseViaFixer 并发降级", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // 按 host mock fetch：null 表示请求失败（返回 null 交给 fetchFixerJson），
  // 函数值用于按调用动态返回
  function mockFetch(map: Record<string, unknown | (() => unknown)>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const host = String(url).split("/")[2];
        const entry = map[host];
        if (entry === undefined) throw new Error(`no mock for ${host}`);
        const body = typeof entry === "function" ? entry() : entry;
        return { ok: body !== null, json: async () => body };
      })
    );
  }

  const fxAuthor = {
    name: "王长富",
    screen_name: "wangchangfu88",
    description: "运营增长 | 投资理财",
    followers: 42403,
    following: 3038,
  };

  it("fxTwitter 主站成功：返回简介/粉丝/关注/互动统计", async () => {
    mockFetch({
      "api.fxtwitter.com": {
        code: 200,
        tweet: { text: "hi", author: fxAuthor, likes: 9, retweets: 8, replies: 7, views: 6 },
      },
      "api.fixupx.com": null,
      "api.twittpr.com": null,
      "api.vxtwitter.com": null,
    });
    const p = await fetchAuthorProfile("2094749764659384710");
    expect(p.sign).toBe("运营增长 | 投资理财");
    expect(p.followerCount).toBe(42403);
    expect(p.followingCount).toBe(3038);
    expect(p.like).toBe(9);
    expect(p.retweets).toBe(8);
    expect(p.replies).toBe(7);
    expect(p.views).toBe(6);
  });

  it("fxTwitter 主站失败、备选 fixupx 成功：仍返回完整作者信息", async () => {
    mockFetch({
      "api.fxtwitter.com": null,
      "api.fixupx.com": {
        code: 200,
        tweet: { text: "hi", author: fxAuthor, likes: 1, reposts: 2, replies: 3, views: 4 },
      },
      "api.twittpr.com": null,
      "api.vxtwitter.com": null,
    });
    const p = await fetchAuthorProfile("2094749764659384710");
    expect(p.sign).toBe("运营增长 | 投资理财");
    expect(p.followerCount).toBe(42403);
    expect(p.followingCount).toBe(3038);
    // v2 字段名 reposts 兼容
    expect(p.retweets).toBe(2);
  });

  it("fxTwitter 家族全失败：vxtwitter 兜底互动统计（views 有则补）", async () => {
    mockFetch({
      "api.fxtwitter.com": null,
      "api.fixupx.com": null,
      "api.twittpr.com": null,
      "api.vxtwitter.com": {
        likes: 5,
        retweets: 4,
        replies: 3,
        views: 666,
        text: "hi",
        user_name: "王长富",
        user_screen_name: "wangchangfu88",
      },
    });
    const p = await fetchAuthorProfile("2094749764659384710");
    expect(p.sign).toBeUndefined();
    expect(p.followerCount).toBeUndefined();
    expect(p.followingCount).toBeUndefined();
    expect(p.like).toBe(5);
    expect(p.retweets).toBe(4);
    expect(p.replies).toBe(3);
    expect(p.views).toBe(666);
  });

  it("全部 fixer 失败：返回空对象，不抛错", async () => {
    mockFetch({
      "api.fxtwitter.com": null,
      "api.fixupx.com": null,
      "api.twittpr.com": null,
      "api.vxtwitter.com": null,
    });
    expect(await fetchAuthorProfile("2094749764659384710")).toEqual({});
    expect(await parseViaFixer("2094749764659384710")).toBeNull();
  });

  it("parseViaFixer：fxTwitter 主站成功直接返回完整 result", async () => {
    mockFetch({
      "api.fxtwitter.com": {
        code: 200,
        tweet: { text: "hi", author: fxAuthor, media: { all: [], photos: [], videos: [] } },
      },
      "api.fixupx.com": null,
      "api.twittpr.com": null,
      "api.vxtwitter.com": null,
    });
    const r = await parseViaFixer("2094749764659384710");
    expect(r?.code).toBe(200);
    const d = r!.data;
    expect(d.author).toBe("王长富");
    expect(d.sign).toBe("运营增长 | 投资理财");
    expect(d.followerCount).toBe(42403);
    expect(d.followingCount).toBe(3038);
  });
});

describe("parseVideoId：fixer 优先，官方 syndication 兜底", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // 记录所有被请求的 host，用于断言解析优先级
  const requestedHosts: string[] = [];
  function mockFetch(map: Record<string, unknown | (() => unknown)>) {
    requestedHosts.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const host = String(url).split("/")[2];
        requestedHosts.push(host);
        const entry = map[host];
        if (entry === undefined) throw new Error(`no mock for ${host}`);
        const body = typeof entry === "function" ? entry() : entry;
        return { ok: body !== null, json: async () => body };
      })
    );
  }

  const allFixersDown: Record<string, null> = {
    "api.fxtwitter.com": null,
    "api.fixupx.com": null,
    "api.twittpr.com": null,
    "api.vxtwitter.com": null,
  };
  const fxOk = {
    code: 200,
    tweet: {
      text: "fixer 优先推文",
      created_at: "Mon Aug 31 10:14:02 +0000 2026",
      author: {
        name: "王长富",
        screen_name: "wangchangfu88",
        description: "运营增长 | 投资理财",
        followers: 42403,
        following: 3038,
      },
      likes: 9,
      retweets: 8,
      replies: 7,
      views: 6,
      media: { photos: [], videos: [], all: [] },
    },
  };
  const syndicationOk = {
    __typename: "Tweet",
    text: "官方兜底推文",
    created_at: "Mon Aug 31 10:14:02 +0000 2026",
    user: {
      id_str: "999",
      name: "官方用户",
      screen_name: "official",
      profile_image_url_https: "https://example.com/avatar.jpg",
    },
    mediaDetails: [],
  };

  it("fixer 成功时优先返回 fixer 结果，官方 syndication 不被请求", async () => {
    mockFetch({
      ...allFixersDown,
      "api.fxtwitter.com": fxOk,
      "cdn.syndication.twimg.com": syndicationOk,
    });
    const r = await parseVideoId("2094749764659384710");
    expect(r?.code).toBe(200);
    expect(r!.data.title).toBe("fixer 优先推文");
    expect(r!.data.author).toBe("王长富");
    expect(r!.data.sign).toBe("运营增长 | 投资理财");
    expect(r!.data.followerCount).toBe(42403);
    expect(requestedHosts).not.toContain("cdn.syndication.twimg.com");
  });

  it("fixer 全部失败 → 官方 syndication 兜底成功", async () => {
    mockFetch({
      ...allFixersDown,
      "cdn.syndication.twimg.com": syndicationOk,
    });
    const r = await parseVideoId("2094749764659384710");
    expect(r?.code).toBe(200);
    expect(r!.data.title).toBe("官方兜底推文");
    expect(r!.data.author).toBe("官方用户");
    expect(r!.data.type).toBe("text");
    expect(requestedHosts).toContain("cdn.syndication.twimg.com");
  });

  it("fixer 全部失败 + 官方 tombstone → 明确报错，不产出空文本推文", async () => {
    mockFetch({
      ...allFixersDown,
      "cdn.syndication.twimg.com": {
        __typename: "TweetTombstone",
        tombstone: {},
      },
    });
    const r = await parseVideoId("2094749764659384710");
    expect(r?.code).toBe(404);
    expect(r?.msg).toContain("不可见");
  });
});

describe("cleanTweetText：解码 HTML 实体并剔除媒体短链占位", () => {
  it("解码 &gt; &lt; &amp; 等常见实体", () => {
    expect(cleanTweetText("逻辑不复杂：&gt; 专注短线&nbsp;涨/跌")).toBe(
      "逻辑不复杂：> 专注短线 涨/跌"
    );
  });

  it("剔除 entities.media 中的 t.co 短链并保留换行结构", () => {
    const text =
      "上海交大大二学生，用Claude搭了一个高频交易机器人。\n&gt; 算法不一次性押满\n&gt; https://t.co/7eTbz0kObp";
    const entities = {
      media: [
        {
          url: "https://t.co/7eTbz0kObp",
          expanded_url: "https://x.com/0xPINK3/status/2094654361331012092/video/1",
          indices: [161, 184],
        },
      ],
    };
    expect(cleanTweetText(text, entities)).toBe(
      "上海交大大二学生，用Claude搭了一个高频交易机器人。\n> 算法不一次性押满"
    );
  });

  it("剔除 entities.urls 中的短链", () => {
    const entities = { urls: [{ url: "https://t.co/abc123" }] };
    expect(cleanTweetText("看这里 https://t.co/abc123 很好", entities)).toBe(
      "看这里 很好"
    );
  });

  it("无 entities 时解码实体并保留分段空行", () => {
    expect(cleanTweetText("a\n\n  b &amp; c  ")).toBe("a\n\nb & c");
  });

  it("连续空行压缩为单个、首尾空行剔除", () => {
    expect(cleanTweetText("\n\na\n\n\nb\n\n")).toBe("a\n\nb");
  });
});

describe("pickBestMp4：兼容两套字段命名", () => {
  it("标准 syndication 结构 content_type/url 挑最高码率", () => {
    const variants = [
      { content_type: "application/x-mpegURL", url: "x.m3u8" },
      { content_type: "video/mp4", bitrate: 632000, url: "low.mp4" },
      { content_type: "video/mp4", bitrate: 2176000, url: "high.mp4" },
    ];
    expect(pickBestMp4(variants)).toBe("high.mp4");
  });

  it("顶层 video.variants 的 type/src 结构也能匹配", () => {
    const variants = [
      { type: "application/x-mpegURL", src: "x.m3u8" },
      { type: "video/mp4", bitrate: 950000, src: "mid.mp4" },
      { type: "video/mp4", bitrate: 2176000, src: "best.mp4" },
    ];
    expect(pickBestMp4(variants)).toBe("best.mp4");
  });

  it("无 mp4 时返回空串", () => {
    expect(pickBestMp4([{ type: "application/x-mpegURL", src: "x.m3u8" }])).toBe("");
  });
});

describe("buildVideoFixTable / fixTwimgVideoUrl：twimg 直链补 tag 签名", () => {
  // 真实 fxTwitter 结构：media.videos[].formats 各档位带 ?tag=，路径与 syndication variants 一致
  const realFxMedia = {
    videos: [
      {
        id: "2094654000729849856",
        url: "https://video.twimg.com/amplify_video/2094654000729849856/vid/avc1/2160x2676/gytaut_zsJVA3M31.mp4?tag=29",
        thumbnail_url:
          "https://pbs.twimg.com/amplify_video_thumb/2094654000729849856/img/CyyIkhTdg-9Qb3bm.jpg",
        duration: 25.054,
        formats: [
          {
            url: "https://video.twimg.com/amplify_video/2094654000729849856/vid/avc1/720x892/Dz5OZlblIIbxdj3c.mp4?tag=29",
            bitrate: 2176000,
            container: "mp4",
          },
        ],
      },
    ],
  };

  it("buildVideoFixTable 收集 videos 与 formats 的路径→带tag URL", () => {
    const table = buildVideoFixTable({ media: realFxMedia });
    expect(table.size).toBe(2);
    expect(
      table.get("/amplify_video/2094654000729849856/vid/avc1/2160x2676/gytaut_zsJVA3M31.mp4")
    ).toBe(
      "https://video.twimg.com/amplify_video/2094654000729849856/vid/avc1/2160x2676/gytaut_zsJVA3M31.mp4?tag=29"
    );
    expect(
      table.get("/amplify_video/2094654000729849856/vid/avc1/720x892/Dz5OZlblIIbxdj3c.mp4")
    ).toBe(
      "https://video.twimg.com/amplify_video/2094654000729849856/vid/avc1/720x892/Dz5OZlblIIbxdj3c.mp4?tag=29"
    );
  });

  it("syndication 无 tag 直链按路径替换为带 tag 版本", () => {
    const table = buildVideoFixTable({ media: realFxMedia });
    const fixed = fixTwimgVideoUrl(
      "https://video.twimg.com/amplify_video/2094654000729849856/vid/avc1/2160x2676/gytaut_zsJVA3M31.mp4",
      table
    );
    expect(fixed).toBe(
      "https://video.twimg.com/amplify_video/2094654000729849856/vid/avc1/2160x2676/gytaut_zsJVA3M31.mp4?tag=29"
    );
  });

  it("已带 tag / 非 twimg 域 / 表内无匹配均原样返回", () => {
    const table = buildVideoFixTable({ media: realFxMedia });
    const tagged =
      "https://video.twimg.com/amplify_video/2094654000729849856/vid/avc1/2160x2676/gytaut_zsJVA3M31.mp4?tag=29";
    expect(fixTwimgVideoUrl(tagged, table)).toBe(tagged);
    expect(
      fixTwimgVideoUrl("https://pbs.twimg.com/amplify_video_thumb/x.jpg", table)
    ).toBe("https://pbs.twimg.com/amplify_video_thumb/x.jpg");
    expect(
      fixTwimgVideoUrl(
        "https://video.twimg.com/amplify_video/xxx/vid/avc1/no-match.mp4",
        table
      )
    ).toBe("https://video.twimg.com/amplify_video/xxx/vid/avc1/no-match.mp4");
  });

  it("空表 / 空输入直接原样返回", () => {
    expect(fixTwimgVideoUrl("https://video.twimg.com/a/b.mp4", new Map())).toBe(
      "https://video.twimg.com/a/b.mp4"
    );
    expect(fixTwimgVideoUrl("", buildVideoFixTable({ media: realFxMedia }))).toBe("");
  });
});
