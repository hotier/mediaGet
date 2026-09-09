"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import {
  SEARCH_SOURCES,
  SELF_SEARCH_SOURCES,
  type SearchSourceKey,
} from "@/components/music/types";
import {
  coverBinUrl,
  fetchLxCatalog,
  requestLyric,
  requestPic,
  requestResolve,
  requestSearchPage,
  searchAcrossSources,
  sourceEngineKindFor,
  type LxSearchSource,
  type SearchItem,
} from "@/lib/music-client";
import { aggregateAndRankSearch } from "@/lib/music-match";
import {
  setMusicView,
  useMusicView,
} from "@/components/music/music-view-store";
import MusicViewSeg from "@/components/music/MusicViewSeg";
import { cn } from "@/lib/utils";
import {
  type CoverPalette,
  sampleCoverPalette,
} from "@/lib/cover-palette";
import { buildSearchChips } from "./source-meta";
import { useCopyFlash, writeClipboard } from "./use-copy-flash";
import {
  clearPlaylistSnapshot,
  isSameListHead,
  readPlaylistSnapshot,
  writePlaylistSnapshot,
} from "./playlist-cache";
import {
  getActiveLyricIndex,
  parseLrc,
  type LyricLine,
} from "./lyric-utils";
import PlayerBar from "./PlayerBar";
import LyricPage from "./LyricPage";
import TrackInfoDialog from "./TrackInfoDialog";
import AltSelectDialog from "./AltSelectDialog";
import SearchPanel from "./SearchPanel";
import PlaylistPanel from "./PlaylistPanel";
import NowPlayingPanel from "./NowPlayingPanel";
import { usePlayerEngine } from "./use-player-engine";

/** 「搜索渠道」偏好缓存 key（localStorage）：{ v, agg, source }。
 *  只在用户在搜索面板上做显式选择（点单平台 chip / 点聚合 chip / 提交关键词搜索）时写入——
 *  链接解析、旧列表快照恢复等「被动」状态变化不写缓存，避免搜索渠道被拖成并非用户所选的平台。
 *  无记录（真·首次进入）时默认聚合搜索；此后每次显式切换渠道都会记录，刷新 / 下次进入沿用。
 *  v 为结构版本：无版本号的旧记录（历史版本会把被动状态也写入缓存）视为无效，忽略并回默认聚合。 */
const SEARCH_CHANNEL_KEY = "mp-search-channel";
const SEARCH_CHANNEL_VERSION = 2;
/** 挂载初期即可用（不依赖 lx 目录）的源 key，用于校验缓存的 source 是否仍可恢复 */
const BUILTIN_SOURCE_KEYS = new Set(
  [...SEARCH_SOURCES, ...SELF_SEARCH_SOURCES].map((s) => s.key)
);
interface SearchChannelPref {
  agg: boolean;
  source: SearchSourceKey;
}
function readSearchChannelPref(): SearchChannelPref | null {
  try {
    const raw = localStorage.getItem(SEARCH_CHANNEL_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<SearchChannelPref> & { v?: number };
    if (d.v !== SEARCH_CHANNEL_VERSION || typeof d.agg !== "boolean") return null;
    const source =
      d.source && BUILTIN_SOURCE_KEYS.has(d.source)
        ? (d.source as SearchSourceKey)
        : SEARCH_SOURCES[0].key;
    return { agg: d.agg, source };
  } catch {
    // SSR 首屏 / 隐私模式等 localStorage 不可用时忽略，落到默认（聚合）
    return null;
  }
}

/** 记录搜索渠道偏好（仅显式交互入口调用，见 SEARCH_CHANNEL_KEY 注释） */
function writeSearchChannelPref(agg: boolean, source: SearchSourceKey): void {
  try {
    localStorage.setItem(
      SEARCH_CHANNEL_KEY,
      JSON.stringify({ v: SEARCH_CHANNEL_VERSION, agg, source })
    );
  } catch {
    // 隐私模式等写入失败时静默降级，不影响搜索
  }
}
/**
 * 音乐播放器页（YesPlayMusic / Apple Music 风格）。
 * 页面内不再自带顶部栏：品牌 logo/title 在全局顶部导航栏；
 * 「发现歌曲 / 播放列表」切换器（MusicViewSeg）放在本页内容区顶部
 * 功能区左上角，经 music-view-store 与主体联动，搜索提交后自动切到播放列表。
 * 页面主体 = 左侧内容区（功能区 + 发现歌曲搜索面板 / 播放列表结果）+ 右侧
 * 正在播放卡片（大封面 + 曲目信息 + 复制/下载）+ 底部播放控制条（含音质选择器）。
 * 歌词不常驻页面：点击底部播放栏的歌曲封面弹出整页歌词。
 * 数据侧只走 /api/music（search / url / pic / lyric）。
 */
export default function MusicExplorer() {
  // —— 视图（由内容区功能区左上角的「发现歌曲 / 播放列表」切换器驱动）与搜索 ——
  const tab = useMusicView();
  // 搜索渠道偏好（mp-search-channel）：首次进入（无缓存）默认聚合搜索；
  // 之后记住上次选的渠道——聚合 or 单平台（含单源模式下选中的平台，供退出聚合后回显）
  const [pref] = useState(readSearchChannelPref);
  const [source, setSource] = useState<SearchSourceKey>(
    pref?.source ?? SEARCH_SOURCES[0].key
  );
  /** 聚合搜索模式：一次并发搜索全部可用音源，跨源合并去重 + 相关度打分排序展示 */
  const [aggActive, setAggActive] = useState(pref?.agg ?? true);
  /** 部署侧启用 lx 音源脚本后动态加载的扩展搜索源（/api/music/lx?action=sources） */
  const [extSources, setExtSources] = useState<LxSearchSource[]>([]);
  const [keyword, setKeyword] = useState("");
  const [list, setList] = useState<SearchItem[] | null>(null);
  const [searchedKw, setSearchedKw] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");

  // —— 查找方式（发现歌曲页内二级切换）：关键词搜索 / 粘贴链接解析 ——
  const [mode, setMode] = useState<"search" | "resolve">("search");
  const [link, setLink] = useState("");
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState("");

  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [paging, setPaging] = useState(false);
  const [pageErr, setPageErr] = useState("");
  /** 缓存恢复的列表若属于 lx 扩展源：目录未加载完时先挂起，chip 可用后再回填 */
  const [restoreListSource, setRestoreListSource] = useState<string | null>(null);

  // —— 播放会话（编排 + HTML5 transport）收敛在 use-player-engine ——
  // 复制直链的「已复制」2s 临时态（详情弹窗内的复制歌曲信息各自维护，见 TrackInfoDialog）
  const { copied, setCopied, flash: flashCopied } = useCopyFlash();

  const [coverUrl, setCoverUrl] = useState("");
  const [coverLoading, setCoverLoading] = useState(false);
  const [coverFailed, setCoverFailed] = useState(false);
  const [palette, setPalette] = useState<CoverPalette | null>(null);
  /** 是否处于暗色主题（监听 <html> 的 .dark class），整页歌词取色据此切「深色变体」 */
  const [isDark, setIsDark] = useState(false);

  const [lyricLines, setLyricLines] = useState<LyricLine[] | null>(null);
  const [lyricRaw, setLyricRaw] = useState("");
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [lyricError, setLyricError] = useState("");
  /** 原始 LRC 转换成的可下载 Blob 地址（详情弹窗「歌词链接」行点击下载用） */
  const [lyricBlobUrl, setLyricBlobUrl] = useState("");


  /** 鼠标是否悬停在底部播放条进度条上（用于悬停显示当前播放时间） */
  const [progHover, setProgHover] = useState(false);
  /** 悬停气泡对准滑块圆心所需尺寸：进度条轨道宽 / 气泡文字块宽 */
  const [pbarW, setPbarW] = useState(0);
  const [tipBubbleW, setTipBubbleW] = useState(0);
  /** 整页歌词视图开关（点击底部播放栏的歌曲封面打开） */
  const [lyricOpen, setLyricOpen] = useState(false);
  /** 整页歌词「收起中」：先播放收起动画，结束才真正卸载页面 */
  const [lyricClosing, setLyricClosing] = useState(false);
  /** 歌曲详情弹窗：记录行内点击「详情」的歌曲及其在列表中的位置 */
  const [infoTrack, setInfoTrack] = useState<{ item: SearchItem; index: number } | null>(
    null
  );
  /** 轻提示（音质切换成功 / 失败等），2.5s 自动消失 */
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  /** 人工选版面板的「用户已手动关闭」记忆：同一次失败的曲目下不再自动弹出，
   *  到下一首（picked 变化）或重新换曲后自动复位 */
  const [altDismissed, setAltDismissed] = useState(false);
  /** 移动端视口（≤700px）判定：迷你播放条 /「正在播放」整页采用独立移动形态 */
  const [isMobile, setIsMobile] = useState(false);
  /** 移动端正在播放页当前视图：true = 唱片封面，false = 歌词（桌面端整页歌词不受影响） */
  const [npViewCover, setNpViewCover] = useState(true);

  const searchAbortRef = useRef<AbortController | null>(null);
  const resolveAbortRef = useRef<AbortController | null>(null);
  const coverAbortRef = useRef<AbortController | null>(null);
  const paletteAbortRef = useRef<AbortController | null>(null);
  const lyricAbortRef = useRef<AbortController | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 整页歌词收起动画结束后延迟卸载的定时器 */
  const lyricCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 底部迷你播放条 / 正在播放页根节点 ref（移动端手势用） */
  const miniPlayerRef = useRef<HTMLDivElement | null>(null);
  const lyricPageRef = useRef<HTMLDivElement | null>(null);
  /** 手势监听 effect 闭包中获取最新的展开/收起实现 */
  const openLyricRef = useRef<() => void>(() => {});
  const closeLyricRef = useRef<() => void>(() => {});
  const pbarRef = useRef<HTMLDivElement | null>(null);
  const tipBubbleRef = useRef<HTMLSpanElement | null>(null);
  const listTopRef = useRef<HTMLDivElement | null>(null);
  /** 加载下一页防重入标记（ref 保证 onScroll / 补屏两个触发源不会并发翻页） */
  const pagingRef = useRef(false);

  /** 全部可选的搜索源 chip（引擎注册表视图：内置 GD 源 + 动态 lx 扩展源），由 source-meta 统一构建 */
  const sourceChips = useMemo(() => buildSearchChips(extSources), [extSources]);

  const sourceMeta = sourceChips.find((s) => s.key === source) ?? sourceChips[0];

  /** 聚合「同曲合并」挑主展示副本的引擎偏好；排序本身由内容打分决定，不再掺引擎/平台顺序 */
  const aggEngineOrder = useMemo(() => {
    const order: Record<string, number> = {};
    sourceChips.forEach((c, i) => {
      order[c.key] = i;
    });
    return order;
  }, [sourceChips]);

  /** 直链能力排序（聚合跨源同曲取“主副本”时用）：GD/lx 引擎可播 > 自研源（kugou/migu 无内置直链，
   *  但配置 lx 音源兜底后点播可经音源脚本换链） */
  const playableKindRank = (item: SearchItem) => {
    const kind = sourceEngineKindFor(item.source || "");
    return kind === "self" ? 2 : kind === "lx" ? 1 : 0;
  };

  // 挂载时拉一次 lx 扩展源目录（成功后才出现扩展 chip；失败保持仅内置源，静默）。
  // 不传 AbortSignal：music-client 内共享 inflight，StrictMode 双挂载下首个 abort
  // 会导致共享请求被取消，故仅用 disposed 标志避免卸载后 setState。
  useEffect(() => {
    let disposed = false;
    fetchLxCatalog()
      .then((cat) => {
        if (disposed) return;
        setExtSources(cat.searchSources || []);
      })
      .catch(() => {
        /* 目录不可用（未配置 / 通道故障）不打扰用户 */
      });
    return () => {
      disposed = true;
    };
  }, []);

  // 缓存恢复的列表若来自 lx 扩展源：等目录就绪、chip 出现后回填 source，
  // 保证后续“继续加载更多”等请求仍走同一个扩展源通道
  useEffect(() => {
    if (!restoreListSource) return;
    if (extSources.some((s) => s.key === restoreListSource)) {
      setSource(restoreListSource as SearchSourceKey);
      setRestoreListSource(null);
    }
  }, [extSources, restoreListSource]);

  useEffect(() => {
    return () => {
      searchAbortRef.current?.abort();
      resolveAbortRef.current?.abort();
      coverAbortRef.current?.abort();
      lyricAbortRef.current?.abort();
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  // 播放列表本地缓存：仅当「上次在搜索面板上显式选过单平台渠道、且列表快照来源与该渠道一致」时，
  // 挂载才回放该列表（继续上次会话、刷新后列表不销毁）。其余情况视为一次新的搜索会话——首屏保持
  // 由渠道缓存决定的形态（无记录 / 上次聚合 → 聚合搜索），并把可能残留的旧单源快照清掉，避免上次
  // 浏览过的平台（如 QQ音乐）每次打开都把界面拖回它的单源列表。
  useEffect(() => {
    const snap = readPlaylistSnapshot();
    if (!snap || !snap.list.length) return;
    if (!pref || pref.agg || pref.source !== snap.source) {
      clearPlaylistSnapshot();
      return;
    }
    // pref 为单平台渠道且与快照来源一致：回填列表并停在播放列表视图（pref.agg 已保证
    // aggActive 初始为 false，无需重复写入；snap.source 必为内置源，chip 就绪）
    setSource(snap.source as SearchSourceKey);
    setKeyword(snap.kw);
    setSearchedKw(snap.kw);
    setList(snap.list);
    setPage(snap.page);
    setHasMore(snap.hasMore);
    setMusicView("playlist");
    // 该 effect 只在挂载执行一次：pref / 回填用到的 setState 为稳定引用，pref 取首帧值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 播放列表本地缓存：列表内容 / 页号变化即写快照（list 为 null 是新请求中或切源清空，
  // 暂不落盘；空结果 [] 则清除旧快照，避免下次刷新错误地恢复上一次的旧列表）
  useEffect(() => {
    if (list === null) return;
    // 缓存恢复的列表来源 chip 尚未回填（lx 目录加载中）时先不重写快照，
    // 等 extSources 就绪后 source 变化会触发本 effect 以正确来源落盘
    if (restoreListSource) return;
    // 聚合结果不落快照：列表来源混合（非单一 source），刷新后无从恢复；
    // 避免把聚合列表误存为“最近一次单源搜索”干扰后续恢复语义
    if (aggActive) return;
    if (list.length === 0) {
      clearPlaylistSnapshot();
      return;
    }
    writePlaylistSnapshot({ kw: searchedKw, source, page, hasMore, list });
    // restoreListSource / aggActive 刻意不入依赖：上面有早退守卫，不因守卫状态翻转触发重写
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, searchedKw, source, page, hasMore]);

  const showToast = (kind: "ok" | "err", text: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ kind, text });
    toastTimerRef.current = setTimeout(() => setToast(null), 2500);
  };

  // 播放引擎（会话编排 + HTML5 Audio transport）：UI 只消费「播放会话快照 + 播放命令」，
  // 队列翻页（fetchMorePage）与轻提示（notify）以 options 注入，见 use-player-engine.ts
  const {
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
    audioProps,
  } = usePlayerEngine({
    list,
    hasMore,
    source,
    fetchMorePage: () => goToPage(page + 1),
    notify: showToast,
  });

  /** 清空播放会话（播放状态由引擎 resetSession 复位，封面/歌词数据随之联动清空），供搜索/切源/解析前调用 */
  const resetPlayer = () => {
    lyricAbortRef.current?.abort();
    setCoverUrl("");
    setCoverFailed(false);
    setLyricLines(null);
    setLyricRaw("");
    setLyricError("");
    resetSession();
  };

  // 换曲（含上下首 / 自动续播 / 重置清空）即复位「直链已复制」指示，避免切歌后短暂误读旧直链
  useEffect(() => {
    setCopied(false);
  }, [picked, setCopied]);

  /** 人工选版面板：自动换源已停止（autoTrying=false）但当前曲仍处于失败阶段
   *  （failStage 非空）且还剩未尝试过的同曲候选（队列内 A / 跨源现搜 B）时弹出，
   *  供用户挑一版。跨源现搜可能耗时（网络），期间 autoTrying 仍为 true，不会误弹。 */
  const altOpen =
    !altDismissed && !!failStage && !autoTrying && alternatives.length > 0;

  // 换到新歌（或引擎在失败间切换过尝试对象）后，复位用户对上一首失败曲的「已关闭」记忆
  useEffect(() => {
    setAltDismissed(false);
  }, [picked?.source, picked?.id]);

  // 面板开启期间：Esc 关闭 + 锁定背景滚动
  useEffect(() => {
    if (!altOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAltDismissed(true);
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [altOpen]);

  /** 关闭人工选版面板（保留当前曲目） */
  const dismissAltSelect = useCallback(() => setAltDismissed(true), []);
  /** 从人工选版面板挑一版播放：来源 A 候选换算成队列索引走常规播放流程；
   *  来源 B（跨源现搜）候选通常不在当前队列，index 用 -1 直接播放（引擎会重置失败态并重新闭环） */
  const pickAlt = useCallback(
    (item: SearchItem) => {
      const idx = list
        ? list.findIndex((it) => it.source === item.source && it.id === item.id)
        : -1;
      playTrack(item, idx);
    },
    [list, playTrack]
  );

  const runSearch = async (e?: React.FormEvent | string) => {
    if (typeof e !== "string") e?.preventDefault();
    const kw = (typeof e === "string" ? e : keyword).trim();
    if (!kw) {
      setSearchError("请输入要搜索的歌名或歌手关键词");
      return;
    }
    if (searchAbortRef.current) searchAbortRef.current.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    // 提交关键词搜索即视为在该渠道上的一次显式使用：记录「聚合 / 单平台 + 平台」偏好
    writeSearchChannelPref(aggActive, source);
    // 用户发起了新搜索：取消“缓存来源 chip 待回填”，以当前选择为准
    setRestoreListSource(null);

    setSearching(true);
    setSearchError("");
    setPageErr("");
    setList(null);
    resetPlayer();
    setSearchedKw(kw);
    setPage(1);
    setHasMore(false);
    setMusicView("playlist");

    // 聚合搜索模式：并发搜全部可用音源第 1 页 → 跨源同曲去重 + 相关度打分排序 → 混合列表。
    // 条目各自带 source，播放 / 歌词 / 封面 / 下载链路与单源结果完全一致。
    if (aggActive) {
      try {
        const keys = sourceChips.map((c) => c.key);
        if (!keys.length) throw new Error("当前没有可用的搜索音源");
        const results = await searchAcrossSources(keys, kw, controller.signal);
        if (controller.signal.aborted) return;
        const flat: SearchItem[] = [];
        const failed: string[] = [];
        for (const r of results) {
          if (r.ok) flat.push(...r.items);
          else if (r.source) failed.push(r.source);
        }
        const labelOf = (key: string) => sourceChips.find((c) => c.key === key)?.label ?? key;
        const agg = aggregateAndRankSearch(kw, flat, {
          engineOrder: aggEngineOrder,
          betterPrimary: (a, b) => playableKindRank(a) < playableKindRank(b),
        });
        if (agg.items.length > 0) {
          setList(agg.items);
          if (failed.length > 0) {
            setPageErr(`以下音源搜索失败，已跳过：${failed.map(labelOf).join(" / ")}`);
          }
        } else {
          setList([]);
          setSearchError(
            failed.length > 0 && failed.length === keys.length
              ? `音源搜索失败：${failed.map(labelOf).join(" / ")}`
              : ""
          );
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        setSearchError(err instanceof Error ? err.message : "聚合搜索失败，请稍后重试");
      } finally {
        if (searchAbortRef.current === controller) {
          setSearching(false);
          searchAbortRef.current = null;
        }
      }
      return;
    }

    try {
      const data = await requestSearchPage(source, kw, 1, controller.signal);
      if (controller.signal.aborted) return;
      const freshItems = data.items || [];
      // 同关键词 + 同来源，且本次首页结果与缓存列表头部逐条一致：视为同一份结果，
      // 直接沿用缓存里已累积的更完整列表（翻页过时保留深页），避免“重新搜索只剩第一页”
      const cached = readPlaylistSnapshot();
      if (
        cached &&
        cached.kw === kw &&
        cached.source === source &&
        isSameListHead(freshItems, cached.list)
      ) {
        setList(cached.list);
        setPage(cached.page);
        setHasMore(Boolean(cached.hasMore));
      } else {
        setList(freshItems);
        setPage(data.page || 1);
        setHasMore(Boolean(data.hasMore));
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      setSearchError(err instanceof Error ? err.message : "请求失败，请稍后重试");
    } finally {
      if (searchAbortRef.current === controller) {
        setSearching(false);
        searchAbortRef.current = null;
      }
    }
  };

  /**
   * 链接解析：把平台分享链接解析为归一曲目（source+id+元数据），作为单条播放
   * 列表插入；播放 / 下载 / 歌词 / 封面复用搜索结果的同一套链路。网易云 / QQ音乐 /
   * 酷我链接当前可直接解析到播放；酷狗识别成功但直链引擎未接入时给出引导提示。
   */
  const runResolve = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const text = link.trim();
    if (!text) {
      setResolveError("请先粘贴歌曲分享链接");
      return;
    }
    if (resolveAbortRef.current) resolveAbortRef.current.abort();
    const controller = new AbortController();
    resolveAbortRef.current = controller;
    // 用户主动解析链接：取消“缓存来源 chip 待回填”，以解析产物平台为准
    setRestoreListSource(null);

    setResolving(true);
    setResolveError("");
    setPageErr("");
    setList(null);
    resetPlayer();
    setPage(1);
    setHasMore(false);

    try {
      const data = await requestResolve(text, controller.signal);
      if (controller.signal.aborted) return;
      if (data.status === "playable" && data.item) {
        const it = data.item;
        // 解析产物平台若与当前搜索源不一致则同步 chip，保证列表平台列 / 图标 / 直链通道一致。
        // 只对 GD 引擎的 netease/kuwo/joox 同步；tencent 的自研搜索产物仍复用 GD 直链通道，
        // 此处不把 chip 切到 QQ音乐——解析属于「单曲直达」而非搜索渠道切换，行内「来源」已单独
        // 展示 item.source，也避免把用户此前手选的搜索渠道带偏。
        const key = it.source as SearchSourceKey;
        if ((key === "netease" || key === "kuwo" || key === "joox") && key !== source) {
          // 注意：切 chip 属于被动状态变化，刻意不写渠道缓存（见 SEARCH_CHANNEL_KEY 注释）
          setSource(key);
          setSearchError("");
        }
        setList([it]);
        setHasMore(false);
        setMusicView("playlist");
        if (data.metadata === "fallback") {
          showToast(
            "ok",
            "已就绪：详情通道暂不可用，标题以歌曲 ID 占位，仍可播放 / 下载"
          );
        } else {
          showToast("ok", `已解析「${it.name}」，可试听与下载`);
        }
      } else if (data.status === "engine-missing") {
        setResolveError(data.message || "该平台直链解析引擎暂未接入");
      } else {
        setResolveError("暂时无法解析该链接，请换一条歌曲链接试试");
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      setResolveError(
        err instanceof Error && err.message ? err.message : "解析失败，请稍后重试"
      );
    } finally {
      if (resolveAbortRef.current === controller) {
        setResolving(false);
        resolveAbortRef.current = null;
      }
    }
  };

  /** 追加加载下一页：结果累积进 list，配合下拉触底自动翻页，滚动位置不变 */
  const goToPage = async (targetPage: number) => {
    if (
      !searchedKw ||
      searching ||
      targetPage < 1 ||
      pagingRef.current ||
      // 缓存恢复的列表来源 chip 尚未回填（lx 目录加载中）时不抢先按默认源翻页
      Boolean(restoreListSource)
    )
      return;
    if (searchAbortRef.current) searchAbortRef.current.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;

    pagingRef.current = true;
    setPaging(true);
    setPageErr("");
    try {
      const data = await requestSearchPage(
        source,
        searchedKw,
        targetPage,
        controller.signal
      );
      if (controller.signal.aborted) return;
      const items = data.items || [];
      if (!items.length) {
        setHasMore(false);
        return;
      }
      setList((prev) => [...(prev || []), ...items]);
      setPage(data.page || targetPage);
      setHasMore(Boolean(data.hasMore));
    } catch (err) {
      if (controller.signal.aborted) return;
      setPageErr(err instanceof Error ? err.message : "加载失败，请稍后重试");
    } finally {
      if (searchAbortRef.current === controller) {
        pagingRef.current = false;
        setPaging(false);
        searchAbortRef.current = null;
      }
    }
  };

  /** 下拉触底自动加载下一页 */
  const handleListScroll = () => {
    const el = listTopRef.current;
    if (!el || pagingRef.current || searching || !hasMore || !searchedKw) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance < 300) goToPage(page + 1);
  };

  // 内容不足一屏（尤其移动端无内滚动）时自动补页直到铺满或没有更多
  useEffect(() => {
    if (searching || paging || !hasMore || !searchedKw) return;
    const el = listTopRef.current;
    if (el && el.scrollHeight <= el.clientHeight + 80) {
      goToPage(page + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, paging, hasMore, searching, searchedKw, page]);



  // 收起整页歌词：先加 is-closing 触发收起动画，动画结束（延迟略长于动画时长）才真正卸载
  const requestCloseLyric = useCallback(() => {
    if (!lyricOpen || lyricCloseTimerRef.current) return;
    setLyricClosing(true);
    lyricCloseTimerRef.current = setTimeout(() => {
      lyricCloseTimerRef.current = null;
      setLyricClosing(false);
      setLyricOpen(false);
    }, 340);
  }, [lyricOpen]);

  // 组件卸载时清理收起动画定时器，避免对已卸载组件 setState
  useEffect(
    () => () => {
      if (lyricCloseTimerRef.current) clearTimeout(lyricCloseTimerRef.current);
    },
    []
  );

  // 点击底部播放栏的歌曲封面 → 展开整页歌词（若处于收起动画中途则取消卸载）
  const openLyricPage = () => {
    if (!picked) return;
    if (lyricCloseTimerRef.current) {
      clearTimeout(lyricCloseTimerRef.current);
      lyricCloseTimerRef.current = null;
    }
    // 若在「下拉拖拽收起」中途再次展开，先清掉手势遗留的位移与样式
    const el = lyricPageRef.current;
    if (el) {
      el.classList.remove("is-drag-close");
      el.style.transition = "";
      el.style.transform = "";
    }
    setLyricClosing(false);
    setLyricOpen(true);
  };

  // 手势回调引用指向最新实现（effect 内部不依赖组件函数闭包）
  openLyricRef.current = openLyricPage;
  closeLyricRef.current = requestCloseLyric;

  // 整页歌词视图下：Esc 收起、锁定背景滚动（人工选版面板在其上打开时由面板接管 Esc）
  useEffect(() => {
    if (!lyricOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".mp-alt-mask")) {
        requestCloseLyric();
      }
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [lyricOpen, requestCloseLyric]);

  // 移动端视口跟随（≤700px 触发迷你条 / 正在播放整页形态）
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 700px)");
    const update = () => setIsMobile(mq.matches);
    update();
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", update);
      return () => mq.removeEventListener("change", update);
    }
    // 旧版 Safari 回退
    mq.addListener(update);
    return () => mq.removeListener(update);
  }, []);

  // 每次展开正在播放页回到「唱片」视图（网易云式：默认先看到大封面）
  useEffect(() => {
    if (lyricOpen) setNpViewCover(true);
  }, [lyricOpen]);

  // 移动端手势①：底部迷你条向上滑动 → 展开正在播放页
  useEffect(() => {
    if (!isMobile) return;
    const mini = miniPlayerRef.current;
    if (!mini) return;
    let y0 = -1;
    const onStart = (e: TouchEvent) => {
      const t = e.target as Element;
      // 从控制按钮 / 进度条上起手时不拦截，避免误触（点按不产生位移，天然无冲突）
      y0 = t.closest(".mp-ctrls, .mp-pbar, .mp-ptime")
        ? -1
        : e.touches[0].clientY;
    };
    const onMove = (e: TouchEvent) => {
      if (y0 < 0 || e.touches.length === 0) return;
      if (y0 - e.touches[0].clientY > 56) {
        y0 = -1;
        openLyricRef.current();
      }
    };
    mini.addEventListener("touchstart", onStart, { passive: true });
    mini.addEventListener("touchmove", onMove, { passive: true });
    return () => {
      mini.removeEventListener("touchstart", onStart);
      mini.removeEventListener("touchmove", onMove);
    };
  }, [isMobile]);

  // 移动端手势②：正在播放页下拉拖拽收起。
  // 唱片视图可在任意空白处下拉；歌词视图需歌词已滚到顶部（scrollTop 0）才能下拉，
  // 保证与歌词纵向滚动不冲突。拖过阈值直接滑出关页，不足则回弹复位。
  useEffect(() => {
    if (!isMobile || !lyricOpen) return;
    const el = lyricPageRef.current;
    if (!el) return;
    let startY = -1;
    let dy = 0;
    let armed = false;
    let allow = false;
    const isInteractive = (t: Element) =>
      t.closest(
        "input, button, a, select, textarea, [role='slider'], .mplp-collapse, .mplp-viewbtn"
      );
    const onStart = (e: TouchEvent) => {
      const t = e.target as Element;
      if (isInteractive(t)) {
        startY = -1;
        return;
      }
      startY = e.touches[0].clientY;
      dy = 0;
      armed = false;
      allow = false;
    };
    const onMove = (e: TouchEvent) => {
      if (startY < 0 || e.touches.length === 0) return;
      dy = e.touches[0].clientY - startY;
      if (!armed) {
        if (Math.abs(dy) < 8) return;
        if (dy < 0) {
          // 手势向上：交还给歌词 / 页面原生滚动
          startY = -1;
          return;
        }
        const t = e.target as Element;
        const zone = el.querySelector<HTMLElement>(".mplp-right .mp-lyric-body-lg");
        if (zone && zone.contains(t) && (zone.scrollTop ?? 0) > 2) {
          startY = -1;
          return;
        }
        allow = true;
        armed = true;
      }
      if (!allow) return;
      e.preventDefault();
      el.style.transition = "none";
      el.style.transform = `translateY(${Math.min(dy * 0.55, 320)}px)`;
    };
    const finish = () => {
      if (startY < 0) return;
      if (armed && allow && dy >= 110) {
        // 过阈值：禁用 CSS 收起动画，由 JS 直接把整页拖出屏幕
        el.classList.add("is-closing", "is-drag-close");
        el.style.transition = "transform 0.28s cubic-bezier(0.32, 0.1, 0.34, 1)";
        el.style.transform = "translateY(104%)";
        closeLyricRef.current();
      } else if (armed && allow) {
        el.style.transition = "transform 0.22s cubic-bezier(0.2, 0.9, 0.3, 1)";
        el.style.transform = "";
      }
      startY = -1;
      armed = false;
      allow = false;
      dy = 0;
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", finish, { passive: true });
    el.addEventListener("touchcancel", finish, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", finish);
      el.removeEventListener("touchcancel", finish);
    };
  }, [isMobile, lyricOpen]);

  // 歌曲详情弹窗下：Esc 收起、锁定背景滚动（人工选版面板在上时同样交给面板）
  useEffect(() => {
    if (!infoTrack) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".mp-alt-mask")) {
        setInfoTrack(null);
      }
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [infoTrack]);

  // 进度条悬停气泡：测量轨道与气泡宽度，便于把箭头对准滑块圆心（轨道两侧各内缩半个圆点宽）
  useEffect(() => {
    if (!progHover) return;
    const pbarEl = pbarRef.current;
    const bubbleEl = tipBubbleRef.current;
    const measure = () => {
      if (pbarEl) setPbarW(pbarEl.getBoundingClientRect().width);
      if (bubbleEl) setTipBubbleW(bubbleEl.getBoundingClientRect().width);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (pbarEl) ro.observe(pbarEl);
    if (bubbleEl) ro.observe(bubbleEl);
    return () => ro.disconnect();
  }, [progHover]);

  const copyUrl = async () => {
    if (!direct) return;
    if (await writeClipboard(direct.url)) flashCopied();
    // 复制失败静默
  };

  const switchSource = (next: SearchSourceKey) => {
    if (!aggActive && next === source) return;
    setAggActive(false);
    setSource(next);
    // 显式点选单平台 chip：记为用户手选渠道（退出聚合后的回退值也随 source 记录）
    writeSearchChannelPref(false, next);
    setRestoreListSource(null);
    setList(null);
    setHasMore(false);
    setPage(1);
    setPageErr("");
    setSearchError("");
    setSearchedKw("");
    resetPlayer();
  };

  /** 切换聚合搜索模式：结果列表结构（单源 vs 混合源）不同，切换时清空避免误播/误翻页 */
  const toggleAggregate = () => {
    const next = !aggActive;
    setAggActive(next);
    // 显式切到聚合 / 退出聚合：记录偏好，供下次进入沿用当前模式
    writeSearchChannelPref(next, source);
    setRestoreListSource(null);
    setList(null);
    setPage(1);
    setHasMore(false);
    setPageErr("");
    setSearchError("");
    setSearchedKw("");
    resetPlayer();
  };

  // 专辑封面
  useEffect(() => {
    coverAbortRef.current?.abort();
    setCoverUrl("");
    setCoverFailed(false);
    setCoverLoading(false);
    if (!picked) return;
    const picId = picked.picId ?? "";
    const directPic = picked.picUrlDirect ?? "";
    if (!picId && !directPic) return;

    // 链接解析产物的封面是图床直链，直接展示，无需经 GD pic 换取
    if (directPic) {
      setCoverUrl(directPic);
      return;
    }

    const controller = new AbortController();
    coverAbortRef.current = controller;
    setCoverLoading(true);

    (async () => {
      try {
        const url = await requestPic(
          picked.source || source,
          picId,
          controller.signal
        );
        if (controller.signal.aborted) return;
        setCoverUrl(url);
      } catch {
        if (!controller.signal.aborted) setCoverFailed(true);
      } finally {
        if (!controller.signal.aborted) setCoverLoading(false);
      }
    })();

    return () => controller.abort();
  }, [picked, source]);

  // 跟随站点主题：ThemeToggle / 系统偏好都会反映在 <html> 的 class 上
  useEffect(() => {
    const el = document.documentElement;
    const apply = () => setIsDark(el.classList.contains("dark"));
    apply();
    const mo = new MutationObserver(apply);
    mo.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);

  // 整页歌词动态配色：封面到位后降采样取「主色/明暗」，据此推导背景渐变与
  // 对比文字色。暗色主题强制「深背景浅字」变体（仅保留封面主色调），避免亮色
  // 封面在深色模式下把整页切成刺眼的浅色背景；浅色主题仍按封面明暗自适应。
  // 优先直接读外部 CDN 图（仅当其开放 CORS），失败回退同源字节代理。
  useEffect(() => {
    paletteAbortRef.current?.abort();
    setPalette(null);
    if (!picked || coverFailed || !coverUrl) return;
    const picId = picked.picId ?? "";
    // 链接解析产物的封面为图床直链，无法走 GD bin 代理取色，跳过即可（直链 CORS 失败会静默回退默认配色）
    if (!picId && !picked.picUrlDirect) return;
    const srcName = picked.source || source;
    // 同源 bin 字节代理仅 GD 源且同源代理可用时存在（lx 源封面为直链、直连模式下 bin 同样 502）；
    // 无 bin 时仅尝试外部直链取色，取不到色就回退整页歌词默认配色（不阻断功能）
    const binUrl = !picked.picUrlDirect ? coverBinUrl(srcName, picId) : "";
    const controller = new AbortController();
    paletteAbortRef.current = controller;
    (async () => {
      const pal = await sampleCoverPalette(coverUrl, binUrl, controller.signal, {
        mode: isDark ? "dark" : "auto",
      });
      if (controller.signal.aborted || !pal) return;
      setPalette(pal);
    })();
    return () => controller.abort();
  }, [coverUrl, coverFailed, picked, source, isDark]);

  // 歌词
  useEffect(() => {
    lyricAbortRef.current?.abort();
    setLyricLines(null);
    setLyricRaw("");
    setLyricError("");
    setLyricsLoading(false);
    if (!picked) return;
    const lyricId = picked.lyricId ?? picked.id ?? "";
    if (!lyricId) return;

    const controller = new AbortController();
    lyricAbortRef.current = controller;
    setLyricsLoading(true);

    (async () => {
      try {
        const raw = await requestLyric(
          picked.source || source,
          lyricId,
          controller.signal
        );
        if (controller.signal.aborted) return;
        const lines = parseLrc(raw);
        setLyricRaw(raw);
        setLyricLines(lines.length ? lines : null);
      } catch (err) {
        if (!controller.signal.aborted) {
          setLyricError(err instanceof Error ? err.message : "歌词加载失败");
        }
      } finally {
        if (!controller.signal.aborted) setLyricsLoading(false);
      }
    })();

    return () => controller.abort();
  }, [picked, source]);

  // 原始 LRC 转可下载 Blob：歌词就绪后详情弹窗里可点击超链接下载该 .lrc 文件
  useEffect(() => {
    if (!lyricRaw) {
      setLyricBlobUrl("");
      return;
    }
    const url = URL.createObjectURL(
      new Blob([lyricRaw], { type: "text/plain;charset=utf-8" })
    );
    setLyricBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [lyricRaw]);

  const artistText = (item: SearchItem) => (item.artist || []).join(" / ") || "未知歌手";

  const activeLyricIndex = useMemo(
    () => getActiveLyricIndex(lyricLines || [], currentTime),
    [lyricLines, currentTime]
  );

  const progressPercent = duration ? (currentTime / duration) * 100 : 0;
  const volumePercent = volume * 100;

  // —— 主体内容面板见 SearchPanel / PlaylistPanel / NowPlayingPanel 组件 ——

  // 底部播放控制条独立组件：进度 / 迷你歌词 / 控制 / 音质 / 音量
  const renderBottomBar = () => (
    <PlayerBar
      picked={picked}
      playing={playing}
      duration={duration}
      currentTime={currentTime}
      progressPercent={progressPercent}
      volumePercent={volumePercent}
      muted={muted}
      volume={volume}
      loop={loop}
      br={br}
      fetching={fetching}
      direct={direct}
      playError={playError}
      coverUrl={coverUrl}
      coverFailed={coverFailed}
      lyricLines={lyricLines}
      activeLyricIndex={activeLyricIndex}
      lyricsLoading={lyricsLoading}
      lyricError={lyricError}
      list={list}
      currentIndex={currentIndex}
      hasMore={hasMore}
      progHover={progHover}
      pbarW={pbarW}
      tipBubbleW={tipBubbleW}
      miniPlayerRef={miniPlayerRef}
      pbarRef={pbarRef}
      tipBubbleRef={tipBubbleRef}
      artistText={artistText}
      seek={seek}
      setSeeking={setSeeking}
      setProgHover={setProgHover}
      setLoop={setLoop}
      setMuted={setMuted}
      setVolume={setVolume}
      togglePlay={togglePlay}
      playPrev={playPrev}
      playNext={playNext}
      switchQuality={switchQuality}
      openLyricPage={openLyricPage}
    />
  );

  // 歌曲详情弹窗 → TrackInfoDialog 组件（见 TrackInfoDialog.tsx）：
  // 行内「详情」按钮触发，展示歌名 / 歌手 / 专辑 / 时长、
  // 音质 / 文件大小与歌词、封面、直链等运行时信息（播放当前歌曲前多为占位）
  const renderTrackInfo = () => (
    <TrackInfoDialog
      infoTrack={infoTrack}
      picked={picked}
      currentIndex={currentIndex}
      source={source}
      sourceChips={sourceChips}
      direct={direct}
      duration={duration}
      fetching={fetching}
      copied={copied}
      lyricsLoading={lyricsLoading}
      lyricRaw={lyricRaw}
      lyricError={lyricError}
      lyricLines={lyricLines}
      lyricBlobUrl={lyricBlobUrl}
      coverLoading={coverLoading}
      coverUrl={coverUrl}
      coverFailed={coverFailed}
      artistText={artistText}
      copyUrl={copyUrl}
      showToast={showToast}
      onClose={() => setInfoTrack(null)}
    />
  );

  // 整页歌词视图 → LyricPage 组件（见 LyricPage.tsx）
  const renderLyricPage = () => (
    <LyricPage
      open={lyricOpen}
      closing={lyricClosing}
      picked={picked}
      playing={playing}
      direct={direct}
      playError={playError}
      list={list}
      currentIndex={currentIndex}
      hasMore={hasMore}
      duration={duration}
      currentTime={currentTime}
      volume={volume}
      volumePercent={volumePercent}
      muted={muted}
      loop={loop}
      npViewCover={npViewCover}
      activeLyricIndex={activeLyricIndex}
      coverUrl={coverUrl}
      coverFailed={coverFailed}
      lyricLines={lyricLines}
      lyricsLoading={lyricsLoading}
      lyricError={lyricError}
      lyricRaw={lyricRaw}
      accentColor={sourceMeta.color}
      palette={palette}
      isMobile={isMobile}
      lyricPageRef={lyricPageRef}
      artistText={artistText}
      requestClose={requestCloseLyric}
      togglePlay={togglePlay}
      playPrev={playPrev}
      playNext={playNext}
      seek={seek}
      setSeeking={setSeeking}
      setLoop={setLoop}
      setMuted={setMuted}
      setVolume={setVolume}
      setNpViewCover={setNpViewCover}
      onCoverError={() => setCoverFailed(true)}
    />
  );

  return (
    <div className="mp-app">
      {/* 主体：左侧内容 / 右侧正在播放（顶部 logo/标题在全局头部，
          发现歌曲/播放列表切换器在本内容区功能区左上角）。
          发现歌曲页专注搜索，隐藏右侧当前播放卡片；播放列表视图再展示 */}
      <div className="mp-body">
        <main className="mp-main">
          <div className="mp-tools">
            <MusicViewSeg />
          </div>
          {tab === "search" ? (
            <SearchPanel
              mode={mode}
              setMode={setMode}
              keyword={keyword}
              setKeyword={setKeyword}
              link={link}
              setLink={setLink}
              searching={searching}
              resolving={resolving}
              searchError={searchError}
              resolveError={resolveError}
              setSearchError={setSearchError}
              setResolveError={setResolveError}
              source={source}
              sourceChips={sourceChips}
              sourceLabel={sourceMeta.label}
              aggActive={aggActive}
              setAggActive={toggleAggregate}
              runSearch={runSearch}
              runResolve={runResolve}
              switchSource={switchSource}
            />
          ) : (
            <PlaylistPanel
              searching={searching}
              searchedKw={searchedKw}
              list={list}
              currentIndex={currentIndex}
              fetching={fetching}
              direct={direct}
              playing={playing}
              paging={paging}
              pageErr={pageErr}
              hasMore={hasMore}
              source={source}
              sourceChips={sourceChips}
              listTopRef={listTopRef}
              artistText={artistText}
              playTrack={playTrack}
              handleListScroll={handleListScroll}
              aggMode={aggActive}
              emptyHint={aggActive && searchError ? searchError : ""}
            />
          )}
        </main>
        {tab !== "search" && (
          <aside className="mp-side">
            <NowPlayingPanel
              picked={picked}
              playing={playing}
              coverLoading={coverLoading}
              coverUrl={coverUrl}
              coverFailed={coverFailed}
              direct={direct}
              br={br}
              source={source}
              sourceChips={sourceChips}
              playError={playError}
              copied={copied}
              currentIndex={currentIndex}
              artistText={artistText}
              onOpenLyric={openLyricPage}
              onCoverError={() => setCoverFailed(true)}
              copyUrl={copyUrl}
              onShowInfo={(item, index) => setInfoTrack({ item, index })}
            />
          </aside>
        )}
      </div>

      {/* 底部播放控制条 */}
      {renderBottomBar()}

      {/* transport 由播放引擎托管：<audio> 与全部播放事件收敛在 use-player-engine */}
      <audio {...audioProps} className="sr-only" />

      {/* 播放失败 → 自动换源进行态：先在队列内尝试同曲版本；耗尽后再跨音源现搜（来源 B） */}
      {autoTrying && (
        <div className="mp-alt-progress" role="status">
          <Loader2 className="mp-spin" />
          <span>
            {altNote || "播放失败，正在自动尝试同曲其他版本…"}
          </span>
        </div>
      )}

      {/* 音质切换等操作的轻提示 */}
      {toast && (
        <div
          className={cn("mp-toast", toast.kind === "err" && "is-err")}
          role="status">
          {toast.kind === "err" ? <AlertCircle /> : <Check />}
          <span>{toast.text}</span>
        </div>
      )}

      {/* 歌曲详情弹窗：点击播放列表行右侧的 info 图标触发 */}
      {renderTrackInfo()}

      {/* 人工选版面板：自动换源收尾仍失败、队列里还有同曲其他版本时弹出（ESC/遮罩可关） */}
      <AltSelectDialog
        open={altOpen}
        picked={picked}
        alternatives={alternatives}
        sourceChips={sourceChips}
        artistText={artistText}
        onPick={pickAlt}
        onClose={dismissAltSelect}
      />

      {/* 整页歌词：点击底部播放栏的歌曲封面触发。桌面端可点带时间轴的行跳进度；
          移动端进度条以上非按钮区点击即切换 唱片/歌词 视图，不再点歌词跳进度 */}
      {renderLyricPage()}
    </div>
  );
}
