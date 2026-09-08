"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  ChevronDown,
  Copy,
  Disc3,
  Download,
  Info,
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
  requestDirect,
  requestLyric,
  requestPic,
  requestSearchPage,
  type DirectData,
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
  const [keyword, setKeyword] = useState("");
  const [list, setList] = useState<SearchItem[] | null>(null);
  const [searchedKw, setSearchedKw] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");

  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [paging, setPaging] = useState(false);
  const [pageErr, setPageErr] = useState("");

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
  const [volume, setVolume] = useState(0.8);
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
  /** 歌曲详情弹窗：记录行内点击「详情」的歌曲及其在列表中的位置 */
  const [infoTrack, setInfoTrack] = useState<{ item: SearchItem; index: number } | null>(
    null
  );
  /** 轻提示（音质切换成功 / 失败等），2.5s 自动消失 */
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const searchAbortRef = useRef<AbortController | null>(null);
  const directAbortRef = useRef<AbortController | null>(null);
  const coverAbortRef = useRef<AbortController | null>(null);
  const paletteAbortRef = useRef<AbortController | null>(null);
  const lyricAbortRef = useRef<AbortController | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const infoCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  const sourceMeta =
    SEARCH_SOURCES.find((s) => s.key === source) ?? SEARCH_SOURCES[0];

  useEffect(() => {
    return () => {
      searchAbortRef.current?.abort();
      directAbortRef.current?.abort();
      coverAbortRef.current?.abort();
      lyricAbortRef.current?.abort();
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      if (infoCopyTimerRef.current) clearTimeout(infoCopyTimerRef.current);
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

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
      setList(data.items || []);
      setPage(data.page || 1);
      setHasMore(Boolean(data.hasMore));
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

  /** 追加加载下一页：结果累积进 list，配合下拉触底自动翻页，滚动位置不变 */
  const goToPage = async (targetPage: number) => {
    if (!searchedKw || searching || targetPage < 1 || pagingRef.current) return;
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

  // 点击底部播放栏的歌曲封面 → 整页歌词
  const openLyricPage = () => {
    if (picked) setLyricOpen(true);
  };

  // 整页歌词视图下：Esc 收起、锁定背景滚动
  useEffect(() => {
    if (!lyricOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLyricOpen(false);
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [lyricOpen]);

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
    if (!picId) return;

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
    if (!picId) return;
    const srcName = picked.source || source;
    const binUrl =
      `/api/music?action=pic&source=${encodeURIComponent(srcName)}` +
      `&id=${encodeURIComponent(picId)}&size=300&bin=1`;
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
              点击左上角「发现歌曲」，搜索歌名或歌手即可在线点播
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
    return (
      <div className="mp-scroll">
        <div className="mp-hero">
          <h1>发现好音乐</h1>
          <p className="mp-hero-sub">统一接入多个音源，搜索即试听，一点即下载</p>
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
            {SEARCH_SOURCES.map((s) => {
              const active = source === s.key;
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => switchSource(s.key)}
                  className={cn("mp-src-chip", active && "is-active")}
                  style={{ "--sc": s.color } as React.CSSProperties}>
                  <PlatformIcon source={s.key} />
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
            <div className="mp-error" style={{ width: "min(520px,100%)", marginTop: 14 }}>
              <AlertCircle />
              <span>{searchError}</span>
            </div>
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
    return (
      <div className="mp-player">
        <div
          ref={pbarRef}
          className="mp-pbar"
          onMouseEnter={() => setProgHover(true)}
          onMouseLeave={() => setProgHover(false)}>
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
                {formatTime(currentTime)}
              </span>
              <span className="mp-prog-tip-arrow" />
            </span>
          )}
        </div>
        <div className="mp-prow">
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
              <div className="t">{picked ? picked.name : "未在播放"}</div>
              <div className="a">{picked ? artistText(picked) : "选择一首歌曲开始聆听"}</div>
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
            <span className="total">{formatTime(duration)}</span>
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

    return (
      <div
        className={cn("mp-lyricpage", palette && "has-palette")}
        role="dialog"
        aria-modal="true"
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
            onClick={() => setLyricOpen(false)}
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
