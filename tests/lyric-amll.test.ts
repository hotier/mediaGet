import { describe, expect, it } from "vitest";
import { buildLrcAmll } from "@/components/music/lyric-amll";
import type { LyricLine } from "@/components/music/lyric-utils";

/** 便捷构造 LRC 行（time 秒，text 原句） */
const line = (time: number, text: string): LyricLine => ({ time, text });

describe("LRC → AMLL 歌词构建（lyric-amll）", () => {
  it("过滤无时间轴行并按时序升序排列", () => {
    const { timed, amll } = buildLrcAmll([
      line(3, "B"),
      line(-1, "作词：某甲"),
      line(1, "A"),
    ]);
    expect(timed.map((l) => l.time)).toEqual([1, 3]);
    expect(amll.map((l) => l.startTime)).toEqual([1000, 3000]);
  });

  it("普通行的结束时间取下一行起点", () => {
    const { amll } = buildLrcAmll([line(1, "A"), line(5, "B")]);
    expect(amll[0].endTime).toBe(5000);
  });

  it("句间空档过长时行区间按上限截断，把间奏让给 AMLL 自动展示", () => {
    const { amll } = buildLrcAmll([line(1, "A"), line(120, "B")]);
    // 上限 8s：结束 = 1000 + 8000，而不是吞到下一句
    expect(amll[0].endTime).toBe(9000);
  });

  it("最后一行贴合歌曲总时长（durationMs），未知时长用兜底保持", () => {
    const bounded = buildLrcAmll([line(200, "END")], { durationMs: 210_000 });
    expect(bounded.amll[0].endTime).toBe(210_000);

    const fallback = buildLrcAmll([line(200, "END")]);
    expect(fallback.amll[0].endTime).toBe(200_000 + 15_000);
  });

  it("中文歌词按字拆分并生成递增时间戳（逐字扫亮）", () => {
    const { amll } = buildLrcAmll([line(2, "你好世界")]);
    const amllLine = amll[0];
    expect(amllLine.words.length).toBeGreaterThan(1);
    expect(amllLine.words.map((w) => w.word).join("")).toBe("你好世界");
    expect(amllLine.words[0].startTime).toBe(2000);
    // 词级时间戳单调递增，且全部落在行区间内
    for (let i = 0; i < amllLine.words.length; i++) {
      const w = amllLine.words[i];
      expect(w.startTime).toBeGreaterThanOrEqual(2000);
      expect(w.endTime).toBeLessThanOrEqual(amllLine.endTime);
      if (i > 0) expect(w.startTime).toBeGreaterThanOrEqual(amllLine.words[i - 1].endTime);
    }
    expect(amllLine.words[amllLine.words.length - 1].endTime).toBe(amllLine.endTime);
  });

  it("英文歌词保留词间空格并拆成单词", () => {
    const { amll } = buildLrcAmll([line(1, "Life is a song")]);
    const amllLine = amll[0];
    expect(amllLine.words.map((w) => w.word).join("")).toBe("Life is a song");
    // 空格是独立原子（零演唱时长）
    expect(amllLine.words.some((w) => w.word === " ")).toBe(true);
  });

  it("纯音乐（空文本）行为 ♪ 占位且整段保持", () => {
    const { amll } = buildLrcAmll([line(1, ""), line(9, "正文")]);
    expect(amll[0].words).toHaveLength(1);
    expect(amll[0].words[0].word).toBe("♪");
    expect(amll[0].endTime).toBe(9000);
  });

  it("相同开始时间的重复行只保留第一条", () => {
    const { timed, amll } = buildLrcAmll([line(3, "A"), line(3, "B"), line(5, "C")]);
    expect(timed).toHaveLength(2);
    expect(timed[0].text).toBe("A");
    expect(amll[0].startTime).toBe(3000);
    expect(amll[1].startTime).toBe(5000);
  });

  it("amll 与 timed 一一对应（点行 seek 可用反查）", () => {
    const input = [line(2.5, "第一句"), line(4.2, "第二句")];
    const { timed, amll } = buildLrcAmll(input);
    expect(amll).toHaveLength(timed.length);
    amll.forEach((a, i) => {
      expect(Math.round(timed[i].time * 1000)).toBe(a.startTime);
    });
  });
});
