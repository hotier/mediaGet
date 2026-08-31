// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as apiUtils from "@/lib/api-utils";
import * as resultCache from "@/lib/result-cache";

// 分享文案接口：提取链接后交给 unifiedParser，这里 mock 掉真实解析
const unifiedParserMock = vi.hoisted(() => ({ unifiedParser: vi.fn() }));
vi.mock("@/lib/unified-parser", () => ({
  unifiedParser: (...args) => unifiedParserMock.unifiedParser(...args),
}));

import { GET, POST } from "@/app/api/parse-text/route";

describe("api/parse-text (分享文案接口)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(apiUtils, "rateLimit").mockReturnValue(true);
    vi.spyOn(apiUtils, "sanitizeUrl").mockImplementation((url) => url);
    vi.spyOn(apiUtils, "getClientIP").mockReturnValue("203.0.113.42");
    // 中间件校验用真实 new URL 行为
    vi.spyOn(apiUtils, "isValidUrl").mockImplementation(
      (s) => { try { new URL(s); return true; } catch { return false; } }
    );
    vi.spyOn(resultCache, "getResultCache").mockResolvedValue(null);
    unifiedParserMock.unifiedParser.mockReset();
    unifiedParserMock.unifiedParser.mockResolvedValue({ code: 1, msg: "ok" });
  });

  it("快手文案：链接后跟空格+中文描述也能提取", async () => {
    const shareText =
      "https://v.kuaishou.com/Ku1rFvu1 你的新版奶爸来了唷\"转场 \"cos \"扁鹊\"\"王者荣耀cos 该作品在快手被播放过49.6万次，点击链接，打开【快手】直接观看！";
    const res = await GET(
      new Request("http://127.0.0.1/api/parse-text?text=" + encodeURIComponent(shareText))
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.code).toBe(200);
    expect(unifiedParserMock.unifiedParser).toHaveBeenCalledWith(
      "https://v.kuaishou.com/Ku1rFvu1"
    );
  });

  it("B站文案：链接后跟全角标点也能提取", async () => {
    const shareText =
      "【哔哩哔哩】https://b23.tv/AbCdEfZ，复制本条信息打开【哔哩哔哩】App查看精彩内容！";
    const res = await GET(
      new Request("http://127.0.0.1/api/parse-text?text=" + encodeURIComponent(shareText))
    );

    expect(res.status).toBe(200);
    expect(unifiedParserMock.unifiedParser).toHaveBeenCalledWith(
      "https://b23.tv/AbCdEfZ"
    );
  });

  it("抖音文案：链接前有标题、链接后跟空格也能提取", async () => {
    const shareText =
      "【这个视频太有意思了】 复制打开抖音，看看 https://v.douyin.com/xxxxx/ 的作品，太搞笑了";
    const res = await GET(
      new Request("http://127.0.0.1/api/parse-text?text=" + encodeURIComponent(shareText))
    );

    expect(res.status).toBe(200);
    expect(unifiedParserMock.unifiedParser).toHaveBeenCalledWith(
      "https://v.douyin.com/xxxxx/"
    );
  });

  it("链接后直接跟中文句号（无空格）也能提取", async () => {
    const shareText = "https://v.kuaishou.com/Ku1rFvu1。你的新版奶爸来了唷";
    const res = await GET(
      new Request("http://127.0.0.1/api/parse-text?text=" + encodeURIComponent(shareText))
    );

    expect(res.status).toBe(200);
    expect(unifiedParserMock.unifiedParser).toHaveBeenCalledWith(
      "https://v.kuaishou.com/Ku1rFvu1"
    );
  });

  it("纯文案无链接时返回 400", async () => {
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/parse-text?text=" +
          encodeURIComponent("这个视频太有意思了，没有链接")
      )
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe(400);
    expect(json.msg).toContain("提取");
    expect(unifiedParserMock.unifiedParser).not.toHaveBeenCalled();
  });

  it("text 参数为空时返回 400", async () => {
    const res = await GET(new Request("http://127.0.0.1/api/parse-text"));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.msg).toContain("text为空");
  });

  it("POST JSON body：{ text } 也能解析", async () => {
    const shareText = "快手看看：https://v.kuaishou.com/abcdEF 开黑走起！";
    const res = await POST(
      new Request("http://127.0.0.1/api/parse-text", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: shareText }),
      })
    );

    expect(res.status).toBe(200);
    expect(unifiedParserMock.unifiedParser).toHaveBeenCalledWith(
      "https://v.kuaishou.com/abcdEF"
    );
  });
});
