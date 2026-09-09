"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

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
export function MiniLyricLine({ text, playing }: MiniLyricLineProps) {
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

interface MarqueeTextProps {
  text: string;
  /** 追加到行容器的类名（如 .t / .a，继承既有字号配色与基础观感） */
  className?: string;
  /** 启用测量与跑马灯；false 时退化为普通截断显示（桌面端无需滚动） */
  animate?: boolean;
}

/**
 * 通用「超长文本无缝跑马灯」行：
 * - 文本未超宽时保持父级对齐（通常居中）静态显示；
 * - 文本超宽且 animate=true 时切换为双副本无缝滚动，动画时长随长度自适应；
 * - animate=false 时用省略号截断（兜底，维持原静态观感）。
 * 宽度用隐藏测量副本判定：nowrap 下其 offsetWidth 即文本自然宽度。
 */
export function MarqueeText({ text, className, animate = true }: MarqueeTextProps) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const probeRef = useRef<HTMLSpanElement | null>(null);
  const [overflow, setOverflow] = useState(false);

  useLayoutEffect(() => {
    if (!animate) {
      setOverflow(false);
      return;
    }
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
  }, [text, animate]);

  const run = animate && overflow;
  // 动画时长随文本长度放大（8~20s）：短句不至于瞬移，长句不会过快
  const dur = Math.max(8, Math.min(20, Math.round(text.length * 0.3)));
  return (
    <div ref={rowRef} className={cn("mplp-mqrow", className, run && "mq")}>
      {run ? (
        <span
          className="mplp-mqtrk"
          style={{ animationDuration: `${dur}s` }}>
          <span className="mplp-mqcp">{text}</span>
          <span className="mplp-mqcp" aria-hidden="true">
            {text}
          </span>
        </span>
      ) : (
        <span className="mplp-mqtx">{text}</span>
      )}
      {/* 隐藏测量副本：不参与布局，仅提供文本自然宽度 */}
      <span ref={probeRef} className="mplp-mqprobe" aria-hidden="true">
        {text}
      </span>
    </div>
  );
}
