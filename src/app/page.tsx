"use client";
import { useState, useEffect } from "react";
import VideoParserForm from "@/components/VideoParserForm";
import PlatformIcon from "@/components/PlatformIcon";
import { renderPlatformResult } from "@/components/videos/platform-renderers";
import { ApiResponse } from "@/types/api";
import { VIDEO_PLATFORMS, type VideoPlatformKey } from "@/config/video-platforms";
import { siteConfig } from "@/config/site";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { AlertCircle, Check, ChevronDown, X, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

// 平台名称单一数据源：从配置读取，避免与代码脱节（之前 README/SEO 只列了 7 个，实际 24 个）
const PLATFORM_NAMES = Object.values(VIDEO_PLATFORMS).map((p) => p.name);

// 首页会话：切页返回 / 刷新后恢复解析结果与错误提示（同一标签页会话内保留）
const HOME_SESSION_KEY = "mediaGet-home-session";

// 入场动画是否已播放：整页加载时为 false（首次进入/刷新播放 reveal 动画）；
// SPA 切页返回时模块不会重新执行、introPlayed 仍为 true，据此跳过动画避免画面抖动。
// 服务端渲染不执行组件 effect，恒为 false，保证首屏 HTML 一致输出动画版。
let introPlayed = false;

export default function Home() {
  const [result, setResult] = useState<ApiResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [pickedPlatform, setPickedPlatform] = useState<VideoPlatformKey | "auto" | null>(null);
  const [pickNonce, setPickNonce] = useState(0);
  const [activePlatform, setActivePlatform] = useState<VideoPlatformKey | "auto">("auto");

  // 入场动画仅整页加载（首进/刷新）播放一次：
  // SPA 切页返回时模块级 introPlayed 仍为 true → 跳过动画、直接稳定显示
  const [enterAnimated] = useState(() => !introPlayed);
  const [mounted, setMounted] = useState(
    () => typeof window !== "undefined" && introPlayed
  );

  useEffect(() => {
    introPlayed = true;
    setMounted(true);
  }, []);

  // 挂载时恢复上次会话的结果 / 错误 / 平台高亮
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(HOME_SESSION_KEY);
      if (!raw) return;
      const saved: {
        result?: ApiResponse | null;
        error?: string;
        activePlatform?: VideoPlatformKey | "auto";
      } = JSON.parse(raw);
      if (saved.result && (saved.result.code === 1 || saved.result.code === 200)) {
        setResult(saved.result);
      }
      if (typeof saved.error === "string") setError(saved.error);
      if (saved.activePlatform) setActivePlatform(saved.activePlatform);
    } catch {
      // 损坏的会话数据：忽略
    }
  }, []);

  // 结果 / 错误 / 平台变化时同步会话
  useEffect(() => {
    try {
      sessionStorage.setItem(
        HOME_SESSION_KEY,
        JSON.stringify({ result, error, activePlatform })
      );
    } catch {
      // 配额满或不可写：静默失败
    }
  }, [result, error, activePlatform]);

  const handleParseResult = (
    data: ApiResponse | null,
    errorMsg: string = ""
  ) => {
    setResult(data);
    setError(errorMsg);
  };

  return (
    <>
      {/* Morphing Background */}
      <div className="morphing-bg">
        <div className="orb orb-1" />
        <div className="orb orb-2" />
        <div className="orb orb-3" />
      </div>

      {/* Main Content */}
      <div className="relative" style={{ zIndex: 1 }}>
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
          {/* Hero Section */}
          <header className={cn("text-center mb-8 pt-2 sm:pt-6", enterAnimated && "reveal")}>
            <h1 className="mx-auto max-w-3xl text-3xl sm:text-4xl md:text-5xl font-bold tracking-tight leading-[1.15]">
              粘贴链接，
              <span className="gradient-text">秒出无水印视频</span>
            </h1>
            <p className="mx-auto mt-4 max-w-xl text-sm sm:text-base text-muted leading-relaxed">
              抖音、B站、小红书、快手、微博等 {PLATFORM_NAMES.length}+ 平台通用，免费在线解析下载
            </p>
          </header>

          {/* Body: Form/Results */}
          <div className="max-w-3xl mx-auto">
            <div className={cn(mounted ? "opacity-100" : "opacity-0", enterAnimated && "reveal reveal-delay-2")}>
              <VideoParserForm
                onResult={handleParseResult}
                setLoading={setLoading}
                loading={loading}
                pickedPlatform={pickedPlatform}
                pickNonce={pickNonce}
                onPlatformChange={setActivePlatform}
              />
            </div>

            {/* 平台支持：默认折叠，不挤占首屏；平台项 href 保留供 SEO 收录 */}
            <Collapsible className="mt-4 rounded-2xl border border-border-subtle bg-glass-1 shadow-card backdrop-blur">
              <CollapsibleTrigger className="group flex w-full items-center justify-between px-5 py-3.5 text-sm font-medium text-primary select-none">
                <span className="inline-flex items-center gap-2">
                  <Zap className="h-4 w-4 text-accent" />
                  支持 {PLATFORM_NAMES.length}+ 平台解析
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-xs text-muted group-data-[state=open]:hidden">
                    点击展开
                  </span>
                  <ChevronDown className="h-4 w-4 text-muted transition-transform duration-200 group-data-[state=open]:rotate-180" />
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="px-4 pb-4 pt-1">
                  <nav
                    className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-7"
                    aria-label="选择平台进行解析">
                    {/* 自动识别 */}
                    <button
                      type="button"
                      onClick={() => {
                        setPickedPlatform("auto");
                        setPickNonce((n) => n + 1);
                      }}
                      aria-pressed={activePlatform === "auto"}
                      title="自动识别平台并解析"
                      className={cn(
                        "flex min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-xl border px-2.5 py-2 text-xs transition-colors",
                        activePlatform === "auto"
                          ? "border-accent bg-glass-3 font-medium text-foreground"
                          : "border-border-subtle bg-glass-2 text-secondary hover:border-border-medium hover:bg-glass-3 hover:text-foreground"
                      )}>
                      <span className="h-2 w-2 shrink-0 rounded-full bg-accent" />
                      <span className="truncate">自动识别</span>
                    </button>

                    {Object.entries(VIDEO_PLATFORMS).map(([key, p]) => {
                      const k = key as VideoPlatformKey;
                      const active = activePlatform === k;
                      // 网格内用短名，避免超长名换行/截断（X (Twitter) → X）
                      const label = p.name.replace(" (Twitter)", "");
                      return (
                        <a
                          key={key}
                          href={`/platform/${key}`}
                          onClick={(e) => {
                            e.preventDefault();
                            setPickedPlatform(k);
                            setPickNonce((n) => n + 1);
                          }}
                          title={`解析${p.name}`}
                          aria-current={active ? "true" : undefined}
                          className={cn(
                            "flex min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-xl border px-2.5 py-2 text-xs transition-colors",
                            active
                              ? "border-accent bg-glass-3 font-medium text-foreground"
                              : "border-border-subtle bg-glass-2 text-secondary hover:border-border-medium hover:bg-glass-3 hover:text-foreground"
                          )}>
                          <PlatformIcon platform={k} size={16} />
                          <span className="truncate">{label}</span>
                        </a>
                      );
                    })}
                  </nav>
                </div>
              </CollapsibleContent>
            </Collapsible>

            {/* Error State */}
            {error && (
              <div className={cn("mt-6", enterAnimated && "reveal")}>
                <Card className="border-l-4 border-l-error p-5">
                  <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-500/10">
                      <AlertCircle className="h-5 w-5 text-error" />
                    </div>
                    <div className="flex-1">
                      <h3 className="mb-1 font-semibold text-red-500">解析失败</h3>
                      <p className="text-sm text-red-400/90">{error}</p>
                      <p className="mt-3 text-xs leading-relaxed text-muted">
                        遇到问题？可稍后重试，或更换网络环境后再试；仍无法解决时，
                        可通过邮件联系站长反馈：{siteConfig.contactEmail}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setError("")}
                      aria-label="关闭错误提示">
                      <X />
                    </Button>
                  </div>
                </Card>
              </div>
            )}

            {/* Results Section */}
            {result && (result.code === 1 || result.code === 200) && (
              <div className={cn("mt-6", enterAnimated && "reveal")}>
                <Card className="overflow-hidden">
                  <CardHeader className="flex flex-row items-center justify-between border-b border-border-subtle bg-glass-2">
                    <Badge variant="success">
                      <Check />
                      解析成功
                    </Badge>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setResult(null)}
                      aria-label="关闭结果">
                      <X />
                    </Button>
                  </CardHeader>
                  <CardContent className="p-6" style={{ touchAction: 'manipulation' }}>
                    {renderPlatformResult(result)}
                  </CardContent>
                </Card>
              </div>
            )}

          </div>
        </div>
      </div>
    </>
  );
}
