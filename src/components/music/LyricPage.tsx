"use client";

import type { CSSProperties, Dispatch, MouseEvent, RefObject, SetStateAction } from "react";
import { ChevronDown, Disc3, Pause, Play, Repeat, SkipBack, SkipForward, Volume2, VolumeX } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatTime } from "@/components/music/types";
import type { CoverPalette } from "@/lib/cover-palette";
import { MarqueeText } from "./marquee";
import AmllLyricView from "./AmllLyricView";
import AmllBackground from "./AmllBackground";
import { EMPTY_LRC_LINES } from "./lyric-amll";
import type { LyricLine } from "./lyric-utils";
import type { AmllRichResult } from "./ttml-amll";
import type { DirectData, SearchItem } from "@/lib/music-client";
import IconButton from "./icon-btn";

/** 整页歌词的调色板 CSS 变量（限定 mplp-* 前缀，防止污染页面） */
type MpCssVars = CSSProperties & Record<`--mplp-${string}`, string>;

/**
 * 当前文字是浅色（浅字深底）还是深色（深字浅底）——决定动态背景
 * 上「可读性纱幕」压暗还是提亮：浅字配深色纱幕，深字配浅色纱幕，
 * 使任意明暗的流动封面画面都收敛到当前配色所需的对比区间。
 * 无调色板时页面回退为「深底白字」，按浅字处理。
 */
function paletteFgIsLight(palette: CoverPalette | null): boolean {
  if (!palette) return true;
  const m = /^rgb\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(palette.fg);
  if (!m) return true;
  return 0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3] > 140;
}

export interface LyricPageProps {
  open: boolean;
  closing: boolean;
  picked: SearchItem | null;
  playing: boolean;
  direct: DirectData | null;
  playError: string | null;
  list: SearchItem[] | null;
  currentIndex: number | null;
  hasMore: boolean;
  duration: number;
  currentTime: number;
  volume: number;
  volumePercent: number;
  muted: boolean;
  loop: boolean;
  npViewCover: boolean;
  coverUrl: string | null;
  coverFailed: boolean;
  lyricLines: LyricLine[] | null;
  lyricsLoading: boolean;
  lyricError: string | null;
  lyricRaw: string | null;
  /** AMLL 词库逐字行：命中时整页歌词改用真逐字渲染（含翻译），否则 LRC 估算 */
  amllRich?: AmllRichResult | null;
  accentColor: string;
  palette: CoverPalette | null;
  isMobile: boolean;
  lyricPageRef: RefObject<HTMLDivElement | null>;
  artistText: (item: SearchItem) => string;
  requestClose: () => void;
  togglePlay: () => void;
  playPrev: () => void;
  playNext: () => void;
  seek: (t: number) => void;
  setSeeking: Dispatch<SetStateAction<boolean>>;
  setLoop: Dispatch<SetStateAction<boolean>>;
  setMuted: Dispatch<SetStateAction<boolean>>;
  setVolume: (v: number) => void;
  setNpViewCover: Dispatch<SetStateAction<boolean>>;
  onCoverError: () => void;
}

/**
 * 整页歌词视图：桌面端可点带时间轴的行跳进度；移动端进度条以上非按钮区点击
 * 即在 唱片 ↔ 歌词 两个视图间切换，不再点歌词行跳进度。
 */
export default function LyricPage({
  open,
  closing,
  picked,
  playing,
  direct,
  playError,
  list,
  currentIndex,
  hasMore,
  duration,
  currentTime,
  volume,
  volumePercent,
  muted,
  loop,
  npViewCover,
  coverUrl,
  coverFailed,
  lyricLines,
  lyricsLoading,
  lyricError,
  lyricRaw,
  amllRich = null,
  accentColor,
  palette,
  isMobile,
  lyricPageRef,
  artistText,
  requestClose,
  togglePlay,
  playPrev,
  playNext,
  seek,
  setSeeking,
  setLoop,
  setMuted,
  setVolume,
  setNpViewCover,
  onCoverError,
}: LyricPageProps) {
  if (!open || !picked) return null;
  // 动态背景是否生效：决定是否挂载 AMLL 画布、叠加纱幕并切换歌词普通混合
  const dynOn = Boolean(coverUrl) && !coverFailed;
  const dynScheme = paletteFgIsLight(palette) ? "mplp-dyn-night" : "mplp-dyn-day";
  const disabledPrev = !list || currentIndex == null || currentIndex <= 0;
  const disabledNext =
    !list ||
    currentIndex == null ||
    (!hasMore && currentIndex >= (list?.length ?? 0) - 1);
  const progPct = duration ? (currentTime / duration) * 100 : 0;
  const progGrad = `linear-gradient(to right, var(--mp-primary) 0%, var(--mp-primary) ${progPct}%, var(--mp-line) ${progPct}%, var(--mp-line) 100%)`;
  const volPct = muted ? 0 : volumePercent;
  const volGrad = `linear-gradient(to right, var(--mp-primary) 0%, var(--mp-primary) ${volPct}%, var(--mp-line) ${volPct}%, var(--mp-line) 100%)`;
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
  const closeLyricFromBottom = (e: MouseEvent<HTMLDivElement>) => {
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
    requestClose();
  };

  // 移动端：进度条以上的“非按钮区”（封面、歌词正文/空态、头部中置信息等）点击即
  // 在 唱片 ↔ 歌词 两个视图间切换，不再区分“封面/空白/歌词行”。真正的按钮/表单
  // 控件与进度条、控制钮所在区域除外，避免点按钮、拖进度、调音量时误切换。
  const toggleCoverViewOnTap = (e: MouseEvent<HTMLDivElement>) => {
    if (!isMobile || closing) return;
    const target = e.target as Element;
    if (
      target.closest(
        "button, a, input, select, textarea, [role='slider'], .mplp-progress, .mplp-times, .mplp-ctrls, .mplp-vol"
      )
    ) {
      return;
    }
    // 几何判定：仅对“进度条顶部以上”的点击生效（y 小于进度条顶边即视为上方区域）
    const bar = lyricPageRef.current?.querySelector<HTMLElement>(".mplp-progress");
    if (!bar) return;
    const barTop = bar.getBoundingClientRect().top;
    if (e.clientY >= barTop) return;
    setNpViewCover((v) => !v);
  };

  return (
    <div
      ref={lyricPageRef}
      className={cn(
        "mp-lyricpage",
        palette && "has-palette",
        closing && "is-closing",
        !playing && "is-vinyl-paused",
        npViewCover ? "np-view-cover" : "np-view-lyric",
        dynOn && "mplp-dynbg",
        dynOn && dynScheme
      )}
      role="dialog"
      aria-modal="true"
      aria-hidden={closing || undefined}
      onClick={(e) => {
        closeLyricFromBottom(e);
        toggleCoverViewOnTap(e);
      }}
      aria-label={`${picked.name} 正在播放`}
      style={{ "--mp-acc": accentColor, ...palVars } as CSSProperties}>
      <div
        className="mplp-bg"
        style={{
          backgroundImage: coverUrl && !coverFailed ? `url(${coverUrl})` : "none",
        }}
      />
      {/* AMLL 封面动态背景：封面可用时用 BackgroundRender 把封面做成
          旋转 + 多级模糊的流动画布。首帧/加载中保持透明，由下方
          mplp-bg 或调色渐变兜底；换歌只走 setAlbum 内部淡入淡出。 */}
      {coverUrl && !coverFailed && (
        <AmllBackground
          coverUrl={coverUrl}
          fps={isMobile ? 18 : 30}
          renderScale={isMobile ? 0.35 : 0.5}
        />
      )}
      <div className="mplp-accent" />

      <div className="mplp-head">
        <button
          type="button"
          className="mplp-collapse"
          onClick={requestClose}
          aria-label="收起正在播放页"
          title="收起">
          <ChevronDown />
        </button>
        {/* 移动端头部：中置曲目信息，右侧切换 唱片/歌词 视图（桌面端隐藏） */}
        <div className="mplp-head-meta" aria-hidden="true">
          <span className="t">{picked.name}</span>
          <span className="a">
            {artistText(picked)}
            {picked.album ? ` · ${picked.album}` : ""}
          </span>
        </div>
        <button
          type="button"
          className="mplp-viewbtn"
          onClick={() => setNpViewCover((v) => !v)}
          aria-pressed={!npViewCover}
          aria-label={npViewCover ? "切换到歌词" : "切换到唱片"}
          title={npViewCover ? "查看歌词" : "查看唱片"}>
          {npViewCover ? <span className="txt">词</span> : <Disc3 />}
        </button>
      </div>

      <div className="mplp-body">
        <div className="mplp-left">
          {/* 点击切换统一由 lyricpage 根节点的 toggleCoverViewOnTap 处理 */}
          <div className="mplp-cover">
            {coverUrl && !coverFailed ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={coverUrl} alt={picked.name} onError={onCoverError} />
            ) : (
              <div className="ph">
                <Disc3 />
              </div>
            )}
          </div>
          <div className="mplp-info">
            {/* 移动端超长歌名/歌手走无缝跑马灯；桌面端维持原静态截断 */}
            <MarqueeText text={picked.name} className="t" animate={isMobile} />
            <MarqueeText
              text={`${artistText(picked)}${picked.album ? ` · ${picked.album}` : ""}`}
              className="a"
              animate={isMobile}
            />
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
              style={{ "--mp-prog": progGrad } as CSSProperties}
              aria-label="播放进度"
            />
            <div className="mplp-times">
              <span>{formatTime(currentTime)}</span>
              <span>{formatTime(duration)}</span>
            </div>
          </div>
          <div className="mp-ctrls mplp-ctrls">
            <IconButton onClick={playPrev} disabled={disabledPrev} title="上一首">
              <SkipBack fill="currentColor" />
            </IconButton>
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
            <IconButton onClick={playNext} disabled={disabledNext} title="下一首">
              <SkipForward fill="currentColor" />
            </IconButton>
            <IconButton
              active={loop}
              onClick={() => setLoop((v) => !v)}
              title={loop ? "单曲循环已开启" : "单曲循环"}>
              <Repeat />
            </IconButton>
            <div className="mplp-vol">
              <IconButton
                active={muted || volume === 0}
                onClick={() => setMuted((m) => !m)}
                ariaLabel={muted ? "取消静音" : "静音"}
                ariaPressed={muted}
                title={muted ? "取消静音" : "静音"}>
                {muted || volume === 0 ? <VolumeX /> : <Volume2 />}
              </IconButton>
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
                    style={{ "--mp-prog": volGrad } as CSSProperties}
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

        {/* 歌词列：AMLL（Apple Music 风格）渲染；移动端行点击不跳进度，与封面
            同属「进度条以上非按钮区」，点击即切回唱片视图；
            key 随视图变化：从唱片切回歌词时重挂载，让 AMLL 随新容器重建当前句对齐 */}
        <div className="mplp-right" key={npViewCover ? "np-cover" : "np-lyric"}>
          <AmllLyricView
            lines={lyricLines ?? EMPTY_LRC_LINES}
            amllRich={amllRich}
            loading={lyricsLoading}
            error={lyricError}
            hasRaw={Boolean(lyricRaw)}
            currentTime={currentTime}
            playing={playing}
            duration={duration}
            onSeek={isMobile ? undefined : seek}
          />
        </div>
      </div>
    </div>
  );
}
