"use client";
import React, { useState } from "react";
import Image from "next/image";
import { ChevronDown, Download, ExternalLink } from "lucide-react";
import { ApiResponse, ParseData } from "@/types/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import TruncatedText from "@/components/ui/truncated-text";

interface QsMusicVideoProps {
  data: ApiResponse;
}

export default function QsMusicVideo({ data }: QsMusicVideoProps) {
  const [showLyrics, setShowLyrics] = useState(false);

  if (!data.data) {
    return null;
  }

  const musicData = data.data as ParseData;

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="flex items-center gap-4 mb-5">
          {musicData.cover && (
            <Image
              src={musicData.cover}
              alt={musicData.name || "音乐封面"}
              width={80}
              height={80}
              className="rounded-lg border border-border-subtle"
              unoptimized
            />
          )}
          <div className="min-w-0">
            <TruncatedText
              as="h2"
              text={musicData.name || ""}
              className="text-lg font-semibold text-primary line-clamp-2"
            />
            {musicData.core && (
              <p className="text-sm text-secondary mt-1">{musicData.core}</p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {musicData.url && (
            <Button
              asChild
              className="gap-2 bg-gradient-to-r from-purple-500 to-violet-500 hover:opacity-90">
              <a href={musicData.url} target="_blank" rel="noopener noreferrer">
                <Download className="h-4 w-4" />
                下载音乐
              </a>
            </Button>
          )}
          {musicData.url && (
            <Button asChild variant="outline" className="gap-2">
              <a href={musicData.url} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4" />
                新窗口打开
              </a>
            </Button>
          )}
          {musicData.lyrics && (
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => setShowLyrics(!showLyrics)}>
              <ChevronDown className="h-4 w-4" />
              {showLyrics ? "隐藏歌词" : "显示歌词"}
            </Button>
          )}
        </div>
      </Card>

      {showLyrics && musicData.lyrics && (
        <Card className="p-4">
          <h3 className="text-base font-semibold text-primary mb-3">歌词</h3>
          <pre className="whitespace-pre-wrap text-sm text-secondary font-mono">
            {musicData.lyrics}
          </pre>
        </Card>
      )}

      {musicData.copyright && (
        <p className="text-xs text-muted opacity-80 px-1">{musicData.copyright}</p>
      )}
    </div>
  );
}
