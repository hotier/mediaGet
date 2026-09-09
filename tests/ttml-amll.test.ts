import { describe, expect, it } from "vitest";
import { parseTtmlAmll } from "../src/components/music/ttml-amll";

describe("parseTtmlAmll", () => {
  it("解析秒制逐字行，词间空格按字面保留，实体被解码", () => {
    const raw = `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><body><div>
<p begin="0.115" end="2.813"><span begin="0.115" end="0.308">I</span> <span begin="0.328" end="0.531">promise</span> <span begin="0.551" end="0.912">that</span> <span begin="0.912" end="1.213">you&apos;ll</span> <span begin="1.233" end="1.514">never</span> <span begin="1.514" end="1.617">find</span><span ttm:role="x-translation" xml:lang="zh-CN">我保证你永远找得到</span></p>
</div></body></tt>`;

    const result = parseTtmlAmll(raw);
    expect(result).not.toBeNull();
    const { timed, amll } = result!;
    expect(timed).toHaveLength(1);
    expect(timed[0].time).toBeCloseTo(0.115, 3);
    expect(timed[0].text).toBe("I promise that you'll never find");
    expect(amll[0].words.length).toBeGreaterThan(5);
    const apostropheIndex = amll[0].words.findIndex((w) => w.word === "you'll");
    expect(apostropheIndex).toBeGreaterThan(0);
    expect(amll[0].words[apostropheIndex].word).toBe("you'll");
    expect(amll[0].translatedLyric).toBe("我保证你永远找得到");
  });

  it("分钟制(m:ss.xxx)时间正确换算毫秒，CJK 逐字不插入多余空格", () => {
    const raw = `<tt><body><div>
<p begin="00:02.900" end="00:03.900"><span begin="00:02.900" end="00:03.100">你</span><span begin="00:03.100" end="00:03.400">好</span><span begin="00:03.400" end="00:03.900">拜</span></p>
</div></body></tt>`;

    const result = parseTtmlAmll(raw);
    expect(result).not.toBeNull();
    const { timed, amll } = result!;
    expect(timed[0].time).toBeCloseTo(2.9, 3);
    expect(amll[0].startTime).toBe(2900);
    expect(amll[0].endTime).toBe(3900);
    const texts = amll[0].words.map((w) => w.word);
    expect(texts).toEqual(["你", "好", "拜"]);
    expect(texts.join("")).toBe("你好拜");
  });

  it("跳过 ttm:role=x-bg 背景和声，只取主词与整句翻译", () => {
    const raw = `<tt><body><div>
<p begin="8.738" end="13.638"><span begin="8.738" end="8.859">关</span><span begin="8.859" end="9.101">掉</span><span ttm:role="x-translation" xml:lang="zh-CN">翻成英文(主句翻译)</span><span ttm:role="x-bg" begin="11.357" end="13.638"><span begin="11.357" end="11.700">背景</span><span begin="11.700" end="12.100">和声</span></span></p>
</div></body></tt>`;

    const result = parseTtmlAmll(raw);
    expect(result).not.toBeNull();
    const { amll } = result!;
    expect(amll[0].words.map((w) => w.word)).toEqual(["关", "掉"]);
    expect(amll[0].translatedLyric).toBe("翻成英文(主句翻译)");
  });

  it("相邻句时间重叠时截断到下一句起点，避免双行同轨", () => {
    const raw = `<tt><body><div>
<p begin="0" end="5.0"><span begin="0" end="0.5">一</span><span begin="0.5" end="1.0">句</span></p>
<p begin="3.0" end="6.0"><span begin="3.0" end="3.4">二</span><span begin="3.4" end="3.8">句</span></p>
</div></body></tt>`;

    const result = parseTtmlAmll(raw);
    expect(result).not.toBeNull();
    const { timed, amll } = result!;
    expect(timed).toHaveLength(2);
    expect(amll[0].endTime).toBe(3000);
    expect(amll[1].startTime).toBe(3000);
    expect(amll[1].words[0].startTime).toBe(3000);
  });

  it("无 <p> 或空输入返回 null", () => {
    expect(parseTtmlAmll("")).toBeNull();
    expect(parseTtmlAmll("<tt><body></body></tt>")).toBeNull();
  });
});
