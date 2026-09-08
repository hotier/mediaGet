"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  ChevronDown,
  Copy,
  Disc3,
  Download,
  Info,
  Link2,
  Loader2,
  Maximize2,
  Music2,
  Pause,
  Play,
  Repeat,
  Search,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import {
  BR_DEFAULT,
  BR_GROUP_LABEL,
  BR_LABEL,
  BR_OPTIONS,
  SEARCH_SOURCES,
  formatSize,
  formatTime,
  type SearchSourceKey,
} from "@/components/music/types";
import {
  fetchLxCatalog,
  isDirectUsed,
  musicLineMeta,
  requestDirect,
  requestLyric,
  requestPic,
  requestResolve,
  requestSearchPage,
  type DirectData,
  type LxSearchSource,
  type SearchItem,
} from "@/lib/music-client";
import {
  setMusicView,
  useMusicView,
} from "@/components/music/music-view-store";
import MusicViewSeg from "@/components/music/MusicViewSeg";
import { PlatformIcon } from "@/components/music/platform-icons";
import { BrPicker } from "@/components/music/BrPicker";
import { cn } from "@/lib/utils";
import {
  type CoverPalette,
  sampleCoverPalette,
} from "@/lib/cover-palette";

/** 搜索源 chip 的统一展示形态：内置 GD 源 + 动态加载的 lx 脚本扩展源 */
interface SearchChip {
  key: SearchSourceKey;
  label: string;
  color: string;
  /** 是否为 lx 脚本扩展源（扩展源没有品牌 logo，chip 改渲染彩色圆点区分） */
  ext?: boolean;
}

/** lx 扩展源 chip 的强调色：脚本自报名称但无品牌色，按出现顺序轮换配色 */
const LX_SOURCE_COLORS = [
  "#a855f7",
  "#0ea5e9",
  "#f43f5e",
  "#f59e0b",
  "#10b981",
  "#ec4899",
];

interface LyricLine {
  time: number;
  text: string;
}

function parseLrc(raw: string): LyricLine[] {
  const lines: LyricLine[] = [];
  raw.split(/\r?\n/).forEach((line) => {
    const text = line.trim();
    if (!text) return;
    const m = /^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/.exec(text);
    if (m) {
      const time = Number(m[1]) * 60 + Number(m[2]);
      lines.push({ time, text: m[3].trim() });
    } else {
      lines.push({ time: -1, text });
    }
  });
  return lines;
}

function getActiveLyricIndex(lines: LyricLine[], currentTime: number): number {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time >= 0 && lines[i].time <= currentTime) idx = i;
  }
  return idx;
}

interface LyricScrollerProps {
  lines: LyricLine[];
  loading: boolean;
  error: string;
  hasRaw: boolean;
  activeIndex: number;
  /** 整页歌词视图的大字号展示模式 */
  large?: boolean;
  /** 点击带时间轴的行时跳转到对应播放位置 */
  onSeek?: (time: number) => void;
}

/**
 * 滚动歌词主体（自带 active 行自动居中滚动）。
 * 供「整页歌词」视图使用，滚动容器独立维护。
 */
function LyricScroller({
  lines,
  loading,
  error,
  hasRaw,
  activeIndex,
  large = false,
  onSeek,
}: LyricScrollerProps) {
  const activeRef = useRef<HTMLDivElement | null>(null);

  // active 行变化时自动滚动到可视区中央
  useEffect(() => {
    if (!activeRef.current) return;
    activeRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeIndex]);

  if (loading) {
    return (
      <div className="mp-lyric-empty">
        <Loader2 className="mp-spin" />
        <span>正在加载歌词…</span>
      </div>
    );
  }
  if (error || (hasRaw && lines.length === 0)) {
    return (
      <div className="mp-lyric-empty">
        <Disc3 />
        <span>暂无歌词</span>
        {error && <span className="err">{error}</span>}
      </div>
    );
  }
  if (lines.length === 0) {
    return (
      <div className="mp-lyric-empty">
        <Disc3 />
        <span>暂无歌词</span>
        <span style={{ fontSize: 11, opacity: 0.7 }}>
          播放后自动尝试拉取滚动歌词
        </span>
      </div>
    );
  }
  return (
    <div className={cn("mp-lyric-body", large && "mp-lyric-body-lg")}>
      {lines.map((line, i) => {
        const active = i === activeIndex;
        const dim = !active && Math.abs(i - activeIndex) > 6;
        const seekable = line.time >= 0 && onSeek;
        return (
          <div
            key={i}
            ref={active ? activeRef : undefined}
            onClick={seekable ? () => onSeek?.(line.time) : undefined}
            role={seekable ? "button" : undefined}
            aria-current={active ? "true" : undefined}
            className={cn(
              large ? "mp-lplr" : "mp-lr",
              active && "is-active",
              dim && "is-dim",
              seekable && "has-time"
            )}>
            {line.text || "· · ·"}
          </div>
        );
      })}
    </div>
  );
}

interface MiniLyricLineProps {
  text: string;
  /** 是否正在播放：仅播放中的超长句才跑马灯，暂停/溢出时退化为省略号 */
  playing: boolean;
}

/**
 * 底部播放栏的「单行实时歌词」（顶替歌手行，不改变底栏高度）。
 * - 文本宽度不超过可用宽度时居中静态显示；
 * - 文本溢出且正在播放时启用无缝双副本跑马灯（translateX 0 → -50%）；
 * - 文本溢出但暂停时左对齐截断，避免静止还一直滚动。
 * 宽度用隐藏测量副本判断：nowrap 下其 offsetWidth 即文本自然宽度，
 * 不受父容器裁切/弹性布局影响。
 */
function MiniLyricLine({ text, playing }: MiniLyricLineProps) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const probeRef = useRef<HTMLSpanElement | null>(null);
  const [overflow, setOverflow] = useState(false);

  useLayoutEffect(() => {
    const row = rowRef.current;
    const probe = probeRef.current;
    if (!row || !probe) return;
    const update = () => {
      if (!rowRef.current || !probeRef.current) return;
      // +1px 容差：贴边不视为溢出，避免像素级抖动
      setOverflow(probeRef.current.offsetWidth > rowRef.current.clientWidth + 1);
    };
    update();
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(update);
      ro.observe(row);
      return () => ro.disconnect();
    }
  }, [text]);

  const run = playing && overflow;
  // 动画时长随文本长度放大（8~36s）：短句不至于瞬移，长句不会过快
  const dur = Math.max(8, Math.min(36, Math.round(text.length * 0.45)));
  return (
    <div
      ref={rowRef}
      className={cn("mp-lymq", run && "mq", overflow && !playing && "over")}
      title={text}
      aria-label={text}>
      {run ? (
        <span className="mp-lymq-track" style={{ animationDuration: `${dur}s` }}>
          <span className="mp-lymq-copy">{text}</span>
          <span className="mp-lymq-copy" aria-hidden="true">
            {text}
          </span>
        </span>
      ) : (
        <span className="mp-lymq-txt">{text}</span>
      )}
      {/* 隐藏测量副本：不参与布局，仅提供文本自然宽度 */}
      <span ref={probeRef} className="mp-lymq-probe" aria-hidden="true">
        {text}
      </span>
    </div>
  );
}

/** 播放列表会话快照（localStorage 单份 JSON）：最近一次搜索结果（含已翻页累积）。
 * 目的：刷新不摧毁列表；同一关键词 + 来源再次搜索，若首页结果与缓存头部一致，
 * 视为同一份结果，直接沿用缓存里更完整的累积列表，避免重新搜索后只剩第一页。 */
interface PlaylistSnapshot {
  /** 搜索关键词；链接解析产物列表存空串 */
  kw: string;
  /** 生成该列表时所用的搜索源 chip */
  source: string;
  /** 当前已加载到的页号 */
  page: number;
  hasMore: boolean;
  list: SearchItem[];
}
const PLAYLIST_CACHE_KEY = "mp-playlist-cache-v2";
/** 防止 localStorage 塞爆：只保留最近的 N 条，正常翻页远达不到该上限 */
const PLAYLIST_CACHE_LIMIT = 400;

function readPlaylistSnapshot(): PlaylistSnapshot | null {
  try {
    const raw = localStorage.getItem(PLAYLIST_CACHE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<PlaylistSnapshot>;
    if (!d || !Array.isArray(d.list) || typeof d.kw !== "string") return null;
    return {
      kw: d.kw,
      source: typeof d.source === "string" ? d.source : "",
      page: typeof d.page === "number" && d.page >= 1 ? d.page : 1,
      hasMore: Boolean(d.hasMore),
      list: d.list as SearchItem[],
    };
  } catch {
    return null;
  }
}

function writePlaylistSnapshot(s: PlaylistSnapshot): void {
  try {
    localStorage.setItem(
      PLAYLIST_CACHE_KEY,
      JSON.stringify({
        ...s,
        list:
          s.list.length > PLAYLIST_CACHE_LIMIT
            ? s.list.slice(-PLAYLIST_CACHE_LIMIT)
            : s.list,
      })
    );
  } catch {
    // 隐私模式等写入失败时静默降级，不影响播放
  }
}

function clearPlaylistSnapshot(): void {
  try {
    localStorage.removeItem(PLAYLIST_CACHE_KEY);
  } catch {
    /* 忽略 */
  }
}

/** 本次搜索首页返回 fresh 是否与缓存列表头部逐条一致（source+id 对齐即可，忽略元数据噪声） */
function isSameListHead(fresh: SearchItem[], cached: SearchItem[]): boolean {
  if (!fresh.length || fresh.length > cached.length) return false;
  return fresh.every((it, i) => {
    const prev = cached[i];
    return !!prev && prev.source === it.source && prev.id === it.id;
  });
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
  const [source, setSource] = useState<SearchSourceKey>(SEARCH_SOURCES[0].key);
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

  // —— 播放状态 ——
  const [currentIndex, setCurrentIndex] = useState<number | null>(null);
  const [picked, setPicked] = useState<SearchItem | null>(null);
  const [br, setBr] = useState<string>(BR_DEFAULT);
  const [direct, setDirect] = useState<DirectData | null>(null);
  const [fetching, setFetching] = useState(false);
  const [copied, setCopied] = useState(false);
  /** 详情弹窗「复制歌曲信息」后的临时成功态 */
  const [infoCopied, setInfoCopied] = useState(false);
  const [playing, setPlaying] = useState(false);
  /** 直链获取失败时的可见错误（避免播放按钮无提示地禁用） */
  const [playError, setPlayError] = useState("");

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

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  /** 音量（0~1）：默认 50%；优先从本地缓存恢复上次调整值，无缓存才用默认 */
  const [volume, setVolume] = useState(() => {
    try {
      const raw = localStorage.getItem("mp-player-volume");
      if (raw !== null) {
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0 && n <= 1) return n;
      }
    } catch {
      // SSR 首屏 / 隐私模式等 localStorage 不可用时忽略，落到默认 50%
    }
    return 0.5;
  });
  const [muted, setMuted] = useState(false);
  const [loop, setLoop] = useState(false);
  const [seeking, setSeeking] = useState(false);
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

  const searchAbortRef = useRef<AbortController | null>(null);
  const resolveAbortRef = useRef<AbortController | null>(null);
  const directAbortRef = useRef<AbortController | null>(null);
  const coverAbortRef = useRef<AbortController | null>(null);
  const paletteAbortRef = useRef<AbortController | null>(null);
  const lyricAbortRef = useRef<AbortController | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const infoCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 整页歌词收起动画结束后延迟卸载的定时器 */
  const lyricCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 音质热切换时旧直链的播放位置（秒），新源就绪后从该处续播 */
  const resumeAtRef = useRef(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pbarRef = useRef<HTMLDivElement | null>(null);
  const tipBubbleRef = useRef<HTMLSpanElement | null>(null);
  /** 用户本次手势是否期望自动播放（点歌/切音质时置位，直链就绪后消费） */
  const autoplayRef = useRef(false);
  /** 跟随 muted 状态，供异步播放回调读取最新静音设置 */
  const mutedRef = useRef(muted);
  const listTopRef = useRef<HTMLDivElement | null>(null);
  /** 加载下一页防重入标记（ref 保证 onScroll / 补屏两个触发源不会并发翻页） */
  const pagingRef = useRef(false);

  /** 全部可选的搜索源 chip：内置 GD 源固定在前，扩展源紧随其后（key 冲突时内置优先） */
  const sourceChips = useMemo<SearchChip[]>(() => {
    const chips: SearchChip[] = SEARCH_SOURCES.map((s) => ({
      key: s.key,
      label: s.label,
      color: s.color,
    }));
    const builtinKeys = new Set(chips.map((c) => c.key));
    for (const s of extSources || []) {
      if (!s || !s.key || builtinKeys.has(s.key)) continue;
      chips.push({
        key: s.key,
        label: s.label || s.key,
        color: LX_SOURCE_COLORS[chips.length % LX_SOURCE_COLORS.length],
        ext: true,
      });
    }
    return chips;
  }, [extSources]);

  const sourceMeta = sourceChips.find((s) => s.key === source) ?? sourceChips[0];

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
      directAbortRef.current?.abort();
      coverAbortRef.current?.abort();
      lyricAbortRef.current?.abort();
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      if (infoCopyTimerRef.current) clearTimeout(infoCopyTimerRef.current);
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  // 播放列表本地缓存：挂载时恢复最近一次搜索/解析结果，刷新后列表不销毁
  useEffect(() => {
    const snap = readPlaylistSnapshot();
    if (!snap || !snap.list.length) return;
    // 内置源 chip 直接回填；扩展源等目录加载完再回填（见 extSources effect）
    if (SEARCH_SOURCES.some((s) => s.key === snap.source)) {
      setSource(snap.source as SearchSourceKey);
    } else if (snap.source) {
      setRestoreListSource(snap.source);
    }
    setKeyword(snap.kw);
    setSearchedKw(snap.kw);
    setList(snap.list);
    setPage(snap.page);
    setHasMore(snap.hasMore);
    setMusicView("playlist");
  }, []);

  // 播放列表本地缓存：列表内容 / 页号变化即写快照（list 为 null 是新请求中或切源清空，
  // 暂不落盘；空结果 [] 则清除旧快照，避免下次刷新错误地恢复上一次的旧列表）
  useEffect(() => {
    if (list === null) return;
    // 缓存恢复的列表来源 chip 尚未回填（lx 目录加载中）时先不重写快照，
    // 等 extSources 就绪后 source 变化会触发本 effect 以正确来源落盘
    if (restoreListSource) return;
    if (list.length === 0) {
      clearPlaylistSnapshot();
      return;
    }
    writePlaylistSnapshot({ kw: searchedKw, source, page, hasMore, list });
  }, [list, searchedKw, source, page, hasMore]);

  const showToast = (kind: "ok" | "err", text: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ kind, text });
    toastTimerRef.current = setTimeout(() => setToast(null), 2500);
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

  // 音频音量 / 静音 / 循环同步
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = muted ? 0 : volume;
    audio.muted = muted;
    audio.loop = loop;
  }, [volume, muted, loop]);

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  // 音量本地缓存：用户每次调整后写入，刷新 / 下次进入时恢复上次的音量
  useEffect(() => {
    try {
      localStorage.setItem("mp-player-volume", String(volume));
    } catch {
      // 隐私模式等写入失败时静默降级，不影响播放
    }
  }, [volume]);

  const resetPlayer = () => {
    directAbortRef.current?.abort();
    lyricAbortRef.current?.abort();
    setPicked(null);
    setCurrentIndex(null);
    setDirect(null);
    setPlaying(false);
    setCoverUrl("");
    setCoverFailed(false);
    setLyricLines(null);
    setLyricRaw("");
    setLyricError("");
    setCurrentTime(0);
    setDuration(0);
    setPlayError("");
  };

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
   * 列表插入；播放 / 下载 / 歌词 / 封面复用搜索结果的同一套链路。网易云链接当前
   * 可直接解析到播放；QQ / 酷狗 / 酷我识别成功但直链引擎未接入时给出引导提示。
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
        // 解析产物平台若与当前搜索源不一致则同步 chip，保证列表平台列 / 图标 / 直链通道一致
        const key = it.source as SearchSourceKey;
        if ((key === "netease" || key === "kuwo" || key === "joox") && key !== source) {
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

  const playTrack = async (item: SearchItem, index: number) => {
    setPicked(item);
    setCurrentIndex(index);
    setDirect(null);
    setFetching(true);
    setCopied(false);
    setPlayError("");
    autoplayRef.current = false;

    directAbortRef.current?.abort();
    const controller = new AbortController();
    directAbortRef.current = controller;

    // 点歌发生在用户手势内，先解锁自动播放
    unlockAutoplay();

    try {
      const data = await requestDirect(
        item.source || source,
        item.urlId || item.id,
        br,
        controller.signal
      );
      if (controller.signal.aborted) return;
      setDirect(data);
      autoplayRef.current = true;
    } catch (err) {
      if (controller.signal.aborted) return;
      const audio = audioRef.current;
      if (audio) {
        audio.pause();
        audio.muted = mutedRef.current;
      }
      setPlayError(
        err instanceof Error && err.message
          ? err.message
          : "未获取到可播放的直链，可能受版权或会员限制，试试其他歌曲或切换音质"
      );
    } finally {
      if (directAbortRef.current === controller) {
        setFetching(false);
        directAbortRef.current = null;
      }
    }
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
      const data = await requestDirect(
        picked.source || source,
        picked.urlId || picked.id,
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
      setDirect(data);
      const okLabel =
        BR_LABEL[String(data.br)] ??
        BR_LABEL[nextBr] ??
        `${nextBr}kbps`;
      showToast("ok", `已切换音质：${okLabel}`);
    } catch (err) {
      if (controller.signal.aborted) return;
      // 失败：回滚档位；若有旧直链则保留它继续播放
      setBr(prevBr);
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "未获取到该音质的直链，可能受版权或会员限制";
      if (hadStream) {
        showToast("err", `音质切换失败，已保持原音质`);
      } else {
        showToast("err", `音质获取失败：${msg}`);
        setPlayError(msg);
      }
    } finally {
      if (directAbortRef.current === controller) {
        setFetching(false);
        directAbortRef.current = null;
      }
    }
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
      goToPage(page + 1).then(() => {
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
    setLyricClosing(false);
    setLyricOpen(true);
  };

  // 整页歌词视图下：Esc 收起、锁定背景滚动
  useEffect(() => {
    if (!lyricOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestCloseLyric();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [lyricOpen, requestCloseLyric]);

  // 歌曲详情弹窗下：Esc 收起、锁定背景滚动
  useEffect(() => {
    if (!infoTrack) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setInfoTrack(null);
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
    try {
      await navigator.clipboard.writeText(direct.url);
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // 复制失败静默
    }
  };

  const switchSource = (next: SearchSourceKey) => {
    if (next === source) return;
    setSource(next);
    setRestoreListSource(null);
    setList(null);
    setHasMore(false);
    setPage(1);
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
    // 直连模式（代理不可用）下同源 bin 字节代理同样会 502，跳过它，仅尝试外部直链取色；
    // 取不到色就回退整页歌词默认配色（不阻断功能）
    const binUrl =
      !picked.picUrlDirect && !!picId && !isDirectUsed()
        ? `/api/music?action=pic&source=${encodeURIComponent(srcName)}` +
          `&id=${encodeURIComponent(picId)}&size=300&bin=1`
        : "";
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

  const renderList = () => {
    if (searching) {
      return (
        <div className="mp-scroll">
          <div className="mp-state">
            <Loader2 className="mp-spin" />
            <p>正在搜索「{searchedKw}」…</p>
          </div>
        </div>
      );
    }
    if (!list) {
      return (
        <div className="mp-scroll">
          <div className="mp-state">
            <Disc3 />
            <p>播放列表还是空的</p>
            <p style={{ fontSize: 12, opacity: 0.75 }}>
              点击左上角「发现歌曲」，搜索歌名 / 歌手，或粘贴歌曲分享链接解析后即可点播
            </p>
          </div>
        </div>
      );
    }
    if (list.length === 0) {
      return (
        <div className="mp-scroll">
          <div className="mp-state">
            <Search />
            <p>没有找到与「{searchedKw}」相关的歌曲</p>
            <p style={{ fontSize: 12, opacity: 0.75 }}>
              换个关键词，或切换音源再试试
            </p>
          </div>
        </div>
      );
    }
    return (
      <>
        <div className="mp-list-head" aria-hidden="true">
          <div className="mp-colhead">
            <span className="mp-ch mp-ch-idx" />
            <span className="mp-ch mp-ch-title">歌名</span>
            <span className="mp-ch mp-ch-artist">作者</span>
            <span className="mp-ch mp-ch-album">专辑</span>
            <span className="mp-ch mp-ch-src">平台</span>
            <span className="mp-ch mp-ch-line">线路</span>
          </div>
        </div>
        <div
          className="mp-scroll mp-list-scroll"
          ref={listTopRef}
          onScroll={handleListScroll}>
          <div className="mp-list">
          {list.map((item, idx) => {
            const isCurrent = currentIndex === idx;
            // 首次取直链（尚无 direct）才展示行内加载动画；
            // 播放中切音质不清空旧直链，保留 eq 动效避免闪烁
            const loadingThis = fetching && isCurrent && !direct;
            const isPlaying = isCurrent && playing;
            const artist = artistText(item);
            const line = musicLineMeta(item.line);
            return (
              <div
                key={`${item.source}-${item.id}`}
                className={cn("mp-row", isCurrent && "is-active")}
                role="button"
                tabIndex={0}
                aria-label={`播放 ${item.name}`}
                onClick={() => playTrack(item, idx)}
                onKeyDown={(e) => {
                  // 仅响应行本体按键，避免行内子控件聚焦时回车误触播放
                  if (e.target !== e.currentTarget) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    playTrack(item, idx);
                  }
                }}>
                <span className="mp-idx">{idx + 1}</span>
                <span className="mp-cell mp-cell-title" title={item.name}>
                  <span className="mp-tt">{item.name}</span>
                  {isCurrent ? (
                    loadingThis ? (
                      <span className="mp-idx-load">
                        <Loader2 className="mp-spin" />
                      </span>
                    ) : (
                      <span className={cn("mp-eq", isPlaying ? "" : "paused")}>
                        <i />
                        <i />
                        <i />
                      </span>
                    )
                  ) : (
                    <span className="mp-hover-play">
                      <Play />
                    </span>
                  )}
                </span>
                <span className="mp-cell mp-cell-artist" title={artist}>
                  {artist}
                </span>
                <span className="mp-cell mp-cell-album" title={item.album || ""}>
                  {item.album || "—"}
                </span>
                <span className="mp-cell mp-cell-src" title={sourceMeta.label}>
                  <PlatformIcon source={source} size={13} />
                  {sourceMeta.label}
                </span>
                <span
                  className={cn("mp-cell", "mp-cell-line", line?.direct && "is-direct")}
                  title={line?.title}>
                  {line ? (
                    <>
                      <i className="mp-line-dot" aria-hidden="true" />
                      <span className="mp-line-text">{line.text}</span>
                    </>
                  ) : (
                    <span className="mp-line-none">—</span>
                  )}
                </span>
              </div>
            );
          })}
        </div>

        {(paging || pageErr || !hasMore) && (
          <div className="mp-loadmore" aria-live="polite">
            {paging ? (
              <>
                <Loader2 className="mp-spin" />
                正在加载更多…
              </>
            ) : pageErr ? (
              <span className="mp-load-err">
                <AlertCircle />
                {pageErr}
              </span>
            ) : (
              <span>已显示全部结果</span>
            )}
          </div>
        )}
        </div>
      </>
    );
  };

  const renderSearchPanel = () => {
    const tags = ["周杰伦", "林俊杰", "陈奕迅", "Beyond", "稻香"];
    const searchMode = mode === "search";
    const switchMode = (next: "search" | "resolve") => {
      if (next === mode) return;
      setMode(next);
      setResolveError("");
      setSearchError("");
    };
    return (
      <div className="mp-scroll">
        <div className="mp-hero">
          <h1>{searchMode ? "发现好音乐" : "链接直达歌曲"}</h1>
          <p className="mp-hero-sub">
            {searchMode
              ? "统一接入多个音源，搜索即试听，一点即下载"
              : "粘贴歌曲分享链接，一步解析成可试听 / 下载的曲目"}
          </p>

          <div className="mp-mode-seg" role="tablist" aria-label="歌曲查找方式">
            <button
              type="button"
              role="tab"
              aria-selected={searchMode}
              className={cn("mp-mode-btn", searchMode && "is-active")}
              onClick={() => switchMode("search")}>
              <Search />
              关键词搜索
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={!searchMode}
              className={cn("mp-mode-btn", !searchMode && "is-active")}
              onClick={() => switchMode("resolve")}>
              <Link2 />
              粘贴链接解析
            </button>
          </div>

          {searchMode ? (
            <>
              <form className="mp-search-big" onSubmit={runSearch}>
                <Search />
                <input
                  value={keyword}
                  onChange={(e) => {
                    setKeyword(e.target.value);
                    if (searchError) setSearchError("");
                  }}
                  placeholder={`在 ${sourceMeta.label} 中搜索歌曲 / 歌手`}
                  autoComplete="off"
                />
                <button
                  type="submit"
                  title="搜索"
                  disabled={searching || !keyword.trim()}>
                  {searching ? <Loader2 className="mp-spin" /> : <Search />}
                </button>
              </form>

              <div className="mp-chiprow">
                {sourceChips.map((s) => {
                  const active = source === s.key;
                  return (
                    <button
                      key={s.key}
                      type="button"
                      onClick={() => switchSource(s.key)}
                      title={s.ext ? `洛雪扩展音源 · ${s.label}` : `切到 ${s.label}`}
                      className={cn(
                        "mp-src-chip",
                        active && "is-active",
                        s.ext && "mp-src-chip-ext"
                      )}
                      style={{ "--sc": s.color } as React.CSSProperties}>
                      {s.ext ? (
                        <span className="dot" aria-hidden="true" />
                      ) : (
                        <PlatformIcon source={s.key} />
                      )}
                      {s.label}
                    </button>
                  );
                })}
              </div>

              {!searching && (
                <div className="mp-tags">
                  {tags.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      className="mp-tag"
                      onClick={() => runSearch(tag)}>
                      {tag}
                    </button>
                  ))}
                </div>
              )}

              {searchError && (
                <div
                  className="mp-error"
                  style={{ width: "min(520px,100%)", marginTop: 14 }}>
                  <AlertCircle />
                  <span>{searchError}</span>
                </div>
              )}
            </>
          ) : (
            <>
              <form className="mp-search-big mp-link-form" onSubmit={runResolve}>
                <Link2 />
                <input
                  value={link}
                  onChange={(e) => {
                    setLink(e.target.value);
                    if (resolveError) setResolveError("");
                  }}
                  placeholder="粘贴歌曲分享链接，如 https://music.163.com/song?id=…"
                  autoComplete="off"
                  spellCheck={false}
                  inputMode="url"
                />
                <button
                  type="submit"
                  title="解析歌曲"
                  disabled={resolving || !link.trim()}>
                  {resolving ? <Loader2 className="mp-spin" /> : <Link2 />}
                </button>
              </form>

              <p className="mp-resolve-tip">
                支持：<strong>网易云音乐</strong> 歌曲链接直接解析播放；
                <span className="dim">
                  QQ音乐 / 酷狗 / 酷我 歌曲链接可识别，直链引擎接入后开放
                </span>
              </p>

              {resolveError && (
                <div
                  className="mp-error"
                  style={{ width: "min(560px,100%)", marginTop: 12 }}>
                  <AlertCircle />
                  <span>{resolveError}</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    );
  };

  const renderCover = () => (
    <div className="mp-artbox">
      <button
        type="button"
        className="mp-artframe mp-artbtn"
        onClick={picked ? openLyricPage : undefined}
        disabled={!picked}
        aria-label={picked ? "打开整页歌词" : undefined}
        title={picked ? "打开整页歌词" : undefined}>
        {coverLoading ? (
          <div className="mp-art-load">
            <Loader2 />
          </div>
        ) : coverUrl && !coverFailed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={coverUrl}
            alt={picked ? picked.name : "专辑封面"}
            onError={() => setCoverFailed(true)}
          />
        ) : (
          <div className="mp-artph">
            <Disc3 />
            <span>{coverFailed ? "封面加载失败" : picked ? "暂无封面" : ""}</span>
          </div>
        )}
        {picked && (
          <span className="mp-art-hint">
            <Maximize2 />
            查看歌词
          </span>
        )}
      </button>
    </div>
  );

  const renderRightPanel = () => (
    <aside className="mp-now">
      <div className="mp-now-flag">
        {picked ? (
          <>
            <span className={cn("mp-eq", playing ? "" : "paused")} style={{ height: 11 }}>
              <i />
              <i />
              <i />
            </span>
            {playing ? "正在播放" : "当前曲目"}
          </>
        ) : (
          "播放器"
        )}
      </div>
      {renderCover()}
      <div className="mp-track-meta">
        <div className="t">{picked ? picked.name : "未在播放"}</div>
        <div className="a">
          {picked
            ? `${artistText(picked)}${picked.album ? ` · ${picked.album}` : ""}`
            : "从左侧列表选择一首歌开始播放"}
        </div>
        {picked && direct && (
          <div className="mp-meta-line">
            <span className="mp-pill good">
              {BR_LABEL[String(direct.br)] ?? `${direct.br}kbps`}
            </span>
            {direct.size && <span className="mp-pill">{formatSize(direct.size)}</span>}
            <span className="mp-pill">
              <PlatformIcon source={source} size={12} />
              {sourceMeta.label}
            </span>
          </div>
        )}
      </div>
      {playError && (
        <div className="mp-play-err" role="alert">
          <AlertCircle />
          <span>{playError}</span>
        </div>
      )}
      <div className="mp-actrow">
        <button
          type="button"
          className="mp-icon-btn"
          disabled={!direct}
          title="复制直链"
          onClick={copyUrl}>
          {copied ? <Check /> : <Copy />}
        </button>
        {direct ? (
          isDirectUsed() ? (
            // 直连模式（代理对上游不可用）：同源 bin 代理同样不可用，改为新标签打开源文件
            <a
              className="mp-icon-btn"
              href={direct.url}
              target="_blank"
              rel="noreferrer"
              title="下载歌曲（直连：新标签页打开源文件后另存）"
              aria-label="下载歌曲">
              <Download />
            </a>
          ) : (
            <a
              className="mp-icon-btn"
              href={`/api/music?${new URLSearchParams({
                source: picked?.source || source,
                id: picked?.urlId || picked?.id || direct.id,
                br,
                bin: "1",
                title: picked?.name || "",
              })}`}
              download
              title="下载歌曲"
              aria-label="下载歌曲">
              <Download />
            </a>
          )
        ) : (
          <button type="button" className="mp-icon-btn" disabled title="下载歌曲">
            <Download />
          </button>
        )}
        {direct && picked && currentIndex != null && (
          <button
            type="button"
            className="mp-icon-btn"
            title="歌曲信息"
            aria-label="查看当前歌曲的详细信息"
            onClick={() => setInfoTrack({ item: picked, index: currentIndex })}>
            <Info />
          </button>
        )}
      </div>
    </aside>
  );

  const renderBottomBar = () => {
    const disabledPrev = !list || currentIndex == null || currentIndex <= 0;
    const disabledNext =
      !list ||
      currentIndex == null ||
      (!hasMore && currentIndex >= (list?.length ?? 0) - 1);
    // 底栏第二行：歌手行在歌词可用时顶替为「当前歌词句」。
    // 歌名已并入主行显示为「歌名 - 歌手」，因此歌词不可用时不丢任何信息。
    const renderMiniLyric = () => {
      if (!picked) {
        return <div className="a">选择一首歌曲开始聆听</div>;
      }
      const active =
        lyricLines && activeLyricIndex >= 0 ? lyricLines[activeLyricIndex] : null;
      const activeText = active && active.text.trim() ? active.text : "";
      if (activeText) {
        return <MiniLyricLine text={activeText} playing={playing} />;
      }
      if (lyricsLoading) {
        return <div className="a">歌词加载中…</div>;
      }
      if (lyricError) {
        return <div className="a">歌词暂不可用</div>;
      }
      // 无歌词，或已拿到歌词但还没播到第一句（前奏）：占位保持双行结构，避免底栏跳动
      return (
        <div className="a">
          {lyricLines && lyricLines.length > 0 ? "· · ·" : "暂无歌词"}
        </div>
      );
    };
    const progGrad = `linear-gradient(to right, var(--mp-primary) 0%, var(--mp-primary) ${progressPercent}%, var(--mp-line) ${progressPercent}%, var(--mp-line) 100%)`;
    const volGrad = `linear-gradient(to right, var(--mp-primary) 0%, var(--mp-primary) ${volumePercent}%, var(--mp-line) ${volumePercent}%, var(--mp-line) 100%)`;
    // 悬停气泡：滑块圆心的横向位置 = 在“去掉圆点宽后的可用区间”内按比例映射，
    // 左右各内缩半个圆点（5.5px）；气泡文字块再根据自身宽度做防溢出位移
    const tipRatio = duration ? currentTime / duration : 0;
    const thumbX = pbarW > 0 ? (pbarW - 11) * tipRatio + 5.5 : null;
    let tipDx: number | null = null;
    if (thumbX != null && pbarW > 0 && tipBubbleW > 0) {
      const lo = 4 - thumbX;
      const hi = pbarW - tipBubbleW - 4 - thumbX;
      tipDx = Math.min(Math.max(-tipBubbleW / 2, lo), hi);
    }
    // 进度条命中层（.mp-pbar-hit）统一把指针横向位置换算为播放时间并 seek。
    // 这样点击/拖动不再受原生 range 3px 细条热区限制，按“加粗后”的整块区域触发。
    const seekToClientX = (clientX: number) => {
      const el = pbarRef.current;
      if (!el || !duration) return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      seek(ratio * duration);
    };
    // 底栏空白区域（曲目信息列留白 / 三栏间隙等）点击也唤起整页歌词；
    // 命中交互控件（按钮 / 滑杆 / 音质选择器等）时不触发，避免误开歌词页。
    const openLyricFromBlank = (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as Element;
      if (
        target.closest(
          "button, a, input, select, textarea, [role='slider'], .mp-brp"
        )
      ) {
        return;
      }
      openLyricPage();
    };
    return (
      <div className="mp-player">
        <div
          ref={pbarRef}
          className={cn("mp-pbar", progHover && "is-hot")}
          style={{ "--mp-prog": progGrad } as React.CSSProperties}
          onMouseEnter={() => setProgHover(true)}
          onMouseLeave={() => setProgHover(false)}>
          {/* 原生 range 仅保留可视轨道/滑块与键盘操作；鼠标/触屏由 .mp-pbar-hit 接管 */}
          <input
            type="range"
            className="mp-progress"
            min={0}
            max={duration || 100}
            step={0.1}
            value={currentTime}
            disabled={!duration}
            onInput={(e) => seek(Number(e.currentTarget.value))}
            aria-label="播放进度"
          />
          {/* 命中层：高度扩到“悬停加粗后”的区域，进入该区即可触发加粗/气泡，点按即 seek */}
          <div
            className="mp-pbar-hit"
            aria-hidden="true"
            onMouseEnter={() => setProgHover(true)}
            onMouseLeave={() => setProgHover(false)}
            onPointerDown={(e) => {
              if (!duration) return;
              setSeeking(true);
              e.currentTarget.setPointerCapture?.(e.pointerId);
              seekToClientX(e.clientX);
            }}
            onPointerMove={(e) => {
              if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
                seekToClientX(e.clientX);
              }
            }}
            onPointerUp={() => setSeeking(false)}
            onPointerCancel={() => setSeeking(false)}
            onLostPointerCapture={() => setSeeking(false)}
          />
          {progHover && picked && duration > 0 && (
            <span
              className="mp-prog-tip"
              style={{ left: thumbX != null ? `${thumbX}px` : `${progressPercent}%` }}>
              <span
                ref={tipBubbleRef}
                className="mp-prog-tip-box"
                style={
                  tipDx != null ? { transform: `translateX(${tipDx}px)` } : undefined
                }>
                <span className="mp-prog-tip-cur">
                  {formatTime(currentTime)}
                </span>
                <span className="mp-prog-tip-sep">/</span>
                <span className="mp-prog-tip-dur">
                  {formatTime(duration)}
                </span>
              </span>
              <span className="mp-prog-tip-arrow" />
            </span>
          )}
        </div>
        <div className="mp-prow" onClick={openLyricFromBlank}>
          <div className="mp-ptrack">
            <button
              type="button"
              className="mp-thumbbtn"
              onClick={openLyricPage}
              disabled={!picked}
              aria-label="打开整页歌词"
              title={picked ? "打开整页歌词" : "选择歌曲后可打开整页歌词"}>
              <span className="mp-thumb">
                {coverUrl && !coverFailed ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={coverUrl} alt="" />
                ) : (
                  <span className="mp-thumb ph">
                    <Music2 />
                  </span>
                )}
              </span>
              <span className="mplp-badge">
                <Maximize2 />
              </span>
            </button>
            <div className="c">
              <div
                className="t"
                title={picked ? `${picked.name} - ${artistText(picked)}` : undefined}>
                {picked ? `${picked.name} - ${artistText(picked)}` : "未在播放"}
              </div>
              {renderMiniLyric()}
            </div>
          </div>

          <div className="mp-ctrls">
            <button
              type="button"
              className="mp-icon-btn"
              onClick={playPrev}
              disabled={disabledPrev}
              title="上一首">
              <SkipBack fill="currentColor" />
            </button>
            <button
              type="button"
              className="mp-play"
              onClick={togglePlay}
              disabled={!direct}
              title={
                !direct && playError
                  ? `直链获取失败：${playError}`
                  : playing
                    ? "暂停"
                    : "播放"
              }>
              {playing ? (
                <Pause fill="currentColor" />
              ) : (
                <Play fill="currentColor" style={{ marginLeft: 2 }} />
              )}
            </button>
            <button
              type="button"
              className="mp-icon-btn"
              onClick={playNext}
              disabled={disabledNext}
              title="下一首">
              <SkipForward fill="currentColor" />
            </button>
            <button
              type="button"
              className={cn("mp-icon-btn", loop && "on")}
              onClick={() => setLoop((v) => !v)}
              title={loop ? "单曲循环已开启" : "单曲循环"}>
              <Repeat />
            </button>
            <BrPicker
              options={BR_OPTIONS}
              value={br}
              loading={fetching && !!picked}
              disabled={!picked}
              onSelect={switchQuality}
            />
          </div>

          <div className="mp-ptime">
            <div className="mp-vol">
              <button
                type="button"
                className={cn("mp-icon-btn", (muted || volume === 0) && "on")}
                onClick={() => setMuted((m) => !m)}
                title={muted ? "取消静音" : "静音"}
                style={{ width: 24, height: 24 }}>
                {muted || volume === 0 ? <VolumeX /> : <Volume2 />}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                onInput={(e) => {
                  const v = Number(e.currentTarget.value);
                  setVolume(v);
                  if (v > 0) setMuted(false);
                }}
                style={{ "--mp-prog": volGrad } as React.CSSProperties}
                aria-label="音量"
              />
            </div>
            <span
              className="mp-volpct"
              title={muted || volume === 0 ? "已静音" : "当前音量"}
              aria-label="当前音量">
              {Math.round((muted ? 0 : volume) * 100)}%
            </span>
          </div>
        </div>
      </div>
    );
  };

  // 歌曲详情弹窗：行内「详情」按钮触发，展示歌名 / 歌手 / 专辑 / 时长、
  // 音质 / 文件大小与歌词、封面、直链等运行时信息（播放当前歌曲前多为占位）
  const renderTrackInfo = () => {
    if (!infoTrack) return null;
    const { item, index } = infoTrack;
    const isCurrent = currentIndex === index && picked?.id === item.id;
    const artist = artistText(item);

    /** 选择并播放后才能拿到的字段，统一占位提示 */
    const pending = (
      <span
        className="mp-info-pending"
        title="选中这首歌曲并播放后，即可获取对应数据">
        播放后获取
      </span>
    );

    /** 播放音质文案：与音质选择器/下载文件命名同源（标准=码率，无损=位深） */
    const qualityText = (br: number) => {
      const opt = BR_OPTIONS.find((o) => o.value === String(br));
      if (!opt) return `${br}kbps`;
      const { group, label } = opt;
      return group === "lossless"
        ? `${BR_GROUP_LABEL.lossless} · ${label.replace("无损 ", "")}`
        : `${BR_GROUP_LABEL.standard} · ${label}`;
    };

    const live = isCurrent && !!direct && !!direct.url;
    const durationText = isCurrent && duration > 0 ? formatTime(duration) : null;
    const sizeText = live && direct?.size ? formatSize(direct.size) : null;
    const brValue = live && direct ? direct.br : null;

    // —— 播放音质
    let qualityNode: React.ReactNode = pending;
    if (isCurrent) {
      if (fetching && !direct) {
        qualityNode = (
          <span className="mp-info-loading">
            <Loader2 className="mp-spin" />
            解析音质中…
          </span>
        );
      } else if (brValue) {
        qualityNode = <span className="mp-info-strong">{qualityText(brValue)}</span>;
      }
    }

    // —— 歌词链接：歌词抓取就绪后展示得到的 LRC 文件，整行超链接点击即可下载
    const lyricSongId = item.lyricId || (isCurrent ? item.id : "");
    const lyricUrl = lyricSongId
      ? (() => {
          switch (source) {
            case "netease":
              return `https://music.163.com/song?id=${lyricSongId}`;
            case "kuwo":
              return `https://www.kuwo.cn/play_detail/${lyricSongId}`;
            case "joox":
              return `https://www.joox.com/single/${lyricSongId}`;
            default:
              return "";
          }
        })()
      : "";
    /** 用合法文件名形式拼出「歌手 - 歌名.lrc」 */
    const safeName = (s: string) =>
      s
        .replace(/[\\/:*?"<>|\r\n]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const lrcFileName = `${safeName(artist)} - ${safeName(item.name)}.lrc`;
    let lyricNode: React.ReactNode = pending;
    if (!lyricSongId) {
      lyricNode = <span className="mp-info-dim">无歌词资源</span>;
    } else if (isCurrent) {
      if (lyricsLoading) {
        lyricNode = (
          <span className="mp-info-loading">
            <Loader2 className="mp-spin" />
            解析歌词中…
          </span>
        );
      } else if (lyricRaw) {
        lyricNode = lyricBlobUrl ? (
          <a
            className="mp-info-link mp-info-lrc"
            href={lyricBlobUrl}
            download={lrcFileName}
            title={`点击下载歌词文件 ${lrcFileName}`}>
            <Download size={13} />
            {lrcFileName}
          </a>
        ) : (
          <span className="mp-info-strong">
            已就绪 · {lyricLines?.length ?? 0} 行歌词
          </span>
        );
      } else if (lyricError) {
        lyricNode = <span className="mp-info-dim">歌词获取失败</span>;
      } else {
        lyricNode = <span className="mp-info-dim">暂无歌词</span>;
      }
    }

    // —— 封面链接：当前歌曲封面就绪后可新标签打开大图
    let coverNode: React.ReactNode = pending;
    if (isCurrent) {
      if (coverLoading) {
        coverNode = (
          <span className="mp-info-loading">
            <Loader2 className="mp-spin" />
            封面加载中…
          </span>
        );
      } else if (coverUrl && !coverFailed) {
        coverNode = (
          <a
            className="mp-info-link"
            href={coverUrl}
            target="_blank"
            rel="noreferrer">
            查看封面图片
          </a>
        );
      } else {
        coverNode = (
          <span className="mp-info-dim">{coverFailed ? "封面加载失败" : "暂无封面"}</span>
        );
      }
    }

    // —— 歌曲链接：直链就绪后可复制 / 新标签打开
    let songNode: React.ReactNode = pending;
    if (live) {
      songNode = (
        <span className="mp-info-songrow">
          <a
            className="mp-info-url"
            href={direct.url}
            target="_blank"
            rel="noreferrer"
            title={direct.url}>
            {direct.url}
          </a>
          <button
            type="button"
            className="mp-info-copy"
            onClick={copyUrl}
            aria-label="复制歌曲直链"
            title="复制歌曲直链">
            {copied ? <Check /> : <Copy />}
          </button>
        </span>
      );
    }

    const fieldRows: { label: string; value: React.ReactNode }[] = [
      {
        label: "歌名",
        value: <span className="mp-info-strong">{item.name}</span>,
      },
      { label: "歌手", value: artist },
      { label: "专辑", value: item.album || "未知专辑" },
      { label: "时长", value: durationText ?? pending },
      {
        label: "来源",
        value: (
          <span className="mp-pill">
            <PlatformIcon source={source} size={13} />
            {sourceMeta.label}
          </span>
        ),
      },
      { label: "文件大小", value: sizeText ?? pending },
      { label: "歌曲 ID", value: <code>{item.id}</code> },
      { label: "播放音质", value: qualityNode },
      { label: "歌词链接", value: lyricNode },
      { label: "封面链接", value: coverNode },
      { label: "歌曲链接", value: songNode },
    ];

    // —— 底部「复制歌曲信息」输出的纯文本：占位语义与上方字段一致
    const txPending = "[播放后获取]";
    let lyricCopy = txPending;
    if (!lyricSongId) {
      lyricCopy = "无歌词资源";
    } else if (isCurrent && lyricRaw) {
      lyricCopy = lyricUrl || `已就绪 · ${lyricLines?.length ?? 0} 行歌词`;
    } else if (isCurrent && lyricError) {
      lyricCopy = "歌词获取失败";
    }
    let coverCopy = txPending;
    if (isCurrent) {
      if (coverUrl && !coverFailed) {
        coverCopy = coverUrl;
      } else if (coverFailed) {
        coverCopy = "封面加载失败";
      } else if (!item.picId) {
        coverCopy = "暂无封面";
      }
    }
    const infoTextLines = [
      `歌名：${item.name}`,
      `歌手：${artist}`,
      `专辑：${item.album || "未知专辑"}`,
      `时长：${durationText ?? txPending}`,
      `来源：${sourceMeta.label}`,
      `文件大小：${sizeText ?? txPending}`,
      `歌曲ID：${item.id}`,
      `播放音质：${brValue ? qualityText(brValue) : txPending}`,
      `歌词链接：${lyricCopy}`,
      `封面链接：${coverCopy}`,
      `歌曲链接：${live ? direct!.url : txPending}`,
    ].join("\n");

    const copyInfoText = async () => {
      if (infoCopyTimerRef.current) clearTimeout(infoCopyTimerRef.current);
      try {
        await navigator.clipboard.writeText(infoTextLines);
        setInfoCopied(true);
        showToast("ok", "歌曲信息已复制");
        infoCopyTimerRef.current = setTimeout(() => setInfoCopied(false), 2000);
      } catch {
        showToast("err", "复制失败，请重试");
      }
    };

    return (
      <div
        className="mp-info-mask"
        role="presentation"
        onMouseDown={(e) => {
          // 点击遮罩空白处关闭（卡片自身冒泡会被下面 stopPropagation 拦下）
          if (e.target === e.currentTarget) setInfoTrack(null);
        }}>
        <div
          className="mp-info-card"
          role="dialog"
          aria-modal="true"
          aria-label={`歌曲详情：${item.name}`}
          onMouseDown={(e) => e.stopPropagation()}>
          <div className="mp-info-head">
            <div className="mp-info-headtext">
              <span className="mp-info-caption">歌曲详情</span>
              <button
                type="button"
                className="mp-info-close"
                onClick={() => setInfoTrack(null)}
                aria-label="关闭详情"
                title="关闭">
                <X />
              </button>
            </div>
          </div>

          <div className="mp-info-fields">
            {fieldRows.map((row) => (
              <div className="mp-info-row" key={row.label}>
                <span className="mp-info-k">{row.label}</span>
                <span className="mp-info-v">{row.value}</span>
              </div>
            ))}
          </div>

          <div className="mp-info-foot">
            <button
              type="button"
              className="mp-info-copybtn"
              onClick={copyInfoText}
              aria-label="复制歌曲信息"
              title="将歌曲信息复制到剪贴板">
              {infoCopied ? <Check /> : <Copy />}
              {infoCopied ? "已复制歌曲信息" : "复制歌曲信息"}
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderLyricPage = () => {
    if (!lyricOpen || !picked) return null;
    const disabledPrev = !list || currentIndex == null || currentIndex <= 0;
    const disabledNext =
      !list ||
      currentIndex == null ||
      (!hasMore && currentIndex >= (list?.length ?? 0) - 1);
    const progGrad = `linear-gradient(to right, var(--mp-primary) 0%, var(--mp-primary) ${progressPercent}%, var(--mp-line) ${progressPercent}%, var(--mp-line) 100%)`;
    const volGrad = `linear-gradient(to right, var(--mp-primary) 0%, var(--mp-primary) ${muted ? 0 : volumePercent}%, var(--mp-line) ${muted ? 0 : volumePercent}%, var(--mp-line) 100%)`;
    type MpCssVars = React.CSSProperties & Record<`--mplp-${string}`, string>;
    const palVars: MpCssVars = palette
      ? {
          "--mplp-c1": palette.c1,
          "--mplp-c2": palette.c2,
          "--mplp-fg": palette.fg,
          "--mplp-fg-soft": palette.fgSoft,
          "--mplp-fg-dim": palette.fgDim,
          "--mplp-glass": palette.glass,
          "--mplp-glass-hi": palette.glassHi,
          "--mplp-line": palette.line,
          "--mplp-line-strong": palette.lineStrong,
          "--mplp-accent": palette.accent,
          "--mplp-accent-bg": palette.accentBg,
          "--mplp-hover": palette.hover,
          "--mplp-play-ink": palette.playInk,
        }
      : {};

    // 收起：与“点底栏空白展开”形成往返呼应——整页歌词铺满时，主底栏不可点，
    // 因此在歌词页最底部划一条与底栏等高的“空带”，点空白处即沿来路回落收起。
    // 仅命中视口最底 ~78px 且未落在任何控件/歌词正文（左信息列、右歌词列等）上才生效，
    // 避免点击歌词行跳转、拖进度条时误收起。
    const closeLyricFromBottom = (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as Element;
      if (
        target.closest(
          "button, a, input, select, textarea, [role='slider'], .mplp-left, .mplp-right"
        )
      ) {
        return;
      }
      const vh = window.innerHeight || document.documentElement.clientHeight;
      if (e.clientY < vh - 78) return;
      requestCloseLyric();
    };

    return (
      <div
        className={cn(
          "mp-lyricpage",
          palette && "has-palette",
          lyricClosing && "is-closing",
          !playing && "is-vinyl-paused"
        )}
        role="dialog"
        aria-modal="true"
        aria-hidden={lyricClosing || undefined}
        onClick={closeLyricFromBottom}
        aria-label={`${picked.name} 整页歌词`}
        style={{ "--mp-acc": sourceMeta.color, ...palVars } as React.CSSProperties}>
        <div
          className="mplp-bg"
          style={{
            backgroundImage:
              coverUrl && !coverFailed ? `url(${coverUrl})` : "none",
          }}
        />
        <div className="mplp-accent" />

        <div className="mplp-head">
          <button
            type="button"
            className="mplp-collapse"
            onClick={requestCloseLyric}
            aria-label="收起整页歌词"
            title="收起歌词">
            <ChevronDown />
          </button>
        </div>

        <div className="mplp-body">
          <div className="mplp-left">
            <div className="mplp-cover">
              {coverUrl && !coverFailed ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={coverUrl}
                  alt={picked.name}
                  onError={() => setCoverFailed(true)}
                />
              ) : (
                <div className="ph">
                  <Disc3 />
                </div>
              )}
            </div>
            <div className="mplp-info">
              <div className="t">{picked.name}</div>
              <div className="a">
                {artistText(picked)}
                {picked.album ? ` · ${picked.album}` : ""}
              </div>
            </div>
            <div className="mplp-progress">
              <input
                type="range"
                className="mp-progress"
                min={0}
                max={duration || 100}
                step={0.1}
                value={currentTime}
                disabled={!duration}
                onMouseDown={() => setSeeking(true)}
                onMouseUp={() => setSeeking(false)}
                onTouchStart={() => setSeeking(true)}
                onTouchEnd={() => setSeeking(false)}
                onInput={(e) => seek(Number(e.currentTarget.value))}
                style={{ "--mp-prog": progGrad } as React.CSSProperties}
                aria-label="播放进度"
              />
              <div className="mplp-times">
                <span>{formatTime(currentTime)}</span>
                <span>{formatTime(duration)}</span>
              </div>
            </div>
            <div className="mp-ctrls mplp-ctrls">
              <button
                type="button"
                className="mp-icon-btn"
                onClick={playPrev}
                disabled={disabledPrev}
                title="上一首">
                <SkipBack fill="currentColor" />
              </button>
              <button
                type="button"
                className="mp-play"
                onClick={togglePlay}
                disabled={!direct}
                title={
                  !direct && playError
                    ? `直链获取失败：${playError}`
                    : playing
                      ? "暂停"
                      : "播放"
                }>
                {playing ? (
                  <Pause fill="currentColor" />
                ) : (
                  <Play fill="currentColor" style={{ marginLeft: 2 }} />
                )}
              </button>
              <button
                type="button"
                className="mp-icon-btn"
                onClick={playNext}
                disabled={disabledNext}
                title="下一首">
                <SkipForward fill="currentColor" />
              </button>
              <button
                type="button"
                className={cn("mp-icon-btn", loop && "on")}
                onClick={() => setLoop((v) => !v)}
                title={loop ? "单曲循环已开启" : "单曲循环"}>
                <Repeat />
              </button>
              <div className="mplp-vol">
                <button
                  type="button"
                  className={cn("mp-icon-btn", (muted || volume === 0) && "on")}
                  onClick={() => setMuted((m) => !m)}
                  aria-label={muted ? "取消静音" : "静音"}
                  aria-pressed={muted}
                  title={muted ? "取消静音" : "静音"}>
                  {muted || volume === 0 ? <VolumeX /> : <Volume2 />}
                </button>
                <div className="mplp-volpop" role="group" aria-label="音量调节">
                  <span className="mplp-volbar">
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={muted ? 0 : volume}
                      onInput={(e) => {
                        const v = Number(e.currentTarget.value);
                        setVolume(v);
                        if (v > 0) setMuted(false);
                      }}
                      style={{ "--mp-prog": volGrad } as React.CSSProperties}
                      aria-label="音量"
                    />
                  </span>
                  <span className="mplp-volpct">
                    {Math.round((muted ? 0 : volume) * 100)}%
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="mplp-right">
            <LyricScroller
              lines={lyricLines ?? []}
              loading={lyricsLoading}
              error={lyricError}
              hasRaw={Boolean(lyricRaw)}
              activeIndex={activeLyricIndex}
              large
              onSeek={seek}
            />
          </div>
        </div>
      </div>
    );
  };

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
          {tab === "search" ? renderSearchPanel() : renderList()}
        </main>
        {tab !== "search" && (
          <aside className="mp-side">{renderRightPanel()}</aside>
        )}
      </div>

      {/* 底部播放控制条 */}
      {renderBottomBar()}

      <audio
        ref={audioRef}
        preload="metadata"
        src={direct?.url}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={handleEnded}
        onTimeUpdate={(e) => !seeking && setCurrentTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
        onDurationChange={(e) => setDuration(e.currentTarget.duration || 0)}
        className="sr-only"
      />

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

      {/* 整页歌词：点击底部播放栏的歌曲封面触发，可点带时间轴的行跳转 */}
      {renderLyricPage()}
    </div>
  );
}
