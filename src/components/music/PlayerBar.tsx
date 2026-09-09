"use client";

import type { CSSProperties, Dispatch, MouseEvent, RefObject, SetStateAction } from "react";
import {
  Maximize2,
  Music2,
  Pause,
  Play,
  Repeat,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { BR_OPTIONS, formatTime } from "@/components/music/types";
import type { DirectData, SearchItem } from "@/lib/music-client";
import { BrPicker } from "@/components/music/BrPicker";
import { MiniLyricLine } from "./marquee";
import IconButton from "./icon-btn";
import type { LyricLine } from "./lyric-utils";

export interface PlayerBarProps {
  picked: SearchItem | null;
  playing: boolean;
  duration: number;
  currentTime: number;
  /** 0-100：当前进度百分比（父层已算好，与整体共用同一派生） */
  progressPercent: number;
  /** 0-100：音量百分比（静音时仍为 volume 原始值，展示层按 muted 归零） */
  volumePercent: number;
  muted: boolean;
  volume: number;
  loop: boolean;
  br: string;
  fetching: boolean;
  direct: DirectData | null;
  playError: string | null;
  coverUrl: string | null;
  coverFailed: boolean;
  lyricLines: LyricLine[] | null;
  activeLyricIndex: number;
  lyricsLoading: boolean;
  lyricError: string | null;
  list: SearchItem[] | null;
  currentIndex: number | null;
  hasMore: boolean;
  progHover: boolean;
  /** 进度条实际宽度 px（父层 ResizeObserver 测得，悬停气泡防溢出用） */
  pbarW: number;
  /** 气泡实际宽度 px（父层测得） */
  tipBubbleW: number;
  miniPlayerRef: RefObject<HTMLDivElement | null>;
  pbarRef: RefObject<HTMLDivElement | null>;
  tipBubbleRef: RefObject<HTMLSpanElement | null>;
  artistText: (item: SearchItem) => string;
  seek: (t: number) => void;
  setSeeking: Dispatch<SetStateAction<boolean>>;
  setProgHover: Dispatch<SetStateAction<boolean>>;
  setLoop: Dispatch<SetStateAction<boolean>>;
  setMuted: Dispatch<SetStateAction<boolean>>;
  setVolume: (v: number) => void;
  togglePlay: () => void;
  playPrev: () => void;
  playNext: () => void;
  switchQuality: (br: string) => void;
  /** 打开整页歌词（底栏缩略封面 / 空白区唤起） */
  openLyricPage: () => void;
}

/**
 * 底部迷你播放条：进度（悬停气泡）/ 曲目与实时歌词 / 播放控制 / 音质选择 / 音量。
 * 测量用 ref（miniPlayerRef / pbarRef / tipBubbleRef）由父层持有，宽度派生
 * （pbarW / tipBubbleW / progressPercent / volumePercent）也在父层维护。
 */
export default function PlayerBar({
  picked,
  playing,
  duration,
  currentTime,
  progressPercent,
  volumePercent,
  muted,
  volume,
  loop,
  br,
  fetching,
  direct,
  playError,
  coverUrl,
  coverFailed,
  lyricLines,
  activeLyricIndex,
  lyricsLoading,
  lyricError,
  list,
  currentIndex,
  hasMore,
  progHover,
  pbarW,
  tipBubbleW,
  miniPlayerRef,
  pbarRef,
  tipBubbleRef,
  artistText,
  seek,
  setSeeking,
  setProgHover,
  setLoop,
  setMuted,
  setVolume,
  togglePlay,
  playPrev,
  playNext,
  switchQuality,
  openLyricPage,
}: PlayerBarProps) {
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
  const openLyricFromBlank = (e: MouseEvent<HTMLDivElement>) => {
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
    <div className="mp-player" ref={miniPlayerRef}>
      <div
        ref={pbarRef}
        className={cn("mp-pbar", progHover && "is-hot")}
        style={{ "--mp-prog": progGrad } as CSSProperties}
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
            <IconButton
              active={muted || volume === 0}
              onClick={() => setMuted((m) => !m)}
              title={muted ? "取消静音" : "静音"}
              style={{ width: 24, height: 24 }}>
              {muted || volume === 0 ? <VolumeX /> : <Volume2 />}
            </IconButton>
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
}
