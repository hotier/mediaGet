"use client";
import React, { useState, useRef, useEffect, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronUp } from "lucide-react";

/**
 * 图集「限高折叠」容器 —— 各平台图集统一的多图展示方式。
 * 多图网格默认限高（约两行），图片过多时底部渐变提示 + 展开/收起按钮。
 * 用法：把多图 grid 作为 children 传入，单图展示不经过本组件。
 *
 * 溢出判断基于 scrollHeight（内容完整高度，不受 max-height 限制），
 * 因此展开/收起切换不会误判；grid 内容或窗口尺寸变化后每次渲染会重新检测。
 */
interface CollapsibleGalleryProps {
  /** 多图网格内容，由调用方定义列数 / 图片比例 */
  children: ReactNode;
  /** 折叠态最大高度 px，默认 520（约两行网格） */
  collapsedMaxHeight?: number;
  /** 展开态最大高度 px，需大于实际内容高度，默认 2400 */
  expandedMaxHeight?: number;
}

export default function CollapsibleGallery({
  children,
  collapsedMaxHeight = 520,
  expandedMaxHeight = 2400,
}: CollapsibleGalleryProps) {
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // 每次渲染后检测（内容/尺寸变化自动覆盖），resize 时重新检测
  useEffect(() => {
    const check = () => {
      const el = ref.current;
      if (!el) return;
      setOverflow(el.scrollHeight > collapsedMaxHeight + 1);
    };
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  });

  return (
    <>
      <div
        ref={ref}
        className="relative overflow-hidden transition-[max-height] duration-300 ease-in-out"
        style={{
          maxHeight: expanded ? expandedMaxHeight : collapsedMaxHeight,
        }}>
        {children}
        {overflow && !expanded && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-glass-1 to-transparent" />
        )}
      </div>

      {/* 图片超出折叠高度时展示展开/收起入口 */}
      {overflow && (
        <div className="mt-1 flex justify-center">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="h-auto gap-1.5 px-3 py-1.5 text-sm text-muted hover:text-primary">
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
