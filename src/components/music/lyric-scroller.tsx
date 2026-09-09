import { useEffect, useRef } from "react";
import { Disc3, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LyricLine } from "./lyric-utils";

interface LyricScrollerProps {
  lines: LyricLine[];
  loading: boolean;
  error: string | null;
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
export default function LyricScroller({
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
