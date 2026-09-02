"use client";
import React, { useState, useCallback, useRef, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Check, Copy, FileText, ChevronDown, ChevronUp } from "lucide-react";

/**
 * 统一的「文案展示框」—— 展示作品文案/简介，右上角一键复制。
 * 各平台结果卡片在视频信息与视频下载按钮之间渲染本组件，保证文案位置一致、可复制。
 * 内容超长时默认限高（约 6 行），底部渐变提示 + 展开按钮，点击展开完整内容。
 */
interface CaptionBoxProps {
  /** 文案正文（复制按钮复制的也是这段文本） */
  text: string;
  /** 面板标题，默认「文案」 */
  title?: string;
}

/** 折叠态限高 = 原 max-h-32（8rem = 128px，约 6 行） */
const COLLAPSED_HEIGHT = 128;

export default function CaptionBox({ text, title = "文案" }: CaptionBoxProps) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  // 内容完整高度：展开动画的精确过渡目标（避免 max-h-[2000px] 大值 hack
  // 导致的「瞬间弹开 / 收起前死区」失真，原理与图集折叠容器一致）
  const [contentHeight, setContentHeight] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);

  const handleCopy = useCallback(async () => {
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // 剪贴板 API 不可用（非安全上下文等）：回退到隐藏 textarea + execCommand
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 复制失败：静默，不打断浏览
    }
  }, [text]);

  // 记录完整内容高度 + 判断是否超出折叠限高：
  // scrollHeight 是不受 max-height/overflow-hidden 截断影响的完整内容高度，
  // 溢出判据直接与折叠限高比较 —— 与展开态解耦，展开中触发 resize 重测也不会丢按钮。
  // 监听 resize：卡片换行随宽度变化时同步刷新测量值。
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const measure = () => {
      setContentHeight(el.scrollHeight);
      setOverflow(el.scrollHeight > COLLAPSED_HEIGHT + 1);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [text]);

  // 纯空白 / 占位符（如 B站无简介视频的 "-"）不渲染，避免出现空白卡片
  if (!text || !text.trim() || text.trim() === "-") return null;

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-primary">
          <FileText className="h-4 w-4 text-accent" />
          {title}
        </h3>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleCopy}
          aria-label={`复制${title}`}
          className="shrink-0 gap-1.5 text-xs text-muted hover:text-primary">
          {copied ? (
            <Check className="h-3.5 w-3.5 text-accent" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          {copied ? "已复制" : "复制"}
        </Button>
      </div>

      {/* 折叠内容：限高 + 底部渐变；展开/收起在精确高度间过渡（无死区、无弹跳） */}
      <div
        ref={contentRef}
        className="relative overflow-hidden transition-[max-height] duration-300 ease-in-out"
        style={{ maxHeight: expanded ? contentHeight : COLLAPSED_HEIGHT }}>
        <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-muted">
          {text}
        </p>
        {overflow && !expanded && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-glass-1 to-transparent" />
        )}
      </div>

      {/* 内容超出时展示展开/收起入口 */}
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
    </Card>
  );
}
