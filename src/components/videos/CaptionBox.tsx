"use client";
import React, { useState, useCallback } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Check, Copy, FileText } from "lucide-react";

/**
 * 统一的「文案展示框」—— 展示作品文案/简介，右上角一键复制。
 * 各平台结果卡片在视频信息与视频下载按钮之间渲染本组件，保证文案位置一致、可复制。
 */
interface CaptionBoxProps {
  /** 文案正文（复制按钮复制的也是这段文本） */
  text: string;
  /** 面板标题，默认「文案」 */
  title?: string;
}

export default function CaptionBox({ text, title = "文案" }: CaptionBoxProps) {
  const [copied, setCopied] = useState(false);

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

  if (!text) return null;

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
      <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-muted">
        {text}
      </p>
    </Card>
  );
}
