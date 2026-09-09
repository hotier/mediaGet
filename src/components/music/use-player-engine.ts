"use client";

/**
 * 播放引擎 —— 「播放会话编排 + HTML5 Audio 传输层」的 React hook。
 *
 * 解耦目标（与 music-client 的「源通道引擎」配套）：
 * - UI（MusicExplorer / PlayerBar / LyricPage / NowPlayingPanel / PlaylistPanel…）只消费本 hook
 *   暴露的「播放会话快照（picked/playing/direct/br/currentTime/…）+ 播放命令（playTrack /
 *   togglePlay / seek / switchQuality / playPrev / playNext）」，不再自己持有 <audio>、
 *   拼直链、处理自动播放解锁 / 直链就绪续播 / 音质热切换等策略；
 * - 传输层原语集中在下方 transport 区块：audioProps（<audio {...audioProps} />）、togglePlay、
 *   seek、unlockAutoplay 与 timeupdate/ended 等事件。
 *
 * 未来接入新的播放引擎（HLS 流、iframe 播放器、不同解析后端…）：
 * 保持「快照 + 命令」这套界面不变，替换/扩展 transport 区块的实现即可，UI 层无需改动；
 * 需要多引擎并存时可把本文件按同一界面再复制/实现一版，并在上层注册选择。
 *
 * 迁移说明：以下逻辑自 MusicExplorer 原实现逐行搬移（含 autoplay 解锁、直连失败回退、
 * 音质热切换的「旧档不打断 + 就绪后 seek 续播」等细节），不改变任何可观察行为。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type SyntheticEvent,
} from "react";
import { BR_DEFAULT, BR_LABEL } from "@/components/music/types";
import {
  crossSearchPlayableSourceKeys,
  fetchLxCatalog,
  hasLxUrlFallbackFor,
  requestPlayDirect,
  searchAcrossSources,
  SELF_ONLY_ENGINE_KEYS,
  type DirectData,
  type SearchItem,
} from "@/lib/music-client";
import {
  cleanMusicText,
  crossSearchKeyword,
  musicKey,
  rankSongMatchCandidates,
} from "@/lib/music-match";
/** 播放引擎的“队列与通道上下文”。list/source 变化时 hook 随之刷新，无需重新创建引擎 */
export interface UsePlayerEngineOptions {
  /** 当前播放队列（搜索结果 / 解析单曲列表）；null = 队列已清空 */
  list: SearchItem[] | null;
  /** 队列之后是否还有更多页可加载（自动续播到页尾时翻页用） */
  hasMore: boolean;
  /** 当前搜索源 chip key（作为请求直链时的默认通道 source 回退） */
  source: string;
  /** 追加加载下一页到 list；resolve 后引擎用最新列表自动取第一首续播 */
  fetchMorePage: () => Promise<void>;
  /** 轻提示（音质切换成功 / 失败、直链失败等） */
  notify: (kind: "ok" | "err", text: string) => void;
}

/** 绑定到 <audio> 元素的受控属性集（ref / src / 传输事件）。JSX 里直接 <audio {...audioProps} /> */
export interface AudioElementProps {
  ref: (el: HTMLAudioElement | null) => void;
  src?: string;
  preload: "metadata";
  onPlay: () => void;
  onPause: () => void;
  onEnded: () => void;
  onError: () => void;
  onTimeUpdate: (e: SyntheticEvent<HTMLAudioElement>) => void;
  onLoadedMetadata: (e: SyntheticEvent<HTMLAudioElement>) => void;
  onDurationChange: (e: SyntheticEvent<HTMLAudioElement>) => void;
}

/** 播放失败发生的阶段：resolve = 取直链失败；play = 直链已就绪但 <audio> 媒体层报错（防盗链/解码/失效） */
export type PlayFailStage = "resolve" | "play" | null;

/** 换源候选来源：list = 当前播放队列内的近似条目（零额外请求成本）；multi-search = 跨源现搜兜底 */
export type AltProvenance = "list" | "multi-search";

/** 播放失败后的“同歌其他版本”候选 */
export interface AltCandidate {
  item: SearchItem;
  /**
   * true = 高置信可自动尝试；false = 仅歌手/歌名近似（专辑不一致或置信分不足），
   * 只能交人工确认。
   */
  auto: boolean;
  /** 候选来源（A=队列内；B=跨源现搜） */
  provenance: AltProvenance;
  /** multi-search 候选的同曲置信分（0-100）；list 候选无此字段 */
  score?: number;
  /** 专辑都给但不同（现场 / 翻唱 / 其它录制），用于人工面板提示 */
  albumDiff?: boolean;
}

/**
 * 单次点歌单轮允许的自动换源尝试上限（直链请求总量，来源 A 队列候选 + 来源 B
 * 跨源现搜候选各尝试一次都计入，防失控；对齐 musicEngine.md：单轮 ≤4 次直链请求）。
 */
const MAX_AUTO_ALT_ATTEMPTS = 4;

/** 队列内候选（A）与跨源现搜候选（B）合并：按 (source,id) 去重、自动优先、高分优先 */
function mergeAltCandidates(
  queue: AltCandidate[],
  cross: AltCandidate[]
): AltCandidate[] {
  const map = new Map<string, AltCandidate>();
  const put = (c: AltCandidate) => {
    const k = musicKey(c.item);
    const prev = map.get(k);
    if (
      !prev ||
      (Number(c.auto) > Number(prev.auto)) ||
      (prev.auto === c.auto && (c.score ?? -1) > (prev.score ?? -1))
    ) {
      map.set(k, c);
    }
  };
  queue.forEach(put);
  cross.forEach(put);
  const out = Array.from(map.values());
  out.sort((a, b) => {
    if (a.auto !== b.auto) return Number(b.auto) - Number(a.auto);
    if ((a.score ?? -1) !== (b.score ?? -1)) return (b.score ?? -1) - (a.score ?? -1);
    return musicKey(a.item).localeCompare(musicKey(b.item));
  });
  return out;
}
/** 音质切换成功后该窗口内的 <audio> 媒体报错视为“新档不可播”，不触发歌曲级整曲换源（ms） */
const QUALITY_SWITCH_MEDIA_WINDOW_MS = 5000;

/**
 * 从当前播放队列里挑选“与目标同歌”的候选（来源 A）。
 * 判定：清洗后歌名一致 + 歌手交集非空；专辑一致或缺失才算高置信 auto，
 * 专辑不一致的降级为人工候选（可能是现场版 / 不同录音版本）。
 */
function pickQueueAlternatives(
  list: SearchItem[] | null,
  item: SearchItem
): AltCandidate[] {
  if (!list || list.length === 0) return [];
  const name = cleanMusicText(item.name);
  if (!name) return [];
  const arts = new Set((item.artist || []).map(cleanMusicText).filter(Boolean));
  const album = cleanMusicText(item.album);
  const selfKey = musicKey(item);
  const out: AltCandidate[] = [];
  for (const it of list) {
    if (musicKey(it) === selfKey) continue;
    if (cleanMusicText(it.name) !== name) continue;
    const itArts = (it.artist || []).map(cleanMusicText).filter(Boolean);
    if (![...arts].some((a) => itArts.includes(a))) continue;
    const itAlbum = cleanMusicText(it.album);
    const sameAlbum = !album || !itAlbum || album === itAlbum;
    out.push({ item: it, auto: sameAlbum, provenance: "list" });
  }
  // auto 优先（可能直接续播），人工候选排后
  out.sort((a, b) => Number(b.auto) - Number(a.auto));
  return out;
}

/** 判断 <audio> 当前播放源与已生效直链是否为同一资源（宽容比较：忽略 hash 与结尾斜杠差异） */
function isSameMediaSrc(current: string, directUrl: string): boolean {
  if (!current || !directUrl) return false;
  const trim = (s: string) => s.split("#")[0].replace(/\/+$/, "");
  const a = trim(current);
  const b = trim(directUrl);
  return a === b || a.endsWith(b) || b.endsWith(a);
}

export function usePlayerEngine(options: UsePlayerEngineOptions) {
  const { list, hasMore, source, fetchMorePage, notify } = options;

  // —— 播放会话状态（与渲染快照一一对应）——
  const [currentIndex, setCurrentIndex] = useState<number | null>(null);
  const [picked, setPicked] = useState<SearchItem | null>(null);
  const [br, setBr] = useState<string>(BR_DEFAULT);
  const [direct, setDirect] = useState<DirectData | null>(null);
  const [fetching, setFetching] = useState(false);
  const [playing, setPlaying] = useState(false);
  /** 直链获取失败时的可见错误（避免播放按钮无提示地禁用） */
  const [playError, setPlayError] = useState("");
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  /** 音量（0~1）：默认 50%，本地缓存恢复放到挂载 effect（见下）。
   *  ⚠️ 不能在 useState 初始化里读 localStorage：SSR 首帧没有 localStorage 会落到默认 0.5（50%），
   *  而客户端水合首次渲染会读到缓存（如 0.35）→ 两端首帧不一致触发 hydration mismatch
   *  （react.dev/link/hydration-mismatch）。改为 effect 在挂载后恢复，水合首帧恒为 50%。 */
  const [volume, setVolume] = useState(0.5);
  /** 挂载后从本地缓存恢复上次音量（无缓存 / 隐私模式等不可用时保持默认 50%） */
  useEffect(() => {
    try {
      const raw = localStorage.getItem("mp-player-volume");
      if (raw !== null) {
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0 && n <= 1) setVolume(n);
      }
    } catch {
      // localStorage 不可用（隐私模式等）时忽略，保持默认
    }
  }, []);
  const [muted, setMuted] = useState(false);
  const [loop, setLoop] = useState(false);
  /** 拖动进度条期间暂停 timeupdate 同步（避免拖拽被回跳打断） */
  const [seeking, setSeeking] = useState(false);

  /** 最近一次播放失败发生的阶段（resolve = 取直链失败；play = 直链就绪但 <audio> 报错） */
  const [failStage, setFailStage] = useState<PlayFailStage>(null);
  /** 当前曲目的“同歌其他版本”候选快照（来源 A：队列内近似 / 来源 B：跨源现搜）。
   * UI 可在失败后据此做人工选版 */
  const [alternatives, setAlternatives] = useState<AltCandidate[]>([]);
  /** 正在自动尝试同曲候选（供 UI 展示“尝试中”，也是并发防护的信号） */
  const [autoTrying, setAutoTrying] = useState(false);
  /** 自动换源阶段的动态文案（如“正在跨音源现搜”），空串时 UI 用默认文案 */
  const [altNote, setAltNote] = useState("");

  // —— transport（HTML5 Audio 播放引擎）——
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const directAbortRef = useRef<AbortController | null>(null);
  /** 音质热切换时旧直链的播放位置（秒），新源就绪后从该处续播 */
  const resumeAtRef = useRef(0);
  /** 用户本次手势是否期望自动播放（点歌/切音质时置位，直链就绪后消费） */
  const autoplayRef = useRef(false);
  /** 跟随 muted 状态，供异步播放回调读取最新静音设置 */
  const mutedRef = useRef(muted);
  /** 当前已生效直链 URL（供 <audio> error 判定该错误是否属于“当前播放资源”） */
  const resourceUrlRef = useRef<string | null>(null);
  /** 本次点歌的自动换源轨迹：已尝试的 (source,id) 与已尝试次数（有界防失控） */
  const altStateRef = useRef<{ triedKeys: Set<string>; count: number }>({
    triedKeys: new Set(),
    count: 0,
  });
  /** 自动换源尝试是否进行中（防 resolve 失败与 <audio> error 并发触发两路） */
  const altInFlightRef = useRef(false);
  /** 最近一次音质热切换成功设置直链的时刻；其窗口内的媒体报错不触发歌曲级换源（可能只是新档不可播） */
  const qualitySwitchAtRef = useRef(0);
  /** 自动换源轮次令牌：手动切歌时自增，使旧轮次的收尾清理失效，避免状态互相覆盖 */
  const altTokenRef = useRef(0);
  /** 跨源现搜（来源 B）的 AbortController：手动切歌/重置时中止在途搜索，省请求防陈旧结果 */
  const crossAbortRef = useRef<AbortController | null>(null);

  /** 稳定 ref 回调：挂载/卸载 <audio> 元素（避免每次渲染更换引用导致元素短暂置空） */
  const setAudioEl = useCallback((el: HTMLAudioElement | null) => {
    audioRef.current = el;
  }, []);

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  useEffect(() => {
    return () => {
      directAbortRef.current?.abort();
      crossAbortRef.current?.abort();
    };
  }, []);

  /** 清空播放会话（切源 / 新搜索 / 新解析前调用），由上层在合适时机联动清空封面/歌词 */
  const resetSession = () => {
    directAbortRef.current?.abort();
    crossAbortRef.current?.abort();
    setPicked(null);
    setCurrentIndex(null);
    setDirect(null);
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setPlayError("");
    setFailStage(null);
    setAlternatives([]);
    altStateRef.current = { triedKeys: new Set(), count: 0 };
    altInFlightRef.current = false;
    qualitySwitchAtRef.current = 0;
    setAutoTrying(false);
    setAltNote("");
  };

  // 当列表切换时，若当前曲目仍在新列表中则同步索引，否则清空索引
  useEffect(() => {
    if (!picked || !list) {
      setCurrentIndex(null);
      return;
    }
    const idx = list.findIndex(
      (it) => it.source === picked.source && it.id === picked.id
    );
    setCurrentIndex(idx >= 0 ? idx : null);
  }, [list, picked]);

  // 直链变化：复位播放状态；若是本次点歌/换音质触发的自动播放，则等资源就绪后播放。
  // 音质热切换（播放中切档）时旧直链不打断，等新源可播后从这里 seek 回旧位置续播。
  useEffect(() => {
    resourceUrlRef.current = direct?.url ?? null;
    if (!direct?.url) {
      setPlaying(false);
      return;
    }
    const audio = audioRef.current;
    if (!audio) return;
    const resumeAt = resumeAtRef.current;
    resumeAtRef.current = 0;
    const startPlay = () => {
      // 新源可播后恢复旧直链的播放位置
      if (resumeAt > 0) {
        try {
          const cap = Number.isFinite(audio.duration) ? audio.duration : Infinity;
          audio.currentTime = Math.min(resumeAt, cap);
        } catch {
          /* 个别源暂不可 seek，忽略 */
        }
      }
      if (!autoplayRef.current) return;
      autoplayRef.current = false;
      const go = () => {
        audio.muted = mutedRef.current;
        const p = audio.play();
        if (p && typeof p.catch === "function") {
          p.catch(() => {
            // 自动播放策略拦截：静音起播成功后把音量/静音还原为用户设置
            audio.muted = true;
            audio
              .play()
              .then(() => {
                audio.muted = mutedRef.current;
              })
              .catch(() => setPlaying(false));
          });
        }
      };
      go();
    };
    const timer = setTimeout(() => {
      if (audio.readyState >= 2) startPlay();
      else audio.addEventListener("canplay", startPlay, { once: true });
    }, 0);
    return () => clearTimeout(timer);
  }, [direct?.url]);

  // 音频音量 / 静音 / 循环同步到 transport
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = muted ? 0 : volume;
    audio.muted = muted;
    audio.loop = loop;
  }, [volume, muted, loop]);

  // 音量本地缓存：用户每次调整后写入，刷新 / 下次进入时恢复上次的音量
  useEffect(() => {
    try {
      localStorage.setItem("mp-player-volume", String(volume));
    } catch {
      // 隐私模式等写入失败时静默降级，不影响播放
    }
  }, [volume]);

  /**
   * 在当前用户手势内“静音试播”一次以解锁浏览器自动播放策略，
   * 这样直链异步就绪后的 play() 不会被拦截。静音会保持到正式播放前按用户设置恢复。
   */
  const unlockAutoplay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    try {
      // 立即停掉上一首，避免切换串音
      if (!audio.paused) audio.pause();
      audio.muted = true;
      const p = audio.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      /* 元素暂无资源时 play 可能同步抛错，忽略 */
    }
  };

  /**
   * 跨源现搜兜底（候选来源 B）：当前队列内已无可自动接续的版本时，拿失败原曲
   * 去「可搜又可播」的其它搜索源现搜第一页，再按同曲评分收敛出高置信候选
   * （自动 ≥75 分 + 专辑一致；60-74 或专辑冲突降为人工候选）。一次失败至多跑一轮。
   * 任一环节异常（目录不可用 / 搜索失败 / 全部取消）都静默回退为空，不阻塞闭环。
   */
  const suggestCrossCandidates = async (
    target: SearchItem,
    token: number
  ): Promise<AltCandidate[]> => {
    try {
      await fetchLxCatalog(); // 尽力预热 lx 目录；失败则只用内置源
    } catch {
      /* 目录不可用时按“无扩展源”处理 */
    }
    if (altTokenRef.current !== token) return [];
    const keys = crossSearchPlayableSourceKeys(target.source || "");
    if (!keys.length) return [];
    const keyword = crossSearchKeyword(target);
    if (!keyword) return [];
    const controller = new AbortController();
    crossAbortRef.current?.abort();
    crossAbortRef.current = controller;
    const stale = () =>
      controller.signal.aborted || altTokenRef.current !== token;
    try {
      const results = await searchAcrossSources(
        keys,
        keyword,
        controller.signal
      );
      if (stale()) return [];
      const rows: SearchItem[] = [];
      for (const r of results) {
        if (r.ok && Array.isArray(r.items)) rows.push(...r.items);
      }
      return rankSongMatchCandidates(target, rows).map((c) => ({
        item: c.item,
        auto: c.auto,
        provenance: "multi-search",
        score: c.score,
        albumDiff: c.albumDiff,
      }));
    } catch {
      return []; // 现搜异常不阻断：仍保留队列内人工候选交 UI
    } finally {
      if (crossAbortRef.current === controller) crossAbortRef.current = null;
    }
  };

  /** 点歌：请求直链 → 就绪后自动播放（含解锁自动播放策略）。手动点歌开启一轮新的换源轨迹 */
  const playTrack = async (item: SearchItem, index: number) => {
    const token = altTokenRef.current + 1;
    altTokenRef.current = token;
    altInFlightRef.current = false;
    crossAbortRef.current?.abort(); // 新点歌：中止任何在途的跨源现搜
    // 切换音质时间戳不跨歌复用：新歌的媒体错误应视为歌曲级失败
    qualitySwitchAtRef.current = 0;
    // 原曲本身记入已尝试，自动换源兜底不会再绕回当前已失败版本
    altStateRef.current = {
      triedKeys: new Set([musicKey(item)]),
      count: 0,
    };
    setFailStage(null);
    setAlternatives([]);
    setAutoTrying(false);
    setAltNote("");
    const started = await attemptPlay(item, index);
    if (started) return;
    // 仅 migu（SELF_ONLY_ENGINE_KEYS，无内置直链引擎）的直链失败是确定性的：除非已配置对应
    // lx 音源兜底（hasLxUrlFallbackFor），否则队列内同歌候选必然同为该源，自动换源只会空转
    // 徒劳，直接展示引擎提示。kugou 已内置官方试听直链，失败属业务性（VIP/下架/网络），
    // 应正常进入下方跨源自动换源闭环（同曲其它可播音源兜底）。
    if (
      SELF_ONLY_ENGINE_KEYS.has(item.source || source) &&
      !hasLxUrlFallbackFor(item.source || source)
    )
      return;
    // 主曲直链获取失败 → 同轮内推进自动换源闭环
    setAutoTrying(true);
    try {
      await runAutoFallback(item, token);
    } finally {
      if (altTokenRef.current === token) setAutoTrying(false);
    }
  };

  /**
   * 自动换源闭环（来源 A 队列内候选 → 无自动可用后再跑一轮来源 B 跨源现搜）。
   * 逐个尝试高置信候选（A 优先，B 随后），成功即停；有界（单轮直链请求 ≤
   * MAX_AUTO_ALT_ATTEMPTS + 已尝试去重 + 现搜一轮封顶）；token 失效（用户手动
   * 切歌/重置）即中止。收尾仍有未尝试候选时经 alternatives 暴露给人工选版面板。
   */
  const runAutoFallback = async (
    failedItem: SearchItem,
    token: number
  ): Promise<void> => {
    if (altInFlightRef.current) return;
    altInFlightRef.current = true;
    let crossTried = false;
    let crossCands: AltCandidate[] = [];
    try {
      while (altTokenRef.current === token) {
        const st = altStateRef.current;
        if (st.count >= MAX_AUTO_ALT_ATTEMPTS || !list) return;
        // 队列内候选只保留「本轮尚未自动尝试过」的版本：自动尝试已失败的版本
        // 不在这轮里重复给用户，避免人工选版面板把刚自动失败过的条目又摆出来
        const queueCands = pickQueueAlternatives(list, failedItem).filter(
          (c) => !st.triedKeys.has(musicKey(c.item))
        );
        // 队列内已无自动可试 → 去其它可搜可播音源现搜同名歌曲（仅一轮）
        if (!queueCands.some((c) => c.auto) && !crossTried) {
          crossTried = true;
          setAltNote("当前列表没有其它可播版本，正在跨音源现搜同名歌曲…");
          const cross = await suggestCrossCandidates(failedItem, token);
          if (altTokenRef.current !== token) return;
          setAltNote("");
          crossCands = cross;
        }
        const pool = mergeAltCandidates(
          queueCands,
          crossCands.filter((c) => !st.triedKeys.has(musicKey(c.item)))
        );
        if (pool.length) setAlternatives(pool);
        const next = pool.find((c) => c.auto);
        if (!next) {
          // 全部自动候选已尝试尽且仍无结果 → 提示最终结果；仍有未尝试的
          // 人工候选则经 alternatives 暴露，UI 弹面板人工选版
          if (crossTried && st.count > 0) {
            setPlayError(
              "已自动尝试同曲其它版本并跨音源现搜，仍无可播放结果；可换一个音源重新搜索"
            );
          }
          return;
        }
        st.triedKeys.add(musicKey(next.item));
        st.count += 1;
        const idx = list.findIndex((it) => musicKey(it) === musicKey(next.item));
        const started = await attemptPlay(next.item, idx); // idx=-1 表示不在当前队列
        if (started) return; // 换源成功，结束本轮
        // 该候选也失败：回到循环头继续尝试剩余自动候选（若已触发现搜则不再重复现搜）
      }
    } finally {
      if (altTokenRef.current === token) {
        altInFlightRef.current = false;
        setAutoTrying(false);
        setAltNote("");
      }
    }
  };

  /** 单次播放尝试：请求直链并就绪。resolve 失败时把错误写入快照并返回 false（不做换源决策） */
  const attemptPlay = async (
    item: SearchItem,
    index: number
  ): Promise<boolean> => {
    setPicked(item);
    setCurrentIndex(index);
    setDirect(null);
    setFetching(true);
    setPlayError("");
    autoplayRef.current = false;

    directAbortRef.current?.abort();
    const controller = new AbortController();
    directAbortRef.current = controller;

    // 点歌发生在用户手势内，先解锁自动播放（自动换源不在手势内，unlock 为空操作也无害）
    unlockAutoplay();

    try {
      const data = await requestPlayDirect(
        item.source || source,
        item,
        br,
        controller.signal
      );
      if (controller.signal.aborted) return false;
      setDirect(data);
      autoplayRef.current = true; // 直链就绪后自动续播（含自动换源成功的情形）
      setFailStage(null); // 播放已就绪，清除此前（含自动换源候选）记录的失败阶段
      setAlternatives([]); // 已可播放：本轮候选快照作废（避免陈旧候选在后续质量档失败时误弹人工面板）
      return true;
    } catch (err) {
      if (controller.signal.aborted) return false;
      const audio = audioRef.current;
      if (audio) {
        audio.pause();
        audio.muted = mutedRef.current;
      }
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "未获取到可播放的直链，可能受版权或会员限制，试试其他歌曲或切换音质";
      setPlayError(msg);
      setFailStage("resolve");
      return false;
    } finally {
      if (directAbortRef.current === controller) {
        setFetching(false);
        directAbortRef.current = null;
      }
    }
  };

  /**
   * <audio> 元素媒体层报错（直链已就绪但播放失败：防盗链/解码/CORS 等）：
   * 归为 play 阶段失败并入换源闭环。MEDIA_ERR_ABORTED（切歌/切音质造成的资源中止）不处理。
   */
  const handleMediaError = () => {
    // 取直链/自动换源进行中：迟到或旧资源的媒体报错不处理，避免覆盖当前流程状态
    if (fetching || altInFlightRef.current) return;
    const audio = audioRef.current;
    if (!audio) return;
    const code = audio.error?.code;
    if (code == null || code === 1) return; // MEDIA_ERR_ABORTED 忽略
    const item = picked;
    if (!item) return;
    // 仅当错误属于“当前生效资源”时才处理，避免旧资源迟到的 error 干扰新播放
    const src = audio.currentSrc || audio.src || "";
    const cur = resourceUrlRef.current;
    if (src && cur && !isSameMediaSrc(src, cur)) return;
    setPlaying(false);
    // 切档后窗口内媒体报错 = 该音质源不可播（非歌曲级失败），提示用户换档而不整曲换源
    if (Date.now() - qualitySwitchAtRef.current < QUALITY_SWITCH_MEDIA_WINDOW_MS) {
      setPlayError("该音质直链不可播放，请尝试切换其他音质");
      setFailStage("play");
      return;
    }
    setPlayError("播放失败：音频直链可能已失效或该源限制播放");
    setFailStage("play");
    setAutoTrying(true);
    void runAutoFallback(item, altTokenRef.current);
  };

  const playPrev = () => {
    if (!list || currentIndex == null || currentIndex <= 0) return;
    playTrack(list[currentIndex - 1], currentIndex - 1);
  };

  const playNext = () => {
    if (!list || currentIndex == null) return;
    if (currentIndex < list.length - 1) {
      playTrack(list[currentIndex + 1], currentIndex + 1);
      return;
    }
    if (hasMore) {
      fetchMorePage().then(() => {
        // 切页后列表会刷新；如果正好在上一页最后一首，播放新页第一首
        if (list && list.length > 0) {
          playTrack(list[0], 0);
        }
      });
    }
  };

  const handleEnded = () => {
    if (loop) {
      audioRef.current?.play().catch(() => setPlaying(false));
    } else {
      playNext();
    }
  };

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      audio.play().catch(() => setPlaying(false));
    } else {
      audio.pause();
    }
  };

  const seek = (value: number) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const t = Math.min(duration, Math.max(0, value));
    audio.currentTime = t;
    setCurrentTime(t);
  };

  /**
   * 切换音质：播放中切档不打断当前音频（旧直链继续出声），后台取到新直链后
   * 在 effect 里无缝换源并从旧位置续播；暂停中切档则保持暂停。失败自动回滚档位。
   */
  const switchQuality = async (nextBr: string) => {
    if (!picked) return;
    // 目标即当前档且当前直链有效时无需重复取流
    if (nextBr === br && direct) return;
    const audio = audioRef.current;
    const wasLive = !!audio && !audio.paused;
    const prevBr = br;
    const hadStream = !!direct?.url;

    setBr(nextBr);
    setFetching(true);
    setPlayError("");

    directAbortRef.current?.abort();
    const controller = new AbortController();
    directAbortRef.current = controller;

    try {
      const data = await requestPlayDirect(
        picked.source || source,
        picked,
        nextBr,
        controller.signal
      );
      if (controller.signal.aborted) return;
      // 请求期间用户可能暂停/继续/拖进度，以完成瞬间的真实状态为准；
      // 暂停中也保留当前进度，新源加载后停留在同一位置
      const stillLive = !!audio && !audio.paused;
      const resumeAt =
        audio && Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
      resumeAtRef.current = resumeAt;
      // 播放中 → 新源就绪后自动续播；已暂停 → 静默换成新档直链，不打扰
      autoplayRef.current = wasLive && stillLive;
      // 记录切档时刻：紧接其后的媒体报错视为“新档不可播”而非歌曲级失败，抑制整曲换源
      qualitySwitchAtRef.current = Date.now();
      setDirect(data);
      const okLabel =
        BR_LABEL[String(data.br)] ??
        BR_LABEL[nextBr] ??
        `${nextBr}kbps`;
      notify("ok", `已切换音质：${okLabel}`);
    } catch (err) {
      if (controller.signal.aborted) return;
      // 失败：回滚档位；若有旧直链则保留它继续播放
      setBr(prevBr);
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "未获取到该音质的直链，可能受版权或会员限制";
      if (hadStream) {
        notify("err", "音质切换失败，已保持原音质");
      } else {
        notify("err", `音质获取失败：${msg}`);
        setPlayError(msg);
      }
    } finally {
      if (directAbortRef.current === controller) {
        setFetching(false);
        directAbortRef.current = null;
      }
    }
  };

  // —— transport 事件（HTML5 Audio 播放引擎）→ 快照 ——
  const audioProps: AudioElementProps = {
    ref: setAudioEl,
    src: direct?.url,
    preload: "metadata",
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onEnded: handleEnded,
    onError: handleMediaError,
    onTimeUpdate: (e) => !seeking && setCurrentTime(e.currentTarget.currentTime),
    onLoadedMetadata: (e) => setDuration(e.currentTarget.duration || 0),
    onDurationChange: (e) => setDuration(e.currentTarget.duration || 0),
  };

  return {
    // 播放会话快照（UI 渲染依据）
    picked,
    currentIndex,
    br,
    direct,
    fetching,
    playing,
    playError,
    failStage,
    alternatives,
    autoTrying,
    altNote,
    currentTime,
    duration,
    volume,
    muted,
    loop,
    // 播放命令（引擎对外的统一操作面）
    playTrack,
    playPrev,
    playNext,
    togglePlay,
    seek,
    switchQuality,
    setVolume,
    setMuted,
    setLoop,
    setSeeking,
    resetSession,
    // transport 绑定（渲染 <audio {...audioProps} />）
    audioProps,
  };
}
