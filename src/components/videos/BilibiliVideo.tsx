"use client";
import React from "react";
import Image from "next/image";
import { ApiResponse } from "@/types/api";
import VideoPosterCard from "./VideoPosterCard";
import ParseInfoPanel from "./ParseInfoPanel";
import CaptionBox from "./CaptionBox";
import { Download } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface BilibiliVideoProps {
  data: ApiResponse;
}

export default function BilibiliVideo({ data }: BilibiliVideoProps) {
  const parsed = data.data;
  const videoItems = parsed?.videos || [];
  const hasVideo = videoItems.length > 0;
  // 统一窗口展示：不直接 <video> 播放（服务器出口 IP 拿到的直链为海外 CDN 节点）
  const primaryVideoUrl = hasVideo ? videoItems[0].url : "";
  const posterUrl = parsed?.cover || undefined;

  return (
    <div className="space-y-5" style={{ touchAction: 'pan-y' }}>
      {/* Author Info Card */}
      {(parsed?.avatar || parsed?.title) && (
        <Card className="p-5">
          <div className="flex items-center gap-4">
            {parsed?.avatar && (
              <div className="relative">
                <div className="absolute inset-0 rounded-full bg-gradient-to-br from-[#00aeec] to-[#4dc9ff] blur-sm opacity-50" />
                <Image
                  src={parsed.avatar}
                  alt={parsed.author || ""}
                  width={56}
                  height={56}
                  className="relative rounded-full border-2 border-glass-3"
                />
              </div>
            )}
            <div className="flex-1 min-w-0">
              {parsed?.title && (
                <h2 className="text-lg font-semibold text-primary line-clamp-2 mb-1">
                  {parsed.title}
                </h2>
              )}
              {parsed?.author && (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-secondary">UP主</span>
                  <span className="text-sm font-medium text-accent">{parsed.author}</span>
                </div>
              )}
            </div>

            {/* Bilibili Logo */}
            <div className="flex-shrink-0">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#00aeec] to-[#4dc9ff] flex items-center justify-center">
                <span className="text-white font-bold text-sm">B</span>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* 视频信息：UP主 / 分P数量 */}
      <ParseInfoPanel platform="bilibili" data={parsed} title="视频信息" />

      {/* 文案：视频信息与下载按钮之间，可一键复制 */}
      {parsed?.desc && <CaptionBox text={parsed.desc} title="视频简介" />}

      {/* Video：封面 + 播放。多分P 下载由下方「下载选项」列表提供，避免重复 */}
      {hasVideo && primaryVideoUrl && (
        <VideoPosterCard
          url={primaryVideoUrl}
          cover={posterUrl}
          alt={parsed?.title || "视频封面"}
          accent="blue"
          tall
          showDownload={false}
        />
      )}

      {/* Download Options：直链新标签 */}
      {hasVideo && (
        <Card className="p-5">
          <h3 className="text-sm font-semibold text-primary mb-4 flex items-center gap-2">
            <svg
              className="w-4 h-4 text-accent"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth={2}>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
              />
            </svg>
            下载选项 ({videoItems.length})
          </h3>

          <div className="space-y-3">
            {videoItems.map((item, index) => (
              <div
                key={index}
                className="flex items-center justify-between p-4 rounded-xl bg-glass-2 hover:bg-glass-3 transition-colors duration-200">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-glass-2 flex items-center justify-center">
                    <span className="text-xs font-bold text-accent">
                      {index + 1}
                    </span>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-primary">
                      {item.title || `视频 ${index + 1}`}
                    </p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                      {item.durationFormat && (
                        <span className="text-xs text-muted">
                          {item.durationFormat}
                        </span>
                      )}
                      {Array.isArray(item.accept) && item.accept.length > 0 && (
                        <span className="rounded-md bg-glass-2 px-1.5 py-0.5 text-[11px] text-accent">
                          {item.accept.join(" / ")}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <Button
                  asChild
                  size="sm"
                  className="bg-gradient-to-r from-[#00aeec] to-[#4dc9ff] hover:opacity-90">
                  <a href={item.url} target="_blank" rel="noopener noreferrer">
                    <Download className="h-4 w-4" />
                    下载
                  </a>
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}

    </div>
  );
}
