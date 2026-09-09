import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

export interface EqBarsProps {
  /** 是否播放中（false → 静止态 .paused，暂停动画） */
  playing?: boolean;
  className?: string;
  style?: CSSProperties;
}

/**
 * 三格“均衡器”播放动效（.mp-eq，三格 <i>）。
 * 同一份结构在「正在播放」状态位与播放列表行内出现，避免两处重复写 i 节点。
 * 尺寸 / 间距差异交由外层作用域 CSS（如 .mp-now-flag .mp-eq）覆盖。
 */
export function EqBars({ playing = true, className, style }: EqBarsProps) {
  return (
    <span
      className={cn("mp-eq", !playing && "paused", className)}
      style={style}
      aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}
