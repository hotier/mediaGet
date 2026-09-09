/**
 * LRC 歌词行 → AMLL（Apple Music Like Lyrics）歌词行 的纯函数构建器。
 *
 * 只做数据转换、不依赖 React / DOM，便于单元测试。
 *
 * 为什么需要这里而不是直接把 LRC 行塞给 LyricPlayer：
 * - LRC 只有每行开始时间，没有行结束时间。给每行补上真实行区间
 *   （默认取下一行起点），逐字扫亮 / 行切换才能按 AMLL 的时间线推进，
 *   而不是全部挤在行开始那一刻瞬间完成。
 * - AMLL 在 setLyricLines 时若「所有行都只有一个单词」会退化为静态整句
 *   渲染（isNonDynamic），逐字动画会整体失效。这里按空白 / CJK 字符把
 *   每句拆成带时间戳的单词，保证走逐词（karaoke）渲染路径。
 * - 切分方式与 AMLL core 内部 chunkAndSplitLyricWords 保持一致语义：
 *   空白独立成原子、CJK 序列逐字成原子，时间按「字/词时长比例」分配。
 */
import type { LyricLine as AmllLine, LyricWord } from "@applemusic-like-lyrics/core";
import type { LyricLine as LrcLine } from "./lyric-utils";

/** 空歌词数组的稳定引用（避免每次渲染新建数组导致下游重复计算） */
export const EMPTY_LRC_LINES: LrcLine[] = [];

/** 单行最大演唱时长：超过则不再吞掉后面的间奏（让 AMLL 自动显示间奏点） */
const LINE_MAX_HOLD_MS = 8_000;
/** 最后一行兜底保持时长（仍会被歌曲总时长截断） */
const LAST_LINE_HOLD_MS = 15_000;
/** 单行最多允许的单词数，防止超长段落把 DOM 与时间表撑爆 */
const MAX_WORDS_PER_LINE = 160;

/** 中日韩文字 + 常用全角标点：这类字符可单字拆分成逐字原子 */
const CJK_SINGLE_RE =
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303F\uFF01-\uFF5E\uFF61-\uFF9F]$/u;

export interface LrcToAmllOptions {
  /** 歌曲总时长（毫秒）。提供后可让最后一行歌词的保持时间贴合歌曲结尾 */
  durationMs?: number;
}

export interface LrcToAmllResult {
  /** 与 amll 一一对应的、保留原时间轴的有序歌词行（秒单位） */
  timed: LrcLine[];
  /** 可直接传给 LyricPlayer 的 AMLL 歌词行（毫秒单位） */
  amll: AmllLine[];
}

interface Atom {
  text: string;
  units: number;
}

/**
 * 把一句歌词拆成原子：
 * - 空白作为一个独立原子（保留单词间视觉空隙，不占用演唱时长）；
 * - 全中文/日文/韩文/全角标点的连续段按「字」拆开；
 * - 其余（拉丁文、混排等）整段作为一个词原子。
 */
function karaokeAtoms(text: string): Atom[] {
  const atoms: Atom[] = [];
  const parts = text.split(/(\s+)/).filter((p) => p.length > 0);
  for (const part of parts) {
    if (!part.trim()) {
      // 连续空白折叠成单个空格
      atoms.push({ text: " ", units: 0 });
      continue;
    }
    const chars = Array.from(part);
    const allSingleWidth = chars.every((ch) => CJK_SINGLE_RE.test(ch));
    if (allSingleWidth) {
      for (const ch of chars) atoms.push({ text: ch, units: 1 });
    } else {
      atoms.push({ text: part, units: 1 });
    }
  }
  return atoms;
}

/**
 * 把一句歌词按演唱区间 [startMs, endMs) 均匀分配到各原子，
 * 让每个字/词都带上递增的时间戳，从而驱动逐字扫亮动画。
 */
function distributeWords(startMs: number, endMs: number, text: string): LyricWord[] {
  const span = endMs - startMs;
  if (!text.trim()) {
    // 纯音乐段落：沿用 Apple Music 惯例给 ♪ 占位，保持该行常亮一整段
    return [{ word: "♪", startTime: startMs, endTime: endMs }];
  }
  const atoms = karaokeAtoms(text);
  if (atoms.length > MAX_WORDS_PER_LINE) {
    // 超长段落退化为整句单词（保留显示、放弃逐字）
    return [{ word: text, startTime: startMs, endTime: endMs }];
  }
  if (atoms.length === 1 && atoms[0].units === 0) {
    // 几乎不可能：纯空白歌词
    return [{ word: text, startTime: startMs, endTime: endMs }];
  }
  const totalUnits = atoms.reduce((sum, a) => sum + a.units, 0) || 1;
  const words: LyricWord[] = [];
  let used = 0;
  for (const atom of atoms) {
    const s = Math.round(startMs + (span * used) / totalUnits);
    if (atom.units <= 0) {
      words.push({ word: atom.text, startTime: s, endTime: s });
      continue;
    }
    used += atom.units;
    const e = Math.max(s + 1, Math.round(startMs + (span * used) / totalUnits));
    words.push({ word: atom.text, startTime: s, endTime: e });
  }
  return words;
}

/** 计算某一行（有序 timed 数组内）应占据的结束时间（毫秒） */
function resolveEndMs(timed: LrcLine[], index: number, durationMs?: number): number {
  const startMs = Math.round(timed[index].time * 1000);
  const nextStart = index + 1 < timed.length ? Math.round(timed[index + 1].time * 1000) : null;
  if (nextStart != null) {
    // 常规：行区间一直延续到下一句起点；句间若有大段空白则截断到最大保持时长
    return Math.min(nextStart, startMs + LINE_MAX_HOLD_MS);
  }
  // 最后一行：贴合歌曲结尾；未知时长则用兜底保持
  const fallback = startMs + LAST_LINE_HOLD_MS;
  if (durationMs != null && durationMs > startMs) return Math.min(durationMs, fallback);
  return fallback;
}

/**
 * LRC 行 → AMLL 行。
 * - 只保留带时间轴的歌词行（time >= 0），按开始时间升序排好；
 * - 相同开始时间的重复行只保留第一条（避免产生零宽度的空行）；
 * - 返回的 timed 与 amll 一一对应，供「点行 seek」反查原时间使用。
 */
export function buildLrcAmll(lines: readonly LrcLine[], options: LrcToAmllOptions = {}): LrcToAmllResult {
  const timed: LrcLine[] = [];
  for (const line of lines) {
    if (!(line.time >= 0)) continue;
    timed.push(line);
  }
  timed.sort((a, b) => a.time - b.time);
  // 排序后去掉相同开始时间的重复行，避免产生零宽度的空行
  for (let i = timed.length - 1; i > 0; i--) {
    if (timed[i].time === timed[i - 1].time) timed.splice(i, 1);
  }

  const amll: AmllLine[] = [];
  for (let i = 0; i < timed.length; i++) {
    const startMs = Math.round(timed[i].time * 1000);
    const endMs = resolveEndMs(timed, i, options.durationMs);
    const words = distributeWords(startMs, endMs, timed[i].text);
    amll.push({
      words,
      translatedLyric: "",
      romanLyric: "",
      startTime: startMs,
      endTime: endMs,
      isBG: false,
      isDuet: false,
    });
  }
  return { timed, amll };
}
