"use client";
import React, { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Check, Copy, Info } from "lucide-react";
import { ParseData } from "@/types/api";

/**
 * 平台感知的「作品信息面板」 —— 展示解析结果中的元数据字段。
 *
 * 设计：每个平台配置一张字段表（字段 + 标签 + 可选格式化），
 * 只渲染「有值」的行，缺字段时自动隐藏，避免出现空白占位。
 * 各平台结果卡片只需 <ParseInfoPanel platform data title /> 一行即可接入，
 * 未来后端补充新字段后，改这里的配置表即可自动展示，无需改动各卡片。
 */

interface FieldDef {
  /** 取值键：data 字段名，或特殊键（musicAuthor / videoCount） */
  key: string;
  /** 展示标签 */
  label: string;
  /** 自定义取值 + 格式化；返回 undefined 表示该行不展示 */
  format?: (value: unknown, data: ParseData) => string | undefined;
}

interface ParseInfoPanelProps {
  data: ParseData | null | undefined;
  /** 平台 key（未配置时使用默认字段集） */
  platform?: string;
  /** 面板标题，默认「作品信息」 */
  title?: string;
}

/* ---------------- 格式化工具 ---------------- */

function pad(n: number) {
  return String(n).padStart(2, "0");
}

/** 点赞数：兼容数字 / 数字字符串 / 中文单位字符串（如小红书 "24.9万"），统一千分位 / 万缩写 */
function formatCount(value: unknown): string | undefined {
  let n: number;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string") {
    const m = value.trim();
    const w = /^([\d.]+)\s*万$/.exec(m);
    const y = /^([\d.]+)\s*亿$/.exec(m);
    if (w) n = parseFloat(w[1]) * 10000;
    else if (y) n = parseFloat(y[1]) * 100000000;
    else n = parseFloat(m);
  } else {
    n = Number.NaN;
  }
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (n >= 10000) {
    return n >= 1000000
      ? `${(n / 10000).toFixed(0)}万`
      : `${(n / 10000).toFixed(1)}万`;
  }
  return n.toLocaleString("zh-CN");
}

/** 发布时间：unix 秒时间戳（>=1e12 视为毫秒）/ 可解析日期字符串 → "YYYY-MM-DD HH:mm" */
function formatTime(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  let date: Date;
  if (typeof value === "number") {
    // 抖音 / 小红书等平台为 unix 秒；兼容毫秒时间戳（13 位）
    date = new Date(value >= 1e12 ? value : value * 1000);
  } else {
    date = new Date(String(value));
  }
  if (Number.isNaN(date.getTime())) return String(value); // 已是格式化字符串
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 视频时长（毫秒）→ "mm:ss" / "h:mm:ss" */
function formatDuration(value: unknown): string | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const totalSec = Math.round(n / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** 内容类型英文 → 中文；视频 + 图集并存时显示「视频 + 图文」 */
function formatType(value: unknown, data: ParseData): string | undefined {
  const map: Record<string, string> = {
    video: "视频",
    image: "图文 / 图集",
    music: "音乐",
    text: "纯文字",
  };
  const v = String(value ?? "");
  const label = map[v];
  if (!label) return undefined;
  if (v === "video" && Array.isArray(data?.images) && data.images.length > 0) {
    return "视频 + 图文";
  }
  return label;
}

/** 版权（bilibili）：1=自制 2=转载 */
function formatCopyright(value: unknown): string | undefined {
  const v = Number(value);
  if (v === 1) return "自制";
  if (v === 2) return "转载";
  return undefined;
}

function formatVideoCount(value: unknown): string | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return `${n} 个分P`;
}

/** 普通字段：非空值转字符串（0 / 空字符串视为无值） */
function normalizeValue(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return String(value);
}

/* ---------------- 特殊键取值 ---------------- */

/** 从多个候选字段取第一个非空值（兼容各平台原始字段名差异） */
function pickFirst(data: ParseData, keys: string[]): unknown {
  for (const key of keys) {
    const value = (data as Record<string, unknown>)[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function getRawValue(data: ParseData, key: string): unknown {
  switch (key) {
    case "musicAuthor":
      return data.music?.author;
    case "musicTitle":
      return data.music?.title;
    case "videoCount":
      return data.videos?.length;
    default: {
      // 支持 "stat.view" 点路径取值
      const parts = key.split(".");
      let cur: unknown = data;
      for (const part of parts) {
        if (cur && typeof cur === "object") {
          cur = (cur as Record<string, unknown>)[part];
        } else {
          return undefined;
        }
      }
      return cur;
    }
  }
}

/* ---------------- 平台字段配置 ---------------- */

const TYPE_FIELD: FieldDef = {
  key: "type",
  label: "内容类型",
  format: formatType,
};

/** 各平台字段表：label 按平台语境定制，字段按展示优先级排列 */
const PLATFORM_FIELDS: Record<string, FieldDef[]> = {
  // 博主卡已展示：昵称 / 抖音号 / 简介 / 关注 / 粉丝 / 获赞，这里只保留视频相关信息
  douyin: [
    { key: "stat.view", label: "播放", format: formatCount },
    { key: "stat.like", label: "点赞", format: formatCount },
    { key: "stat.reply", label: "评论", format: formatCount },
    { key: "stat.favorite", label: "收藏", format: formatCount },
    { key: "stat.share", label: "分享", format: formatCount },
    { key: "time", label: "发布时间", format: formatTime },
    { key: "duration", label: "视频时长", format: formatDuration },
    TYPE_FIELD,
    { key: "musicAuthor", label: "背景音乐" },
    { key: "musicTitle", label: "背景音乐标题" },
    { key: "awemeId", label: "视频ID" },
  ],
  // UP主卡已展示：昵称 / UID / 简介 / 关注 / 粉丝 / 获赞，这里只保留视频相关信息
  bilibili: [
    { key: "title", label: "视频标题" },
    { key: "tname", label: "分区" },
    { key: "time", label: "发布时间", format: formatTime },
    { key: "duration", label: "视频时长", format: formatDuration },
    { key: "stat.view", label: "播放", format: formatCount },
    { key: "stat.like", label: "点赞", format: formatCount },
    { key: "stat.danmaku", label: "弹幕", format: formatCount },
    { key: "stat.coin", label: "投币", format: formatCount },
    { key: "stat.favorite", label: "收藏", format: formatCount },
    { key: "stat.share", label: "分享", format: formatCount },
    { key: "stat.reply", label: "评论", format: formatCount },
    { key: "copyright", label: "版权", format: formatCopyright },
    { key: "videoCount", label: "分P数量", format: formatVideoCount },
    {
      key: "type",
      label: "内容类型",
      format: () => "视频",
    },
  ],
  // B站图文动态（/opus/）：动态标题 + 发布时间 + 互动统计（统计由后端归一到 stat.like/reply/share）
  bilibiliOpus: [
    { key: "title", label: "动态标题" },
    { key: "time", label: "发布时间", format: formatTime },
    { key: "stat.like", label: "点赞", format: formatCount },
    { key: "stat.reply", label: "评论", format: formatCount },
    { key: "stat.share", label: "分享", format: formatCount },
    TYPE_FIELD,
  ],
  // 博主卡已展示：昵称 / 小红书号 / 简介 / 关注 / 粉丝 / 获赞，这里只保留帖子（笔记）相关信息
  xhs: [
    { key: "title", label: "笔记标题" },
    { key: "time", label: "发布时间", format: formatTime },
    { key: "like", label: "点赞", format: formatCount },
    { key: "favorite", label: "收藏", format: formatCount },
    { key: "reply", label: "评论", format: formatCount },
    { key: "share", label: "分享", format: formatCount },
    TYPE_FIELD,
    { key: "noteId", label: "笔记ID" },
  ],
  // 博主卡已展示：昵称 / 快手号 / 简介 / 关注 / 粉丝 / 获赞，这里只保留视频相关信息
  kuaishou: [
    {
      key: "playCount",
      label: "播放",
      format: (v, d) => formatCount(pickFirst(d, ["playCount", "viewCount"])),
    },
    {
      key: "likeCount",
      label: "点赞",
      format: (v, d) => formatCount(pickFirst(d, ["likeCount", "like"])),
    },
    {
      key: "commentCount",
      label: "评论",
      format: (v, d) => formatCount(pickFirst(d, ["commentCount", "reply"])),
    },
    {
      key: "shareCount",
      label: "分享",
      format: (v, d) => formatCount(pickFirst(d, ["shareCount", "share"])),
    },
    {
      key: "createTime",
      label: "发布时间",
      format: (v, d) => formatTime(pickFirst(d, ["createTime", "timestamp", "time"])),
    },
    { key: "duration", label: "视频时长", format: formatDuration },
    TYPE_FIELD,
  ],
  // 博主卡已展示：昵称 / 微博号 / 简介 / 关注 / 粉丝，这里只保留微博内容相关信息
  weibo: [
    { key: "time", label: "发布时间", format: formatTime },
    { key: "like", label: "点赞", format: formatCount },
    { key: "reply", label: "评论", format: formatCount },
    { key: "share", label: "转发", format: formatCount },
    { key: "videoCount", label: "分P数量", format: formatVideoCount },
    TYPE_FIELD,
  ],
  qsmusic: [
    { key: "name", label: "歌曲" },
    { key: "core", label: "来源" },
    TYPE_FIELD,
  ],
  // 博主卡已展示：昵称 / 用户名 / 简介 / 关注 / 粉丝，这里只保留推文内容相关信息
  twitter: [
    { key: "time", label: "发布时间", format: formatTime },
    { key: "like", label: "点赞", format: formatCount },
    { key: "retweets", label: "转发", format: formatCount },
    { key: "replies", label: "评论", format: formatCount },
    { key: "views", label: "查看", format: formatCount },
    TYPE_FIELD,
  ],
};

/** 未配置平台时的默认字段集 */
const DEFAULT_FIELDS: FieldDef[] = [
  { key: "author", label: "作者" },
  { key: "authorId", label: "作者ID" },
  TYPE_FIELD,
  { key: "time", label: "发布时间", format: formatTime },
];

/* ---------------- 组件 ---------------- */

export default function ParseInfoPanel({
  data,
  platform,
  title = "作品信息",
}: ParseInfoPanelProps) {
  // 复制按钮状态（hooks 必须在条件 return 之前调用）
  const [copied, setCopied] = useState(false);

  if (!data || typeof data !== "object") return null;

  const fields = (platform && PLATFORM_FIELDS[platform]) || DEFAULT_FIELDS;

  const rows = fields
    .map((f) => {
      const raw = getRawValue(data, f.key);
      const value = f.format ? f.format(raw, data) : normalizeValue(raw);
      if (!value) return null;
      return { label: f.label, value };
    })
    .filter((r): r is { label: string; value: string } => r !== null);

  if (rows.length === 0) return null;

  const handleCopy = async () => {
    const text = rows.map((row) => `${row.label}：${row.value}`).join("\n");
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
  };

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-primary">
          <Info className="h-4 w-4 text-accent" />
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
      <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex min-w-0 items-baseline justify-between gap-3">
            <dt className="shrink-0 text-[13px] text-muted">{row.label}</dt>
            <dd
              className="truncate text-[13px] text-primary"
              title={row.value}>
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
