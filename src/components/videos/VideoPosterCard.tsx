"use client";
import React, { useRef, useState } from "react";
import Image from "next/image";
import { Download, Music, Pause, Play } from "lucide-react";
import { buildVideoProxyUrl } from "@/utils/videoProxy";
import { Button } from "@/components/ui/button";

/**
 * 统一视频展示卡片（简化版）：上方封面图 + 下方「播放视频 / 下载视频」两个链接。
 * 各平台复用此卡片，标题/作者等信息由各平台组件自行展示。
 *
 * 防盗链处理：小红书 xhscdn 视频直链有 Referer 防盗链，新窗口打开会 403。
 * 这里对需要代理的直链自动走 /api/video-proxy（带 Referer），保证可播放、可下载。
 *
 * 两种交互模式：
 * - inline=false（默认）：封面/播放/下载均为直链新窗口打开。
 * - inline=true：封面或「播放」按钮在当前页面内嵌 <video> 播放，下载按钮在当前页面触发真实下载。
 *   适合已走代理或直链可直播的源（小红书 / B站），避免新开标签页，体验更好。
 */

type AccentKey = "blue" | "red" | "orange" | "pink" | "neutral" | "purple" | "dy";

const ACCENTS: Record<AccentKey, string> = {
  // B站 / 皮皮虾 / 皮皮搞笑
  blue: "from-[#00aeec] to-[#4dc9ff]",
  // 微博
  red: "from-[#e6162d] to-[#ff4d6a]",
  // 快手
  orange: "from-[#ff6600] to-[#ff9933]",
  // 小红书
  pink: "from-[#ff2442] to-[#ff5c7c]",
  // 通用平台
  neutral: "from-neutral-500 to-neutral-400",
  // QQ音乐
  purple: "from-purple-500 to-violet-500",
  // 抖音
  dy: "from-[#fe2c55] to-[#ff6b8a]",
};

interface VideoPosterCardProps {
  /** 视频直链 */
  url: string;
  /** 封面图地址（可选，无封面时只显示按钮行） */
  cover?: string;
  /** 封面 alt */
  alt?: string;
  /** 品牌色 */
  accent?: AccentKey;
  /** 竖屏视频封面用 9:16，默认宽屏 16:9 */
  tall?: boolean;
  /** 播放按钮文案，默认「播放视频」 */
  playText?: string;
  /** 下载按钮文案，默认「下载视频」 */
  downloadText?: string;
  /** 音频直链（可选），存在时额外显示「下载音频」按钮 */
  audioUrl?: string;
  /** 音频按钮文案，默认「下载音频」 */
  audioText?: string;
  /** 下载文件名（内嵌模式下直链跨域时走代理强制保存，默认「video.mp4」） */
  downloadName?: string;
  /** 是否显示下载按钮，默认 true */
  showDownload?: boolean;
  /** 自定义下载按钮点击：提供后按钮改为按钮型（不直接下载），如滚动定位到下载区 */
  onDownloadClick?: () => void;
  /** 是否显示「播放视频」按钮（默认 true；false 时封面自带点击 + 下方只剩下载） */
  showPlay?: boolean;
  /** 内嵌播放模式：封面/播放按钮在当前页面内嵌 <video> 播放，下载走代理真实下载（适合已代理的源，如小红书） */
  inline?: boolean;
}

export default function VideoPosterCard({
  url,
  cover,
  alt,
  accent = "neutral",
  tall = false,
  playText = "播放视频",
  downloadText = "下载视频",
  audioUrl,
  audioText = "下载音频",
  downloadName = "video.mp4",
  showDownload = true,
  onDownloadClick,
  showPlay = true,
  inline = false,
}: VideoPosterCardProps) {
  const gradient = ACCENTS[accent];
  // 防盗链直链走代理，保证可播放、可下载
  const playUrl = buildVideoProxyUrl(url);
  // 内嵌播放状态管理：
  // - expanded：播放器是否已展开（展开后封面隐藏）
  // - playing：是否实际在播放（由 <video> 的 play/pause 事件同步）
  const [expanded, setExpanded] = useState(false);
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  // 内嵌模式：点击封面/播放按钮 —— 未展开则展开并自动播放，已展开则播放/暂停切换
  const handleInlinePlay = () => {
    if (!expanded) {
      setExpanded(true);
      setPlaying(true);
    } else if (videoRef.current) {
      if (playing) {
        videoRef.current.pause();
      } else {
        videoRef.current.play();
      }
    }
  };

  return (
    <div className="space-y-3">
      {/* 封面图 / 内嵌播放器 */}
      {cover && !expanded && (
        <a
          href={inline ? undefined : playUrl}
          target={inline ? undefined : "_blank"}
          rel={inline ? undefined : "noopener noreferrer"}
          onClick={inline ? handleInlinePlay : undefined}
          className="group block rounded-2xl overflow-hidden bg-black cursor-pointer">
          <div
            className={`relative w-full ${
              tall ? "aspect-[9/16] sm:aspect-video" : "aspect-video"
            }`}>
            <Image
              src={cover}
              alt={alt || "视频封面"}
              fill
              className="object-contain"
              unoptimized
            />
            {/* 中心播放图标：提示用户可点击封面播放，hover 时轻微放大 */}
            <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/15 transition-colors duration-300">
              <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-white/90 group-hover:bg-white text-black flex items-center justify-center shadow-lg transition-transform duration-300 group-hover:scale-110">
                <Play className="w-7 h-7 sm:w-9 sm:h-9 ml-1" fill="currentColor" />
              </div>
            </div>
          </div>
        </a>
      )}

      {/* 内嵌播放器（inline 模式点击播放后展开，播放状态与按钮联动） */}
      {inline && expanded && (
        <div className="rounded-2xl overflow-hidden bg-black">
          <video
            ref={videoRef}
            src={playUrl}
            controls
            autoPlay
            playsInline
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            className={`w-full ${
              tall ? "aspect-[9/16] sm:aspect-video" : "aspect-video"
            } object-contain`}
          />
        </div>
      )}

      {/* 操作按钮：播放 / 下载（内嵌模式下封面或播放按钮均可触发当前页内嵌播放） */}
      <div className="flex flex-col sm:flex-row gap-3">
        {showPlay &&
          (inline ? (
            <Button
              type="button"
              variant="default"
              size="lg"
              onClick={handleInlinePlay}
              className={`flex-1 bg-gradient-to-r ${gradient} hover:opacity-90`}>
              {playing ? (
                <Pause className="h-5 w-5" />
              ) : (
                <Play className="h-5 w-5" />
              )}
              {expanded ? (playing ? "暂停" : "继续播放") : playText}
            </Button>
          ) : (
            <Button
              asChild
              variant="default"
              size="lg"
              className={`flex-1 bg-gradient-to-r ${gradient} hover:opacity-90`}>
              <a href={playUrl} target="_blank" rel="noopener noreferrer">
                <Play className="h-5 w-5" />
                {playText}
              </a>
            </Button>
          ))}

        {showDownload &&
          (onDownloadClick ? (
            /* 自定义下载行为（如滚动定位到下载区），不直接下载 */
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="flex-1"
              onClick={onDownloadClick}>
              <Download className="h-5 w-5" />
              {downloadText}
            </Button>
          ) : inline && !playUrl.startsWith("/api/video-proxy") ? (
            /* 内嵌模式 + 直链跨域：download 属性对跨域 URL 无效，走代理强制保存文件（抖音等） */
            <Button asChild variant="outline" size="lg" className="flex-1">
              <a
                href={`/api/video-proxy?url=${encodeURIComponent(
                  url
                )}&download=1&filename=${encodeURIComponent(downloadName)}`}
                target="_blank"
                rel="noopener noreferrer">
                <Download className="h-5 w-5" />
                {downloadText}
              </a>
            </Button>
          ) : (
            <Button asChild variant="outline" size="lg" className="flex-1">
              <a
                href={playUrl}
                target={inline ? undefined : "_blank"}
                rel={inline ? undefined : "noopener noreferrer"}
                download={inline ? downloadName : undefined}>
                <Download className="h-5 w-5" />
                {downloadText}
              </a>
            </Button>
          ))}

        {/* 音频下载：与视频下载同款式（中性描边），点击新窗口打开音频直链 */}
        {audioUrl && (
          <Button asChild variant="outline" size="lg" className="flex-1">
            <a
              href={audioUrl}
              target="_blank"
              rel="noopener noreferrer">
              <Music className="h-5 w-5" />
              {audioText}
            </a>
          </Button>
        )}
      </div>
    </div>
  );
}
