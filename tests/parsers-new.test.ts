// @ts-nocheck
import { describe, it, expect } from "vitest";
import { extractVideoId, pickYoutubeFormat } from "@/lib/youtube";
import {
  extractShortcode,
  extractJsonObject,
  extractPostMedia,
  normalizeInstagramMedia,
  looksLikeLoginWall,
} from "@/lib/instagram";

describe("youtube helpers", () => {
  it("extractVideoId 支持各类链接", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractVideoId("https://youtu.be/dQw4w9WgXcQ?si=abc")).toBe("dQw4w9WgXcQ");
    expect(extractVideoId("https://www.youtube.com/shorts/AbC123xYz")).toBe("AbC123xYz");
    expect(extractVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractVideoId("https://www.youtube.com/live/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractVideoId("https://www.youtube.com/playlist?list=abc")).toBeNull();
    expect(extractVideoId("https://example.com/video/dQw4w9WgXcQ")).toBeNull();
  });

  it("pickYoutubeFormat 优先渐进式 mp4，其次音视频分离流", () => {
    const info = {
      formats: [
        { format_id: "137", ext: "mp4", vcodec: "avc1", acodec: "none", height: 1080, url: "https://v1" },
        { format_id: "140", ext: "m4a", vcodec: "none", acodec: "mp4a", abr: 128, url: "https://a1" },
        { format_id: "18", ext: "mp4", vcodec: "avc1", acodec: "mp4a", height: 360, url: "https://mux360" },
        { format_id: "22", ext: "mp4", vcodec: "avc1", acodec: "mp4a", height: 720, url: "https://mux720" },
        { format_id: "storyboard", ext: "mhtml", vcodec: "none", acodec: "none", url: "https://sb" },
      ],
    };
    const picked = pickYoutubeFormat(info);
    expect(picked.best.format_id).toBe("22");

    const onlySeparate = pickYoutubeFormat({
      formats: [
        { format_id: "137", ext: "mp4", vcodec: "avc1", acodec: "none", height: 1080, url: "https://v1" },
        { format_id: "140", ext: "m4a", vcodec: "none", acodec: "mp4a", abr: 128, url: "https://a1" },
      ],
    });
    expect(onlySeparate.best.format_id).toBe("137");
    expect(onlySeparate.audio.url).toBe("https://a1");
  });
});

describe("instagram helpers", () => {
  it("extractShortcode 识别 p/reel/reels/tv/instagr.am", () => {
    expect(extractShortcode("https://www.instagram.com/p/Cm7uZQNLJH0/")).toBe("Cm7uZQNLJH0");
    expect(extractShortcode("https://www.instagram.com/reel/Cm7uZQNLJH0/?igsh=abc")).toBe("Cm7uZQNLJH0");
    expect(extractShortcode("https://instagr.am/p/AbC12345/")).toBe("AbC12345");
    expect(extractShortcode("https://www.youtube.com/watch?v=x")).toBeNull();
  });

  it("extractJsonObject 正确处理转义/嵌套", () => {
    const html = `<script>window._sharedData = {"a":{"b":"}"},"c":1};</script>`;
    expect(extractJsonObject(html, "window._sharedData = ")).toBe('{"a":{"b":"}"},"c":1}');
    expect(extractJsonObject("<div>nothing here</div>", "window._sharedData = ")).toBeNull();
  });

  it("extractPostMedia 从 _sharedData 提取 shortcode_media", () => {
    const media = { __typename: "GraphVideo", shortcode: "x", is_video: true, video_url: "https://v" };
    const html = `<script>window._sharedData = ${JSON.stringify({
      entry_data: { PostPage: [{ graphql: { shortcode_media: media } }] },
    })};</script>`;
    expect(extractPostMedia(html)).toEqual(media);
  });

  it("normalizeInstagramMedia 处理视频与纯图片图集", () => {
    const video = normalizeInstagramMedia({
      __typename: "GraphVideo",
      is_video: true,
      video_url: "https://v.mp4",
      display_url: "https://cover.jpg",
      video_duration: 12,
      edge_media_to_caption: { edges: [{ node: { text: "你好 IG" } }] },
      owner: { username: "someone", profile_pic_url: "https://avatar" },
    });
    expect(video.type).toBe("video");
    expect(video.url).toBe("https://v.mp4");
    expect(video.duration).toBe(12000);

    const album = normalizeInstagramMedia({
      __typename: "GraphSidecar",
      is_video: false,
      display_url: "https://cover.jpg",
      edge_sidecar_to_children: {
        edges: [
          { node: { __typename: "GraphImage", display_url: "https://a.jpg" } },
          { node: { __typename: "GraphImage", display_url: "https://b.jpg" } },
        ],
      },
      owner: { username: "someone" },
    });
    expect(album.type).toBe("image");
    expect(album.images).toEqual(["https://a.jpg", "https://b.jpg"]);
  });

  it("looksLikeLoginWall 识别匿名登录墙", () => {
    expect(looksLikeLoginWall('<title>Login • Instagram</title>')).toBe(true);
    expect(looksLikeLoginWall("normal page without markers")).toBe(false);
  });
});
