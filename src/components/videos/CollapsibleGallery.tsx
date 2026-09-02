"use client";
import React, { useLayoutEffect, useState, useRef, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronUp } from "lucide-react";

/**
 * 图集「按行折叠」容器 —— 各平台图集统一的多图展示方式。
 * 多图网格默认只完整展示前 maxRows 行（默认 2 行），图片行数超过时
 * 底部渐变提示 + 展开/收起按钮。
 *
 * 与固定 px 折叠高度（如 520）不同，这里「两行」的高度是动态测量的：
 * - 折叠高度 = 前 maxRows 行图片的实际高度（行高 × 行数 + 行距），由网格中
 *   首个单元的高度推出；
 * - 因此折叠后停在的行数与容器宽度、列数无关 —— 移动端 2 列与桌面端 3~4 列
 *   都能精确截在第 2 行底部，不会多露出半行、也不会把不足两行的内容截掉；
 * - 溢出判断基于同一折叠高度：内容总高 ≤ maxRows 行时不出现展开按钮。
 *
 * 用法：把多图 grid 作为 children 传入（grid 的直接子元素需为等高单元格，
 * 例如 aspect-square 的图片项），单图展示不经过本组件。
 */
interface CollapsibleGalleryProps {
  /** 多图网格内容，由调用方定义列数 / 图片比例 */
  children: ReactNode;
  /** 折叠态保留的完整行数，默认 2（两行） */
  maxRows?: number;
}

export default function CollapsibleGallery({
  children,
  maxRows = 2,
}: CollapsibleGalleryProps) {
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  // 折叠态高度 = 前 maxRows 行高（自动测量）；展开态高度 = 内容完整高度
  const [foldHeight, setFoldHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  // 每次渲染后测量（内容/列数/窗口尺寸变化自动覆盖），resize 时重新测量。
  // 使用 useLayoutEffect：在浏览器绘制前完成裁剪，避免首帧闪现未折叠状态。
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      const grid = el.firstElementChild as HTMLElement | null;
      const firstCell = grid?.firstElementChild as HTMLElement | null;
      if (!grid || !firstCell) {
        // 无可测量内容（例如单图/空容器），无需折叠
        setOverflow(false);
        return;
      }
      // grid 单元为等高块（aspect-square），首行单元高度即每行行高
      const rowHeight = firstCell.offsetHeight;
      const rowGap = parseFloat(getComputedStyle(grid).rowGap || "0") || 0;
      const foldH = rowHeight * maxRows + rowGap * (maxRows - 1);
      // scrollHeight 为内容完整高度，不受 overflow-hidden/max-height 影响
      const total = el.scrollHeight;

      setFoldHeight(foldH);
      setContentHeight(total);
      // 容差 1px：内容完整行数 ≤ maxRows 行时不算溢出
      setOverflow(total > foldH + 1);
    };

    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  });

  // 折叠 = 前 maxRows 行；展开 = 内容完整高度（动画在两者间过渡）
  const maxHeight = expanded
    ? contentHeight || undefined
    : foldHeight || undefined;

  return (
    <>
      <div
        ref={ref}
        className="relative overflow-hidden transition-[max-height] duration-300 ease-in-out"
        style={{ maxHeight }}>
        {children}
        {overflow && !expanded && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-glass-1 to-transparent" />
        )}
      </div>

      {/* 图片行数超过折叠行数时展示展开/收起入口 */}
      {overflow && (
        <div className="mt-1 flex justify-center">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="h-auto gap-1 px-2.5 py-1 text-[13px] text-muted hover:text-primary">
            {expanded ? (
              <>
                <ChevronUp className="h-4 w-4" />
                收起
              </>
            ) : (
              <>
                <ChevronDown className="h-4 w-4" />
                展开
              </>
            )}
          </Button>
        </div>
      )}
    </>
  );
}
