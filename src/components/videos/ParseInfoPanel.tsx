"use client";
import React from "react";
import { Card } from "@/components/ui/card";
import { Info } from "lucide-react";
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

/** 点赞数：千分位 / 万 */
function formatCount(value: unknown): string | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (n >= 10000) {
    return n >= 1000000
      ? `${(n / 10000).toFixed(0)}万`
      : `${(n / 10000).toFixed(1)}万`;
  }
  return n.toLocaleString("zh-CN");
}

/** 发布时间：unix 秒时间戳 / 可解析日期字符串 → "YYYY-MM-DD HH:mm" */
function formatTime(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  let date: Date;
  if (typeof value === "number") {
    date = new Date(value * 1000); // 抖音等平台为 unix 秒
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

/** 内容类型英文 → 中文 */
function formatType(value: unknown): string | undefined {
  const map: Record<string, string> = {
    video: "视频",
    image: "图文 / 图集",
    music: "音乐",
    text: "纯文字",
  };
  const v = String(value ?? "");
  return map[v] || undefined;
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

function getRawValue(data: ParseData, key: string): unknown {
  switch (key) {
    case "musicAuthor":
      return data.music?.author;
    case "videoCount":
      return data.videos?.length;
    default:
      return (data as Record<string, unknown>)[key];
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
  douyin: [
    { key: "author", label: "作者" },
    { key: "authorId", label: "抖音号" },
    { key: "like", label: "点赞", format: formatCount },
    { key: "time", label: "发布时间", format: formatTime },
    { key: "duration", label: "视频时长", format: formatDuration },
    TYPE_FIELD,
    { key: "musicAuthor", label: "背景音乐" },
  ],
  bilibili: [
    { key: "author", label: "UP主" },
    { key: "authorId", label: "UID" },
    { key: "videoCount", label: "分P数量", format: formatVideoCount },
    {
      key: "type",
      label: "内容类型",
      format: () => "视频",
    },
  ],
  xhs: [
    { key: "author", label: "作者" },
    { key: "authorId", label: "小红书号" },
    TYPE_FIELD,
  ],
  kuaishou: [
    { key: "author", label: "作者" },
    TYPE_FIELD,
  ],
  weibo: [
    { key: "author", label: "博主" },
    { key: "time", label: "发布时间", format: formatTime },
    TYPE_FIELD,
  ],
  qsmusic: [
    { key: "name", label: "歌曲" },
    { key: "core", label: "来源" },
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

  return (
    <Card className="p-5">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-primary">
        <Info className="h-4 w-4 text-accent" />
        {title}
      </h3>
      <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex min-w-0 items-baseline justify-between gap-3">
            <dt className="shrink-0 text-xs text-muted">{row.label}</dt>
            <dd
              className="truncate text-sm text-primary"
              title={row.value}>
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
