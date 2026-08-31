"use client";
import React from "react";
import { ApiResponse, ParseData } from "@/types/api";
import VideoPosterCard from "./VideoPosterCard";
import ParseInfoPanel from "./ParseInfoPanel";
import CaptionBox from "./CaptionBox";

interface PipigxVideoProps {
  data: ApiResponse;
}

export default function PipigxVideo({ data }: PipigxVideoProps) {
  if (!data.data) {
    return null;
  }

  const pipigxData = data.data as ParseData;

  return (
    <div className="space-y-5" style={{ touchAction: 'pan-y' }}>
      <ParseInfoPanel data={pipigxData} title="作品信息" />

      {/* 文案：视频信息与下载按钮之间，可一键复制 */}
      {pipigxData.title && <CaptionBox text={pipigxData.title} title="文案" />}

      {pipigxData.url && (
        <VideoPosterCard
          url={pipigxData.url}
          cover={pipigxData.cover}
          alt={pipigxData.title || "视频封面"}
          accent="blue"
        />
      )}

    </div>
  );
}
