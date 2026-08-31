"use client";
import React from "react";
import Image from "next/image";
import { ApiResponse, ParseData } from "@/types/api";
import VideoPosterCard from "./VideoPosterCard";
import ParseInfoPanel from "./ParseInfoPanel";
import CaptionBox from "./CaptionBox";
import { Card } from "@/components/ui/card";

interface PpxiaVideoProps {
  data: ApiResponse;
}

export default function PpxiaVideo({ data }: PpxiaVideoProps) {
  if (!data.data) {
    return null;
  }

  const ppxiaData = data.data as ParseData;

  return (
    <div className="space-y-5" style={{ touchAction: 'pan-y' }}>
      {/* 作者卡片 */}
      {(ppxiaData.avatar || ppxiaData.author) && (
        <Card className="p-4">
          <div className="flex items-center gap-4">
            {ppxiaData.avatar && (
              <Image
                src={ppxiaData.avatar}
                alt={ppxiaData.author || ""}
                width={48}
                height={48}
                className="rounded-full"
                unoptimized
              />
            )}
            {ppxiaData.author && (
              <p className="text-secondary text-left">{ppxiaData.author}</p>
            )}
          </div>
        </Card>
      )}

      <ParseInfoPanel data={ppxiaData} title="作品信息" />

      {/* 文案：视频信息与下载按钮之间，可一键复制 */}
      {ppxiaData.title && <CaptionBox text={ppxiaData.title} title="文案" />}

      {ppxiaData.url && (
        <VideoPosterCard
          url={ppxiaData.url}
          cover={ppxiaData.cover}
          alt={ppxiaData.title || "视频封面"}
          accent="blue"
        />
      )}

    </div>
  );
}
