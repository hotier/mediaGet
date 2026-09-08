"use client";

import { ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 右下角「上一个 / 下一个」切换按钮组件。
 * 竖排两枚圆形悬浮按钮，中间可夹一枚页码徽标，用于长列表的分页切换
 * （挂载点须为 relative 容器，由调用方通过 className 传入 absolute 定位，
 * 并在内容末尾预留足够占位避免悬浮按钮遮住末行内容）。
 */
export interface PagerSwitcherProps {
  /** 是否可切上一页 */
  canPrev: boolean;
  /** 是否可切下一页 */
  canNext: boolean;
  /** 翻页请求中：两枚按钮禁用，页码徽标处显示加载态 */
  busy?: boolean;
  /** 徽标文案（如「第 2 页」），省略则不渲染 */
  label?: string;
  onPrev?: () => void;
  onNext?: () => void;
  /** 外层定位类名，如 `absolute bottom-4 right-4` */
  className?: string;
}

export default function PagerSwitcher({
  canPrev,
  canNext,
  busy = false,
  label,
  onPrev,
  onNext,
  className,
}: PagerSwitcherProps) {
  const navBtnCls =
    "flex h-10 w-10 items-center justify-center rounded-full border border-border-subtle bg-glass-2/90 text-secondary shadow-card backdrop-blur transition-colors hover:border-border-medium hover:bg-glass-3 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border-subtle disabled:hover:bg-glass-2/90 disabled:hover:text-secondary";

  return (
    <div className={cn("flex flex-col items-center gap-1.5", className)}>
      <button
        type="button"
        onClick={onPrev}
        disabled={!canPrev || busy}
        aria-label="上一页"
        title="上一页"
        className={navBtnCls}>
        <ChevronUp className="h-4 w-4" />
      </button>
      {label && (
        <span
          className="flex h-5 min-w-8 items-center justify-center rounded-full bg-glass-3 px-2 text-[11px] leading-none tabular-nums text-muted"
          aria-live="polite">
          {busy ? (
            <Loader2 className="h-3 w-3 animate-spin text-accent" />
          ) : (
            label
          )}
        </span>
      )}
      <button
        type="button"
        onClick={onNext}
        disabled={!canNext || busy}
        aria-label="下一页"
        title="下一页"
        className={navBtnCls}>
        <ChevronDown className="h-4 w-4" />
      </button>
    </div>
  );
}
