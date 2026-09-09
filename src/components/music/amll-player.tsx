"use client";

/**
 * AMLL（Apple Music Like Lyrics）歌词播放器最小客户端壳。
 *
 * 仅负责把「毫秒级歌词行 + 当前进度 + 播放状态」喂给 AMLL 的 LyricPlayer。
 * 通过 next/dynamic ssr:false 引用（见 AmllLyricView），避免在服务端实例化：
 * AMLL 基于 DOM/Pixi 渲染器，挂载时读取容器尺寸并建立内部动画循环。
 * core/style.css 提供 .amll-lyric-player 等必需样式，只能由 bundler 引入。
 */
import type { LyricLine as AmllLine } from "@applemusic-like-lyrics/core";
import { LyricPlayer } from "@applemusic-like-lyrics/react";
import "@applemusic-like-lyrics/core/style.css";

export interface AmllPlayerProps {
  /** 毫秒单位的 AMLL 歌词行 */
  lines: AmllLine[];
  /** 当前播放进度（毫秒） */
  currentTimeMs: number;
  /** 是否播放中（控制间奏点等效果动画） */
  playing: boolean;
  /** 歌词行被点击时的回调，参数为所点行在 lines 中的下标（用于跳转） */
  onSeekLine?: (index: number) => void;
}

export default function AmllPlayer({
  lines,
  currentTimeMs,
  playing,
  onSeekLine,
}: AmllPlayerProps) {
  return (
    <LyricPlayer
      className="mp-amll"
      style={{ width: "100%", height: "100%", minHeight: 0 }}
      lyricLines={lines}
      currentTime={currentTimeMs}
      playing={playing}
      alignAnchor="center"
      // 库默认 alignPosition 为 0.35（活动行偏上，约 1/3 处），显式指定
      // 0.5 让当前歌词行稳定停在播放区竖直正中（对齐锚点为行中心）
      alignPosition={0.5}
      // —— 仿 Apple Music 的视觉取向 ——
      // 保留已唱过的歌词行（不隐藏），整行随推进变暗后淡出，当前行放大高亮；
      // 逐字扫亮由行内单词时间戳驱动（见 lyric-amll.ts）。
      enableBlur
      enableScale
      hidePassedLines={false}
      // 行被截断后留下的 >4s 间奏空档，由库内 InterludeDots 自动展示「· · ·」
      // 动画（帧率上限 ~30fps，仅在有歌词空档时激活，不影响播放性能）。
      onLyricLineClick={
        onSeekLine ? (e) => onSeekLine(e.lineIndex) : undefined
      }
    />
  );
}
