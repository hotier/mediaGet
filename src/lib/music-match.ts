/**
 * @file 音乐「聚合搜索」与播放失败自动换源共用的纯函数：
 * 文本清洗 / 关键词相关度打分 / 跨源同曲判定与去重排序。
 *
 * 定位（无副作用、前后端/测试皆可复用，勿 import 任何组件或网络层）：
 * - `cleanMusicText` / `musicKey` / `isSameSong`：同歌判定（供播放失败换源、
 *   聚合跨源去重用同一套规则，避免两处逻辑漂移）；
 * - `splitSearchTokens` / `relevanceOf`：关键词相关度打分（聚合搜索排序）；
 * - `aggregateAndRankSearch`：把多音源第一页搜索结果并集 → 同曲合并（保留最佳
 *   可播副本）→ 按相关度降序 → 截断输出（供 MusicExplorer「聚合搜索」模式消费）。
 */

import type { SearchItem } from "@/lib/music-client";

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;
const SEP_RE = /[\s,，、;；.。··/&+~_\-—]+/;

/**
 * 聚合搜索单次展示上限。聚合会跨源去重、按相关度排序，截断超出的低相关结果，
 * 避免把几百条平铺进列表（无分页语义）。
 */
export const MAX_AGGREGATE_RESULTS = 80;

/** 清洗歌名/歌手/专辑文本：小写、去括号备注、去 feat 后半段、去空白/分隔符。 */
export function cleanMusicText(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/[\[【（(].*?[\]】）)]/g, "")
    .replace(/\s*(?:feat\.?|ft\.?)[\s\S]*/i, "")
    .replace(/[\s·,，。、．_\-/&+~]+/g, "");
}

/** 单曲唯一键（source + 原始 id）；同一平台的 id 应唯一。 */
export function musicKey(it: Pick<SearchItem, "source" | "id">): string {
  return `${it.source}:${it.id || ""}`;
}

/** 把用户搜索词拆成清洗后的关键词 token（保留单个 CJK 字符，忽略纯符号）。 */
export function splitSearchTokens(keyword: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of String(keyword || "").split(SEP_RE)) {
    const t = cleanMusicText(raw);
    if (!t) continue;
    if (t.length < 2 && !CJK_RE.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export interface RelevanceDetail {
  /** 相关度 0-100，越大越相关；打分只看「歌曲字段 ↔ 关键词」，不含任何平台信息。 */
  score: number;
  /** 清洗后歌名与整段关键词完全一致（强命中信号）。 */
  exact: boolean;
  /** 命中「歌名」的关键词 token 数（排序次级键：歌名承载越多关键词越相关）。 */
  nameT: number;
  /** 命中「任一歌手」的关键词 token 数。 */
  artT: number;
}

/**
 * 搜索结果与用户关键词的相关度打分（0-100，整数）。
 *
 * 规则只由「关键词、歌名、歌手」的文本匹配决定，与结果来自哪个平台无关：
 * - 清洗后歌名 === 整段关键词 → 100（最贴近用户意图）；
 * - 单关键词：歌名与歌手双命中 → 99；仅歌名命中 → 96；仅歌手命中 → 55。
 *   例：纯歌手词“周杰伦”下，他所有歌都只能算“歌手命中”（55 分相同属正常），
 *   此时再往下由跨平台共识排位兜底，而不是让平台顺序来决定先后。
 * - 多关键词且所有词都被命中（歌名 ∪ 歌手）→ 100；歌名独力覆盖全部词 → 99；
 * - 其余部分覆盖：每命中一个词计分，歌名权重 1.0、歌手权重 0.5，按词数归一 ×100。
 *
 * 例：关键词“周杰伦 晴天” → 歌名《晴天》歌手周杰伦：两词覆盖 → 100；
 *     同歌手其他歌《七里香》：仅“周杰伦”命中歌手 → 100×(0+0.5)/2 = 25，明显低于目标歌。
 */
export function relevanceOf(keyword: string, item: Pick<SearchItem, "name" | "artist">): RelevanceDetail {
  const tokens = splitSearchTokens(keyword);
  const name = cleanMusicText(item.name);
  const artists = (item.artist || []).map(cleanMusicText).filter(Boolean);
  const kw = cleanMusicText(keyword);
  if (!tokens.length) return { score: 0, exact: false, nameT: 0, artT: 0 };

  const exact = Boolean(name && kw && name === kw);
  if (exact) return { score: 100, exact: true, nameT: 0, artT: 0 };

  const n = tokens.length;
  let nameT = 0;
  let artT = 0;
  const covered = new Array<boolean>(n).fill(false);
  tokens.forEach((t, i) => {
    const onName = Boolean(name && (name.includes(t) || t.includes(name)));
    const onArtist = artists.some((a) => Boolean(a && (a.includes(t) || t.includes(a))));
    if (onName) nameT += 1;
    if (onArtist) artT += 1;
    if (onName || onArtist) covered[i] = true;
  });

  let score: number;
  if (n === 1) {
    if (nameT && artT) score = 99;
    else if (nameT) score = 96;
    else if (artT) score = 55;
    else score = 0;
  } else if (covered.every(Boolean)) {
    score = nameT >= n ? 99 : 100;
  } else {
    score = Math.round(((nameT + 0.5 * artT) / n) * 100);
  }
  return { score, exact: false, nameT, artT };
}

/**
 * 是否为“同一首歌”判定（用于聚合跨源去重、换源候选收敛）。
 * - 清洗后歌名必须完全一致；
 * - 歌手集合必须有交集（任一侧缺失视为无交集，避免误并）；
 * - 专辑都给出且不一致时判定为不同版本/录制（不合并）。
 */
export function isSameSong(
  a: Pick<SearchItem, "name" | "artist" | "album">,
  b: Pick<SearchItem, "name" | "artist" | "album">
): boolean {
  const na = cleanMusicText(a.name);
  const nb = cleanMusicText(b.name);
  if (!na || na !== nb) return false;
  const aa = (a.artist || []).map(cleanMusicText).filter(Boolean);
  const ab = (b.artist || []).map(cleanMusicText).filter(Boolean);
  if (!aa.length || !ab.length) return false;
  const intersect = aa.some((x) => ab.includes(x));
  if (!intersect) return false;
  const al = cleanMusicText(a.album);
  const bl = cleanMusicText(b.album);
  if (al && bl && al !== bl) return false;
  return true;
}

export interface AggregatedSearch {
  /** 去重 + 打分排序后的结果行（每项带自身 source，可直接走播放/歌词/封面链路）。 */
  items: SearchItem[];
  stats: {
    /** 参与聚合的原始条目总数（各源第一页之和）。 */
    raw: number;
    /** 跨源同曲被合并掉的条目数。 */
    merged: number;
    /** 超出 cap 被截断的低相关条目数。 */
    truncated: number;
  };
}

export interface AggregateOptions {
  /** 展示上限，默认 `MAX_AGGREGATE_RESULTS`。 */
  cap?: number;
  /** 同曲合并时确定「主展示副本」的引擎偏好（source → 序号）：相关度与可播性都不分
   *  高下时，选更靠前源的版本作为这一行的来源与链接。只作用于合并取舍，不参与排序。 */
  engineOrder?: Record<string, number>;
  /** 同分合并时是否应把 b 换成 a 作为主展示副本（如 a 可播而 b 仅展示）。 */
  betterPrimary?: (a: SearchItem, b: SearchItem) => boolean;
}

/**
 * 聚合搜索结果核心算法：跨源并集 → 同曲合并（主条目取相关度最高；同分取更可播、
 * 更靠前源的版本作为展示副本）→ 排序 → 截断。
 *
 * 排序只与「歌曲内容 ↔ 关键词」有关、与平台无关，绝不按引擎顺序/来源排：
 * 1. 相关度分数（relevanceOf）降序——分数已把「整段一致 100、歌名命中 > 歌手命中、
 *    覆盖词越多越高」等内容差异拉开，绝大多数条目不再同分；
 * 2. 仍并列的（如纯歌手搜索下该歌手每首歌都只能算“歌手命中”）依次取
 *    「歌名命中词数 → 歌手命中词数 → 被多少条候选命中（跨源共识）→ 各源首页里出现得
 *    最靠前的位次 → 歌曲内容键」定先后。共识与位次是“多个平台都把它排在首页前面”
 *    的共同判断，不偏向任何平台；内容键则保证并发返回乱序时输出完全一致。
 *
 * 注：界面出现“明显按平台排序”，根因是旧打分档位太粗导致整片同分、再拿平台顺序当
 * 次序；这里从根上拿掉平台对排序的影响。
 */
export function aggregateAndRankSearch(
  keyword: string,
  candidates: SearchItem[],
  opts: AggregateOptions = {}
): AggregatedSearch {
  const cap = opts.cap ?? MAX_AGGREGATE_RESULTS;
  const orderOf = (source: string) => opts.engineOrder?.[source] ?? 0;

  interface Row {
    item: SearchItem;
    /** 内容相关度分（0-100）。 */
    score: number;
    exact: boolean;
    /** 命中歌名的关键词词数。 */
    nameT: number;
    /** 命中歌手的关键词词数。 */
    artT: number;
    /** 同曲合并时挑主展示副本的引擎序号（只用于合并取舍，不参与排序）。 */
    order: number;
    /** 该曲在来源首页中的位次（0 起，按每个来源自己数）；合并后取各源的最小位次。 */
    pos: number;
    /** 被多少条候选命中合并进来（跨源共识数）。 */
    versions: number;
  }
  const rows: Row[] = [];
  let merged = 0;
  const posBySource = new Map<string, number>();

  for (const it of candidates) {
    const name = cleanMusicText(it.name);
    if (!name || !it.source) continue;
    const rel = relevanceOf(keyword, it);
    const order = orderOf(it.source);
    // 该条在其所属来源首页的位次：并发返回乱序不影响（位次按来源各自计）
    const pos = posBySource.get(it.source) ?? 0;
    posBySource.set(it.source, pos + 1);

    const existing = rows.find((r) => isSameSong(r.item, it));
    if (existing) {
      existing.versions += 1;
      merged += 1;
      if (pos < existing.pos) existing.pos = pos;
      const sameScore = rel.score === existing.score;
      const candidateBetter =
        rel.score > existing.score ||
        (sameScore && opts.betterPrimary?.(it, existing.item)) ||
        (sameScore && order < existing.order);
      if (candidateBetter) {
        existing.item = it;
        existing.score = rel.score;
        existing.order = order;
      }
      continue;
    }
    rows.push({
      item: it,
      score: rel.score,
      exact: rel.exact,
      nameT: rel.nameT,
      artT: rel.artT,
      order,
      pos,
      versions: 1,
    });
  }

  const matched = rows.length;

  // —— 排序：先由内容相关度分（relevanceOf）拉开档次，分数相同的极小并列再依次用
  // 歌名/歌手命中词数、跨源共识（versions）、各源首页最靠前位次（pos）与歌曲内容键
  // 定先后。比较过程不读取来源与引擎顺序 —— 排序与平台无关。
  const contentKeyOf = (it: SearchItem) =>
    [
      cleanMusicText(it.name),
      (it.artist || []).map(cleanMusicText).join("+"),
      cleanMusicText(it.album || ""),
    ].join("|");
  rows.sort((x, y) => {
    if (y.score !== x.score) return y.score - x.score;
    if (y.exact !== x.exact) return Number(y.exact) - Number(x.exact);
    if (y.nameT !== x.nameT) return y.nameT - x.nameT;
    if (y.artT !== x.artT) return y.artT - x.artT;
    if (y.versions !== x.versions) return y.versions - x.versions;
    if (x.pos !== y.pos) return x.pos - y.pos;
    const ka = contentKeyOf(x.item);
    const kb = contentKeyOf(y.item);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const truncated = Math.max(0, matched - cap);
  const kept = rows.slice(0, cap);

  return {
    items: kept.map((r) => r.item),
    stats: { raw: candidates.length, merged, truncated },
  };
}

/* =====================================================================
 * 播放失败「跨源现搜兜底」（引擎候选来源 B）专用的同曲评分。
 *
 * 场景：队列内没有可自动接续的同曲版本后，播放端拿原曲去其它可搜可播的
 * 搜索源现搜第一页，再逐条与本曲评分——足够“像”且高置信的自动接续尝试，
 * 中等置信的进人工选版面板。只依赖内容字段，纯函数可单测。
 *
 * 权重对齐 musicEngine.md §6（阶段一，无时长维度）：
 *   歌手 40 + 歌名 30 + 专辑 10 = 满分 80，按比例归一到 0-100；
 *   歌手无交集 → 判为不同歌曲直接出局；专辑都给但不同 → 不高置信（人工）。
 * 自动阈值 ≥75；60-74 或专辑冲突进人工候选；<60 丢弃。
 * ===================================================================== */

/** 音源搜索结果中常见、不影响“同曲”判定的版本/渠道后缀词（歌名尾部去除） */
const VERSION_TAIL_WORDS = [
  "live",
  "现场版",
  "演唱会版",
  "现场",
  "伴奏版",
  "伴奏",
  "纯音乐版",
  "纯音乐",
  "翻唱版",
  "翻唱",
  "翻奏",
  "cover",
  "remix",
  "demo",
  "acoustic",
  "piano",
  "guitar",
  "钢琴版",
  "吉他版",
  "电音版",
  "电音",
  "instrumental",
  "karaoke",
  "mv",
  "official",
];

/** 去掉括号备注、feat 段落，并剥掉只出现在歌名末尾的版本后缀（保留主标题空格）。 */
export function stripVersionSuffix(name: string): string {
  let t = String(name || "")
    .replace(/[\[【（(].*?[\]】）)]/g, " ")
    .replace(/\s+(?:feat\.?|ft\.?)\b.*$/i, "")
    .trim();
  for (let i = 0; i < 5; i += 1) {
    const next = t.replace(
      new RegExp(`[\\s·,，、_\\-—/~:：]+(?:${VERSION_TAIL_WORDS.join("|")})\\s*$`, "i"),
      ""
    );
    if (next === t) break;
    t = next.trim();
  }
  // 中文歌名直接接英文版本词（如「晴天live」）：CJK 与拉丁字母交界即词界
  const cjkTail = t.match(
    new RegExp(`^(.*[\\u3400-\\u9fff])\\s*(?:${VERSION_TAIL_WORDS.join("|")})$`, "i")
  );
  if (cjkTail) t = cjkTail[1].trim();
  return t;
}

/** 同曲评分用的标题键：清洗（小写/去分隔）后的主标题。 */
export function matchTitleKey(name: string): string {
  return cleanMusicText(stripVersionSuffix(name));
}

/** 跨源现搜的搜索词：保留主标题的空格与大小写（搜索友好），只去掉版本痕迹。 */
export function crossSearchKeyword(it: Pick<SearchItem, "name">): string {
  const t = stripVersionSuffix(it.name);
  // 极度精简（只剩版本词之类）则退回原题，避免搜出无关内容
  return t.length >= 2 ? t : String(it.name || "").trim();
}

function artistNames(artist?: string[]): string[] {
  return (artist || []).map(cleanMusicText).filter(Boolean);
}

function charOverlapRatio(na: string, nb: string): number {
  const sa = new Set(na);
  const sb = new Set(nb);
  let common = 0;
  for (const ch of sa) if (sb.has(ch)) common += 1;
  return common / Math.max(sa.size, sb.size, 1);
}

/**
 * 歌名相似分（0-30）：完全一致 30；包含关系只给 18（可能是不同歌的同名前缀/拼接题，
 * 仅靠歌名不足以高置信）；否则按公共字符占比给分。
 */
function nameScore(na: string, nb: string): number {
  if (!na || !nb) return 0;
  if (na === nb) return 30;
  if (na.includes(nb) || nb.includes(na)) return 18;
  return Math.round(30 * charOverlapRatio(na, nb));
}

/** 歌手集合相似分（0-40）：任一名字完全一致 40；否则存在包含关系给 32。 */
function artistScore(aa: string[], ab: string[]): number {
  if (!aa.length || !ab.length) return 0;
  for (const x of aa) {
    if (ab.includes(x)) return 40;
  }
  for (const x of aa) {
    for (const y of ab) {
      if (x.includes(y) || y.includes(x)) return 32;
    }
  }
  return 0;
}

export interface SongMatchScore {
  /** 同曲置信分 0-100（歌名/歌手/专辑文本阶段）。 */
  score: number;
  /** 高分且专辑一致 → 可自动接续尝试。 */
  auto: boolean;
  /** 双方专辑都给且不同（现场/翻唱/其它录制等，需人工确认）。 */
  albumDiff: boolean;
}

/**
 * 目标曲 vs 单条候选的同曲评分。
 * 返回 null 表示不构成候选（歌名差异过大或歌手无交集）；否则给出 0-100 置信分。
 * @param target 失败的原曲（内容字段来自该 source 的搜索结果）
 * @param candidate 其它源现搜回来的候选行
 */
export function scoreSongMatch(
  target: Pick<SearchItem, "name" | "artist" | "album">,
  candidate: Pick<SearchItem, "name" | "artist" | "album">
): SongMatchScore | null {
  const na = matchTitleKey(target.name);
  const nb = matchTitleKey(candidate.name);
  if (!na || !nb) return null;
  const aa = artistNames(target.artist);
  const ab = artistNames(candidate.artist);

  const name = nameScore(na, nb);
  if (na !== nb && !(na.includes(nb) || nb.includes(na)) && charOverlapRatio(na, nb) < 0.5) {
    return null; // 标题对不上，判不同歌
  }
  if (name <= 0) return null;

  const singer = artistScore(aa, ab);
  if (aa.length && ab.length && singer <= 0) return null; // 歌手无交集 → 串歌风险

  const albA = cleanMusicText(target.album);
  const albB = cleanMusicText(candidate.album);
  const albumDiff = Boolean(albA && albB && albA !== albB);
  const album = !albumDiff && albA === albB && albA ? 10 : 0;

  const earned = name + singer + album; // 满分 80
  const score = Math.round((earned / 80) * 100);
  const auto = score >= 75 && !albumDiff;
  return { score, auto, albumDiff };
}

export interface RankedSongCandidate {
  item: SearchItem;
  score: number;
  auto: boolean;
  albumDiff: boolean;
}

/**
 * 对跨源现搜到的所有候选行统一评分、去重、排序。
 * 过滤 <60 或判非同名者；自动高置信优先、再按置信分降序；默认最多留 8 条。
 */
export function rankSongMatchCandidates(
  target: Pick<SearchItem, "name" | "artist" | "album">,
  candidates: SearchItem[],
  opts: { cap?: number } = {}
): RankedSongCandidate[] {
  const cap = opts.cap ?? 8;
  const map = new Map<string, RankedSongCandidate>();
  for (const it of candidates) {
    if (!it || !it.source) continue;
    const key = musicKey(it);
    const scored = scoreSongMatch(target, it);
    if (!scored || scored.score < 60) continue;
    const prev = map.get(key);
    if (!prev || (scored.score > prev.score) || (!prev.auto && scored.auto)) {
      map.set(key, { item: it, ...scored });
    }
  }
  const out = Array.from(map.values());
  out.sort((a, b) => {
    if (a.auto !== b.auto) return Number(b.auto) - Number(a.auto);
    if (a.score !== b.score) return b.score - a.score;
    return musicKey(a.item).localeCompare(musicKey(b.item));
  });
  return out.slice(0, cap);
}
