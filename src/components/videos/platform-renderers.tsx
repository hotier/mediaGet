"use client";
import type { ComponentType } from "react";
import type { ApiResponse } from "@/types/api";
import type { VideoPlatformKey } from "@/config/video-platforms";
import {
  DouyinVideo,
  BilibiliVideo,
  KuaishouVideo,
  WeiboVideo,
  XhsVideo,
  QsMusicVideo,
  PipigxVideo,
  PpxiaVideo,
  TwitterVideo,
  GenericParsedVideo,
} from "./index";

/**
 * 平台结果渲染注册表 —— 配置驱动的「一个文件」扩展点。
 *
 * 新增平台时：
 * - 无特殊 UI：只需在 config/video-platforms.ts 添加条目（名称/颜色/图标），
 *   解析结果自动由 GenericParsedVideo 通用渲染，本表无需改动；
 * - 有特殊 UI（如音频/图集/多分P 等专属交互）：新增组件后在本表注册一行，
 *   其余页面（page.tsx）零改动。
 *
 * key 使用前端平台 key（config/video-platforms.ts 的 VIDEO_PLATFORMS），
 * 与后端返回的 key 命名差异（xhs↔redbook、ppxia↔pipixia）由 VideoParserForm
 * 在写入结果时统一覆盖为前端 key。
 */
export type VideoResultRenderer = ComponentType<{ data: ApiResponse }>;

export const platformRenderers: Partial<
  Record<VideoPlatformKey, VideoResultRenderer>
> = {
  douyin: DouyinVideo,
  bilibili: BilibiliVideo,
  kuaishou: KuaishouVideo,
  weibo: WeiboVideo,
  xhs: XhsVideo,
  qsmusic: QsMusicVideo,
  pipigx: PipigxVideo,
  ppxia: PpxiaVideo,
  twitter: TwitterVideo,
};

/** 按平台选择渲染组件；未注册的平台一律走通用渲染 */
export function renderPlatformResult(result: ApiResponse) {
  const key = result.platform as VideoPlatformKey | undefined;
  const Renderer = (key && platformRenderers[key]) || GenericParsedVideo;
  return <Renderer data={result} />;
}
