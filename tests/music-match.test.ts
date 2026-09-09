// @ts-nocheck
import { describe, expect, it } from "vitest";
import {
  aggregateAndRankSearch,
  cleanMusicText,
  crossSearchKeyword,
  isSameSong,
  musicKey,
  rankSongMatchCandidates,
  relevanceOf,
  scoreSongMatch,
  splitSearchTokens,
  stripVersionSuffix,
} from "@/lib/music-match";

function song(partial) {
  return { id: "id", urlId: "urlId", name: "歌名", artist: ["歌手"], album: "专辑", source: "netease", ...partial };
}

describe("cleanMusicText", () => {
  it("去除括号备注", () => {
    expect(cleanMusicText("晴天 (Live)")).toBe("晴天");
    expect(cleanMusicText("晴天（伴奏）")).toBe("晴天");
    expect(cleanMusicText("【原版】晴天")).toBe("晴天");
  });
  it("去除 feat 后半段与空白/分隔符", () => {
    expect(cleanMusicText("Love Song feat. 方大同")).toBe("lovesong");
    expect(cleanMusicText("Love Song")).toBe("lovesong");
    expect(cleanMusicText("周杰伦 · 晴天")).toBe("周杰伦晴天");
  });
});

describe("musicKey", () => {
  it("以 source+id 组键", () => {
    expect(musicKey({ source: "kuwo", id: "123" })).toBe("kuwo:123");
  });
});

describe("splitSearchTokens", () => {
  it("按常见分隔拆词并去重", () => {
    expect(splitSearchTokens("周杰伦 晴天")).toEqual(["周杰伦", "晴天"]);
    expect(splitSearchTokens("邓紫棋，光年之外")).toEqual(["邓紫棋", "光年之外"]);
    expect(splitSearchTokens("陶喆/爱很简单")).toEqual(["陶喆", "爱很简单"]);
  });
  it("去重 & 忽略纯符号片段", () => {
    expect(splitSearchTokens("晴天 晴天")).toEqual(["晴天"]);
    expect(splitSearchTokens("... ---")).toEqual([]);
  });
  it("保留单个 CJK 字符", () => {
    expect(splitSearchTokens("飘")).toEqual(["飘"]);
  });
});

describe("relevanceOf", () => {
  it("清洗后歌名与关键词一致 → 100", () => {
    const r = relevanceOf("晴天 (Live)", song({ name: "晴天" }));
    expect(r.score).toBe(100);
    expect(r.exact).toBe(true);
  });
  it("歌名命中为主、歌手命中为辅", () => {
    // 关键词只中歌手：评分应低于「歌名+歌手」双命中
    const artistOnly = relevanceOf("周杰伦", song({ name: "七里香", artist: ["周杰伦"] }));
    const both = relevanceOf("周杰伦 晴天", song({ name: "晴天", artist: ["周杰伦"] }));
    expect(both.score).toBeGreaterThan(artistOnly.score);
    expect(both.score).toBe(100);
  });
  it("同曲异名歌手关键词也能区分主次", () => {
    const wanted = relevanceOf("晴天 周杰伦", song({ name: "晴天", artist: ["周杰伦"] }));
    const otherSinger = relevanceOf("晴天 周杰伦", song({ name: "晴天", artist: ["阿杜"] }));
    expect(wanted.score).toBeGreaterThan(otherSinger.score);
  });
  it("无关词条得分低", () => {
    const r = relevanceOf("七里香", song({ name: "晴天", artist: ["周杰伦"] }));
    expect(r.score).toBeLessThan(60);
  });
  it("打分档位按命中位置拉开：歌名+歌手双命中 > 仅歌名 > 仅歌手", () => {
    const nameAndArtist = relevanceOf("周杰伦", song({ name: "周杰伦的朋友们", artist: ["周杰伦"] }));
    const nameOnly = relevanceOf("周杰伦", song({ name: "周杰伦的朋友们", artist: ["陶喆"] }));
    const artistOnly = relevanceOf("周杰伦", song({ name: "朋友", artist: ["周杰伦"] }));
    expect(artistOnly.score).toBe(55);
    expect(nameOnly.score).toBeGreaterThan(artistOnly.score);
    expect(nameAndArtist.score).toBeGreaterThan(nameOnly.score);
  });
});

describe("isSameSong", () => {
  it("同名+歌手交集+专辑一致 → 同一首", () => {
    expect(
      isSameSong(
        song({ name: "晴天", artist: ["周杰伦"], album: "叶惠美" }),
        song({ source: "tencent", name: "晴天", artist: ["周杰伦"], album: "叶惠美" })
      )
    ).toBe(true);
  });
  it("歌手不一致不合并", () => {
    expect(
      isSameSong(
        song({ name: "晴天", artist: ["周杰伦"] }),
        song({ source: "kuwo", name: "晴天", artist: ["阿杜"] })
      )
    ).toBe(false);
  });
  it("专辑不一致（同一歌手同名不同录制）不合并", () => {
    expect(
      isSameSong(
        song({ name: "夜曲", artist: ["周杰伦"], album: "十一月的萧邦" }),
        song({ source: "tencent", name: "夜曲", artist: ["周杰伦"], album: "2004无与伦比演唱会" })
      )
    ).toBe(false);
  });
});

describe("aggregateAndRankSearch", () => {
  it("跨源同曲合并：取可播副本为主、统计 merged", () => {
    const results = aggregateAndRankSearch(
      "晴天",
      [
        song({ source: "netease", name: "晴天", artist: ["周杰伦"], album: "叶惠美", urlId: "netease-id" }),
        song({ source: "kugou", name: "晴天", artist: ["周杰伦"], album: "叶惠美", urlId: "" }),
        song({ source: "migu", name: "晴天", artist: ["周杰伦"], album: "叶惠美", urlId: "" }),
      ],
      {
        engineOrder: { netease: 0, kugou: 1, migu: 2 },
        betterPrimary: (a, b) => Boolean(a.urlId) && !b.urlId,
      }
    );
    expect(results.stats.raw).toBe(3);
    expect(results.stats.merged).toBe(2);
    expect(results.items).toHaveLength(1);
    // 主条目收敛为可播的 netease 副本
    expect(results.items[0].source).toBe("netease");
  });
  it("不同曲目按相关度降序", () => {
    const results = aggregateAndRankSearch("晴天", [
      song({ source: "netease", name: "晴天", artist: ["周杰伦"] }),
      song({ source: "kuwo", name: "晴天娃娃", artist: ["小柯"] }),
      song({ source: "tencent", name: "青花瓷", artist: ["周杰伦"] }),
    ]);
    expect(results.items.map((x) => x.name)).toEqual(["晴天", "晴天娃娃", "青花瓷"]);
  });
  it("跨源同分时按 engineOrder 保持确定性（乱序输入结果一致）", () => {
    const a = song({ source: "netease", name: "晴天", artist: ["周杰伦"] });
    const b = song({ source: "tencent", name: "晴天", artist: ["周杰伦"] });
    const order = { netease: 0, tencent: 1 };
    const r1 = aggregateAndRankSearch("晴天", [a, b], { engineOrder: order });
    const r2 = aggregateAndRankSearch("晴天", [b, a], { engineOrder: order });
    expect(r1.items[0].source).toBe("netease");
    expect(r2.items[0].source).toBe("netease");
  });
  it("截断超 cap 的低相关条目", () => {
    const many = Array.from({ length: 90 }, (_, i) =>
      song({ source: "netease", id: `id-${i}`, name: `无关歌曲${i}`, artist: ["未知"] })
    );
    const results = aggregateAndRankSearch("晴天", many, { cap: 50 });
    expect(results.stats.raw).toBe(90);
    expect(results.stats.truncated).toBe(40);
    expect(results.items).toHaveLength(50);
  });
  it("排序只由关键词打分决定：并发乱序输入输出一致、分数单调不增", () => {
    // 同一歌手的多首歌（只有歌手命中关键词、分数并列）：此时也绝不能“谁先被输入谁排前”
    const mk = (source, i) =>
      song({ source, name: `${source}#热歌${i}`, artist: ["周杰伦"] });
    const byPlatform = [
      ...Array.from({ length: 3 }, (_, i) => mk("netease", i)),
      ...Array.from({ length: 3 }, (_, i) => mk("kugou", i)),
      ...Array.from({ length: 3 }, (_, i) => mk("migu", i)),
    ];
    const shuffled = [
      mk("netease", 0), mk("kugou", 0), mk("netease", 1), mk("migu", 0),
      mk("kugou", 1), mk("netease", 2), mk("migu", 1), mk("kugou", 2),
      mk("migu", 2),
    ];
    const ra = aggregateAndRankSearch("周杰伦", byPlatform);
    const rb = aggregateAndRankSearch("周杰伦", shuffled);
    expect(ra.stats.merged).toBe(0);
    expect(ra.items.map((x) => `${x.source}#${x.name}`)).toEqual(
      rb.items.map((x) => `${x.source}#${x.name}`)
    );
    // 核心：顺序由相关度（内容）决定 —— 分数单调不增
    const scores = ra.items.map((x) => relevanceOf("周杰伦", x).score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
    }
    // 纯歌手词下各歌都是同档“歌手命中”，并列属正常（不再由平台序充当次序）
    expect(scores.every((s) => s === scores[0])).toBe(true);
  });
});

describe("stripVersionSuffix / crossSearchKeyword（跨源现搜 B 用）", () => {
  it("去掉括号备注与结尾版本词（保留主标题）", () => {
    expect(stripVersionSuffix("晴天 (Live)")).toBe("晴天");
    expect(stripVersionSuffix("晴天 live")).toBe("晴天");
    expect(stripVersionSuffix("晴天（伴奏）")).toBe("晴天");
    expect(stripVersionSuffix("Love Song (Live)")).toBe("Love Song");
    expect(stripVersionSuffix("晴天 feat. 张三")).toBe("晴天");
  });
  it("中文主标题后直接跟英文版本词也能去掉", () => {
    expect(stripVersionSuffix("晴天live")).toBe("晴天");
  });
  it("搜索词保留主标题空格（搜索引擎友好），版本词仍被剔除", () => {
    expect(crossSearchKeyword({ name: "Love Song (Live)" })).toBe("Love Song");
    expect(crossSearchKeyword({ name: "晴天 (Live)" })).toBe("晴天");
  });
});

describe("scoreSongMatch（跨源现搜同曲评分）", () => {
  const tgt = { name: "晴天", artist: ["周杰伦"], album: "叶惠美" };
  it("歌名/歌手/专辑一致 → 100 分自动候选", () => {
    const r = scoreSongMatch(tgt, { name: "晴天", artist: ["周杰伦"], album: "叶惠美" });
    expect(r).not.toBeNull();
    expect(r.score).toBe(100);
    expect(r.auto).toBe(true);
    expect(r.albumDiff).toBe(false);
  });
  it("现场版/括号版本不影响同曲判定", () => {
    const r = scoreSongMatch(tgt, { name: "晴天 (Live)", artist: ["周杰伦"], album: "叶惠美" });
    expect(r.score).toBe(100);
    expect(r.auto).toBe(true);
  });
  it("专辑都给但不同（另一录制）→ 降人工、标 albumDiff", () => {
    const r = scoreSongMatch(tgt, { name: "晴天", artist: ["周杰伦"], album: "演唱会实录" });
    expect(r.albumDiff).toBe(true);
    expect(r.auto).toBe(false);
    expect(r.score).toBeGreaterThanOrEqual(60);
  });
  it("专辑缺省不扣分，同名同歌手仍可自动", () => {
    const r = scoreSongMatch({ name: "晴天", artist: ["周杰伦"], album: "" }, { name: "晴天", artist: ["周杰伦"] });
    expect(r.auto).toBe(true);
  });
  it("歌手无交集 → 判不同歌（null）", () => {
    expect(
      scoreSongMatch(tgt, { name: "晴天", artist: ["阿杜"], album: "叶惠美" })
    ).toBeNull();
  });
  it("歌名重叠不足 → 判不同歌（null）", () => {
    expect(
      scoreSongMatch(tgt, { name: "告白气球", artist: ["周杰伦"], album: "叶惠美" })
    ).toBeNull();
  });
  it("歌名仅包含关系（同名前缀不同歌）→ 不给自动", () => {
    const r = scoreSongMatch(
      { name: "晴天", artist: ["周杰伦"], album: "叶惠美" },
      { name: "晴天娃娃", artist: ["周杰伦"] }
    );
    expect(r.auto).toBe(false);
    expect(r.score).toBeGreaterThanOrEqual(60); // 仍进人工候选
  });
});

describe("rankSongMatchCandidates（跨源现搜候选收敛）", () => {
  const tgt = { name: "晴天", artist: ["周杰伦"], album: "叶惠美" };
  const exact = song({ source: "tencent", id: "a", name: "晴天", artist: ["周杰伦"], album: "叶惠美" });
  const include = song({ source: "kuwo", id: "b", name: "晴天娃娃", artist: ["周杰伦"] }); // 同名前缀不同歌 → 人工
  const unrelated = song({ source: "netease", id: "c", name: "告白气球", artist: ["周杰伦"], album: "叶惠美" });
  it("自动优先、高分在前、不相关条目剔除", () => {
    const r = rankSongMatchCandidates(tgt, [include, unrelated, exact]);
    expect(r.map((x) => x.item.id)).toEqual(["a", "b"]);
    expect(r[0].auto).toBe(true);
    expect(r[1].auto).toBe(false);
  });
  it("同 key 去重 & 保留更高分版本", () => {
    const dup = song({ source: "tencent", id: "a", name: "晴天", artist: ["周杰伦"], album: "演唱会" });
    const r = rankSongMatchCandidates(tgt, [exact, dup]);
    expect(r).toHaveLength(1);
    expect(r[0].score).toBeGreaterThanOrEqual(dup.score ?? 0);
    expect(r[0].item.album).toBe("叶惠美");
  });
});
