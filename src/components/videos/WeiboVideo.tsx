"use client";
import React, { useState } from "react";
import Image from "next/image";
import { ApiResponse, ParseData } from "@/types/api";
import VideoPosterCard from "./VideoPosterCard";
import ParseInfoPanel from "./ParseInfoPanel";
import CaptionBox from "./CaptionBox";
import { downloadAllImages } from "@/utils/downloadImages";
import { Download, Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface WeiboVideoProps {
  data: ApiResponse;
}

export default function WeiboVideo({ data }: WeiboVideoProps) {
  const [downloading, setDownloading] = useState(false);

  if (!data.data) {
    return null;
  }

  const weiboData = data.data as ParseData;
  const images = weiboData.images?.filter(Boolean) || [];
  const isImage = weiboData.type === "image" || (!weiboData.url && images.length > 0);
  const isText = weiboData.type === "text" || (!weiboData.url && images.length === 0);

  const handleDownloadAll = async () => {
    if (downloading || images.length === 0) return;
    setDownloading(true);
    try {
      await downloadAllImages(images, `weibo-${weiboData.author || "图片"}`);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-5" style={{ touchAction: 'pan-y' }}>
      {/* Author Header */}
      <Card className="p-5">
        <div className="flex items-center gap-4">
          {weiboData.avatar && (
            <div className="relative">
              <div className="absolute inset-0 rounded-full bg-gradient-to-br from-[#e6162d] to-[#ff4d6a] blur-sm opacity-50" />
              <Image
                src={weiboData.avatar}
                alt={weiboData.author || ""}
                width={56}
                height={56}
                className="relative rounded-full border-2 border-glass-3"
                unoptimized
              />
            </div>
          )}
          <div className="flex-1 min-w-0">
            {weiboData.author && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-secondary">@</span>
                <span className="text-sm font-medium text-accent">{weiboData.author}</span>
              </div>
            )}
            {weiboData.time && (
              <p className="text-xs text-muted mt-1">{weiboData.time}</p>
            )}
          </div>

          {/* Weibo Logo */}
          <div className="flex-shrink-0">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#e6162d] to-[#ff4d6a] flex items-center justify-center">
              <span className="text-white text-xs font-bold">微博</span>
            </div>
          </div>
        </div>
      </Card>

      {/* 作品信息：博主 / 发布时间 / 内容类型 */}
      <ParseInfoPanel platform="weibo" data={weiboData} title="微博信息" />

      {/* 文案：视频信息与下载按钮之间，可一键复制 */}
      {weiboData.title && <CaptionBox text={weiboData.title} title="博文" />}

      {/* 视频：封面 + 播放/下载（直链新窗口） */}
      {weiboData.url && !isImage && (
        <VideoPosterCard
          url={weiboData.url}
          cover={weiboData.cover}
          alt={weiboData.title || "视频封面"}
          accent="red"
        />
      )}

      {/* 图片/图集：按原图比例展示，点击打开原图直链（可长按/右键保存） */}
      {isImage && images.length > 0 && (
        <div className="space-y-3">
          {images.length === 1 ? (
            <a
              href={images[0]}
              target="_blank"
              rel="noopener noreferrer"
              className="block rounded-2xl overflow-hidden border border-border-subtle bg-black">
              <Image
                src={images[0]}
                alt={weiboData.title || "微博图片"}
                width={800}
                height={800}
                className="w-full h-auto object-contain max-h-[70vh]"
                unoptimized
              />
            </a>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {images.map((src, i) => (
                <a
                  key={`${src}-${i}`}
                  href={src}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="relative aspect-square rounded-lg overflow-hidden border border-border-subtle bg-black group">
                  <Image
                    src={src}
                    alt={`${weiboData.title || "微博图片"}-${i + 1}`}
                    fill
                    className="object-contain p-1 transition-transform duration-300 group-hover:scale-105"
                    unoptimized
                  />
                </a>
              ))}
            </div>
          )}

          {/* 一键下载全部图片 */}
          <Button
            type="button"
            onClick={handleDownloadAll}
            disabled={downloading}
            size="lg"
            className="w-full bg-gradient-to-r from-[#e6162d] to-[#ff4d6a] hover:opacity-90">
            {downloading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                正在下载...
              </>
            ) : (
              <>
                <Download className="h-5 w-5" />
                一键下载全部图片（{images.length} 张）
              </>
            )}
          </Button>
        </div>
      )}

      {/* 纯文字微博：无媒体可下载，展示提示而非报错 */}
      {isText && (
        <Card className="p-6 text-center">
          <p className="text-sm text-muted leading-relaxed">
            该微博仅包含文字内容，无可下载的视频或图片
          </p>
        </Card>
      )}

    </div>
  );
}
