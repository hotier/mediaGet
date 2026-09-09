/**
 * AMLL 词库（https://amll.dev）TTML 歌词 → AMLL 可渲染行 的纯函数解析器。
 *
 * 词库返回的 XML 形如（时间为「秒数」或「mm:ss.xxx」两种，均支持）：
 *
 *   <tt ...>
 *     <body>
 *       <div begin=...>
 *         <p begin="8.738" end="13.638">
 *           <span begin="8.738" end="8.859">…</span>
 *           …
 *           <span ttm:role="x-translation" xml:lang="zh-CN">…逐句翻译…</span>
 *           <span ttm:role="x-bg" begin="11.357" end="13.638">…背景和声…</span>
 *         </p>
 *       </div>
 *     </body>
 *   </tt>
 *
 * 语义约定：
 *  - 每个 `<p>` 即一句主歌词：其直接子级、无 ttm:role 的 `<span>` 是带逐字
 *    时间戳的词；夹在词之间的纯文本空白还原为词间空格；
 *  - 句内 `ttm:role="x-translation"` 是整句翻译（无词级时间），转成
 *    AMLL 行的 translatedLyric；
 *  - `ttm:role="x-bg"`（背景和声）当前整体跳过，避免与主词形成两行重唱
 *    导致渲染层同轨重叠；
 *  - 时间重叠的相邻句会按下一句 begin 截断本句 end，保证同一时刻只有一行激活。
 *
 * 产物与 lyric-amll.ts 的 buildLrcAmll 同构（timed 秒级 + amll 毫秒级逐字行），
 * 供 AmllLyricView 在命中词库时直接使用。
 */

import type { LyricLine as AmllLine, LyricWord } from "@applemusic-like-lyrics/core";
import type { LyricLine as LrcLine } from "./lyric-utils";

/** 逐字结果：{ timed } 用于空态/点击跳转/兜底文本；{ amll } 用于 AMLL 渲染 */
export interface AmllRichResult {
  /** 秒级主句行（仅正文，无翻译），时间来自词库句级 begin */
  timed: LrcLine[];
  /** 毫秒级逐字行（words 带真时间戳 + translatedLyric） */
  amll: AmllLine[];
}

/** 单行最多允许的逐字词数（超出退化为整句单词，与 LRC 估算逻辑保持一致） */
const MAX_WORDS_PER_LINE = 160;
/** 最后一行缺 end 且无下一句时的兜底时长 */
const LAST_LINE_HOLD_MS = 8000;

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[\da-fA-F]+|\w+);/g, (all, code: string) => {
    if (code[0] === "#") {
      const isHex = code[1] === "x" || code[1] === "X";
      const num = parseInt(isHex ? code.slice(2) : code.slice(1), isHex ? 16 : 10);
      return Number.isFinite(num) ? String.fromCodePoint(num) : all;
    }
    const named = XML_ENTITIES[code];
    return named === undefined ? all : named;
  });
}

/** 兼容「0.115」（秒）与「04:25.541」（mm:ss.mmm）两种词库时间写法，转毫秒 */
function parseTtmlTime(raw?: string | null): number | null {
  if (!raw) return null;
  const text = raw.trim();
  if (!text) return null;
  let ms = 0;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    ms = Number(text) * 1000;
  } else {
    const parts = text.split(":");
    if (parts.length === 2) {
      ms = Number(parts[0]) * 60000 + Number(parts[1]) * 1000;
    } else if (parts.length === 3) {
      ms = Number(parts[0]) * 3600000 + Number(parts[1]) * 60000 + Number(parts[2]) * 1000;
    } else {
      return null;
    }
  }
  return Number.isFinite(ms) ? Math.round(ms) : null;
}

/** 简易 XML 子节点树（只为解析词库受控格式而生，不求通用） */
type XmlPart =
  | { t: "text"; v: string }
  | { t: "el"; name: string; attrs: Record<string, string>; parts: XmlPart[] };

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    attrs[m[1]] = decodeEntities(m[2]);
  }
  return attrs;
}

function pushText(parts: XmlPart[], text: string): void {
  if (!text) return;
  const last = parts[parts.length - 1];
  if (last && last.t === "text") {
    last.v += text;
  } else {
    parts.push({ t: "text", v: text });
  }
}

function parseXmlParts(source: string): XmlPart[] {
  const parts: XmlPart[] = [];
  let i = 0;
  while (i < source.length) {
    const openIdx = source.indexOf("<", i);
    if (openIdx < 0) {
      pushText(parts, source.slice(i));
      break;
    }
    if (openIdx > i) {
      pushText(parts, source.slice(i, openIdx));
      i = openIdx;
      continue;
    }
    // 仅出现在残余内容里的闭合标签：直接忽略并停止本级解析
    if (source.startsWith("</", i)) {
      const close = source.indexOf(">", i);
      i = close < 0 ? source.length : close + 1;
      break;
    }
    const tagEnd = source.indexOf(">", i);
    if (tagEnd < 0) {
      pushText(parts, source.slice(i));
      break;
    }
    const rawTag = source.slice(i, tagEnd + 1);
    const open = /^<([\w:.-]+)((?:\s[\s\S]*?)?)\/?>$/.exec(rawTag);
    if (!open) {
      i = tagEnd + 1;
      continue;
    }
    const name = open[1];
    const attrs = parseAttributes(open[2]);
    const isSelfClosing = rawTag.trimEnd().endsWith("/>");
    if (isSelfClosing) {
      parts.push({ t: "el", name, attrs, parts: [] });
      i = tagEnd + 1;
      continue;
    }
    // 找到与本开标签配对的闭合标签（按标签深度计）
    let depth = 1;
    let cursor = tagEnd + 1;
    let innerEnd = -1;
    while (cursor < source.length && depth > 0) {
      const lt = source.indexOf("<", cursor);
      if (lt < 0) break;
      if (source.startsWith("</", lt)) {
        const ct = source.indexOf(">", lt);
        depth -= 1;
        if (depth === 0) {
          innerEnd = lt;
          cursor = ct < 0 ? source.length : ct + 1;
          break;
        }
        cursor = ct < 0 ? source.length : ct + 1;
        continue;
      }
      const gt = source.indexOf(">", lt);
      const tag = source.slice(lt, gt < 0 ? source.length : gt + 1);
      const tagName = /^<([\w:.-]+)/.exec(tag)?.[1];
      if (tagName && !tag.trimEnd().endsWith("/>")) depth += 1;
      cursor = gt < 0 ? source.length : gt + 1;
    }
    let inner = "";
    if (innerEnd >= 0) {
      inner = source.slice(tagEnd + 1, innerEnd);
      i = cursor;
    } else {
      inner = source.slice(tagEnd + 1);
      i = source.length;
    }
    parts.push({ t: "el", name, attrs, parts: parseXmlParts(inner) });
  }
  return parts;
}

/** 收集某元素内部全部文字（供词/翻译文本），不解码已在叶子做的实体 */
function gatherText(parts: XmlPart[]): string {
  let out = "";
  for (const part of parts) {
    if (part.t === "text") {
      out += decodeEntities(part.v);
    } else {
      out += gatherText(part.parts);
    }
  }
  return out;
}

/** 时间未定词：{ beginMs/endMs: null } 由前后文补齐 */
interface RawWord {
  word: string;
  beginMs: number | null;
  endMs: number | null;
}

interface SentenceDraft {
  beginMs: number | null;
  endMs: number | null;
  translation: string;
  words: RawWord[];
}

interface ResolvedLine {
  startMs: number;
  endMs: number;
  mainText: string;
  translation: string;
  words: LyricWord[];
}

function parseSentence(attrRaw: string, inner: string): SentenceDraft | null {
  const attrs = parseAttributes(attrRaw);
  const parts = parseXmlParts(inner);
  const words: RawWord[] = [];
  let translation = "";
  let hasMain = false;
  let pendingSpace = false;
  for (const part of parts) {
    if (part.t === "text") {
      // 只把「不含换行的空白」当作词间空格；词库如以换行缩进排版，
      // 逐字中间会有 \n，若一律加空格会把中文拆散
      if (!/[\r\n]/.test(part.v) && /\s/.test(part.v)) pendingSpace = true;
      continue;
    }
    const role = part.attrs["ttm:role"] ?? "";
    if (role.includes("translation")) {
      translation += gatherText(part.parts);
      continue;
    }
    // 背景和声跳过（与主词重叠会导致双行同轨）
    if (role.includes("bg")) continue;
    const content = gatherText(part.parts).trim().replace(/\s+/g, " ");
    if (!content) continue;
    if (pendingSpace && words.length > 0) {
      words.push({ word: " ", beginMs: null, endMs: null });
    }
    words.push({
      word: content,
      beginMs: parseTtmlTime(part.attrs.begin),
      endMs: parseTtmlTime(part.attrs.end),
    });
    pendingSpace = false;
    hasMain = true;
  }
  if (!hasMain) return null;
  return {
    beginMs: parseTtmlTime(attrs.begin),
    endMs: parseTtmlTime(attrs.end),
    translation: translation.trim().replace(/\s+/g, " "),
    words,
  };
}

/** 用句级时间窗给词补全/收敛成合法毫秒词表 */
function timeWindowWords(
  drafts: RawWord[],
  startMs: number,
  endMs: number
): LyricWord[] {
  const out: LyricWord[] = [];
  let prev = startMs;
  for (let i = 0; i < drafts.length; i++) {
    const item = drafts[i];
    const next = drafts[i + 1];
    const isSpace = !item.word.trim();
    let s = item.beginMs ?? prev;
    if (s < prev) s = prev;
    if (s < startMs) s = startMs;
    if (s > endMs) s = endMs;
    let e: number;
    if (isSpace) {
      e = s;
    } else if (item.endMs != null) {
      e = item.endMs;
    } else {
      const nb = next && next.beginMs != null ? next.beginMs : null;
      e = nb != null && nb <= endMs ? Math.max(s + 1, nb) : endMs;
    }
    if (e <= s) e = Math.min(endMs, s + 1);
    if (e > endMs) e = endMs;
    if (e < prev) e = prev;
    out.push({ word: item.word, startTime: s, endTime: e });
    prev = Math.max(prev, e);
  }
  return out;
}

function assemble(drafts: SentenceDraft[]): AmllRichResult | null {
  if (!drafts.length) return null;
  drafts.sort((a, b) => (a.beginMs ?? 0) - (b.beginMs ?? 0));

  const lines: ResolvedLine[] = [];
  for (let i = 0; i < drafts.length; i++) {
    const draft = drafts[i];
    if (!draft.words.length) continue;
    const startMs = draft.beginMs ?? draft.words[0].beginMs ?? 0;
    if (lines.length && startMs <= lines[lines.length - 1].startMs) {
      // 同一起点重复句只保留先出现的一条，避免双行同轨
      continue;
    }
    const nextBegin = i + 1 < drafts.length ? drafts[i + 1].beginMs ?? null : null;
    let endMs: number;
    if (draft.endMs == null) {
      endMs = nextBegin ?? startMs + LAST_LINE_HOLD_MS;
    } else if (nextBegin != null && draft.endMs > nextBegin) {
      // 相邻句时间重叠（Apple 原数据常见）：按下一句起点截断
      endMs = nextBegin;
    } else {
      endMs = draft.endMs;
    }
    if (endMs <= startMs) {
      endMs = nextBegin != null && nextBegin > startMs ? nextBegin : startMs + 1000;
    }

    let words = timeWindowWords(draft.words, startMs, endMs);
    if (!words.length) continue;
    if (words.length > MAX_WORDS_PER_LINE) {
      const fullText = words.map((w) => w.word).join("");
      words = [{ word: fullText, startTime: startMs, endTime: endMs }];
    }
    lines.push({
      startMs,
      endMs,
      mainText: words.map((w) => w.word).join("").replace(/^\s+|\s+$/g, ""),
      translation: draft.translation,
      words,
    });
  }
  if (!lines.length) return null;

  const timed: LrcLine[] = lines.map((line) => ({
    time: line.startMs / 1000,
    text: line.mainText,
  }));
  const amll: AmllLine[] = lines.map((line) => ({
    words: line.words,
    translatedLyric: line.translation,
    romanLyric: "",
    startTime: line.startMs,
    endTime: line.endMs,
    isBG: false,
    isDuet: false,
  }));
  return { timed, amll };
}

/**
 * 解析词库 TTML 原文。找不到可渲染句时返回 null（调用方按「未命中」处理）。
 */
export function parseTtmlAmll(rawTtml: string): AmllRichResult | null {
  const ttml = rawTtml.trim();
  if (!ttml) return null;
  const drafts: SentenceDraft[] = [];
  const pRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  let m: RegExpExecArray | null;
  while ((m = pRe.exec(ttml))) {
    const draft = parseSentence(m[1], m[2]);
    if (draft) drafts.push(draft);
  }
  return assemble(drafts);
}
