"use client";

import type { CSSProperties, Dispatch, FormEvent, SetStateAction } from "react";
import { AlertCircle, Link2, Loader2, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SearchSourceKey } from "@/components/music/types";
import { PlatformIcon } from "@/components/music/platform-icons";
import type { SearchChip } from "./source-meta";

export interface SearchPanelProps {
  mode: "search" | "resolve";
  setMode: Dispatch<SetStateAction<"search" | "resolve">>;
  keyword: string;
  setKeyword: Dispatch<SetStateAction<string>>;
  link: string;
  setLink: Dispatch<SetStateAction<string>>;
  searching: boolean;
  resolving: boolean;
  searchError: string;
  resolveError: string;
  setSearchError: Dispatch<SetStateAction<string>>;
  setResolveError: Dispatch<SetStateAction<string>>;
  source: SearchSourceKey;
  /** 全部可选的搜索源 chip（内置 GD 源 + 自研直连搜索源 + 扩展源） */
  sourceChips: SearchChip[];
  /** 当前搜索源的展示名（如“我的网易云源”），用于搜索框占位 */
  sourceLabel: string;
  /** 聚合搜索模式：一次并发搜索全部音源，跨源合并去重 + 按相关度打分排序 */
  aggActive: boolean;
  setAggActive: Dispatch<SetStateAction<boolean>>;
  runSearch: (arg?: FormEvent<HTMLFormElement> | string) => void;
  runResolve: (arg?: FormEvent<HTMLFormElement>) => void;
  switchSource: (next: SearchSourceKey) => void;
}

/**
 * 发现歌曲页的搜索面板：关键词搜索 / 粘贴链接解析 两个模式的表单、
 * 音源 chip 行、热门标签与错误提示。纯受控展示组件，交互回调来自父级。
 */
export default function SearchPanel({
  mode,
  setMode,
  keyword,
  setKeyword,
  link,
  setLink,
  searching,
  resolving,
  searchError,
  resolveError,
  setSearchError,
  setResolveError,
  source,
  sourceChips,
  sourceLabel,
  aggActive,
  setAggActive,
  runSearch,
  runResolve,
  switchSource,
}: SearchPanelProps) {
  const tags = ["周杰伦", "林俊杰", "陈奕迅", "Beyond", "稻香"];
  const searchMode = mode === "search";
  const switchMode = (next: "search" | "resolve") => {
    if (next === mode) return;
    setMode(next);
    setResolveError("");
    setSearchError("");
  };
  return (
    <div className="mp-scroll">
      <div className="mp-hero">
        <h1>{searchMode ? "发现好音乐" : "链接直达歌曲"}</h1>
        <p className="mp-hero-sub">
          {searchMode
            ? "统一接入多个音源，搜索即试听，一点即下载"
            : "粘贴歌曲分享链接，一步解析成可试听 / 下载的曲目"}
        </p>

        <div className="mp-mode-seg" role="tablist" aria-label="歌曲查找方式">
          <button
            type="button"
            role="tab"
            aria-selected={searchMode}
            className={cn("mp-mode-btn", searchMode && "is-active")}
            onClick={() => switchMode("search")}>
            <Search />
            关键词搜索
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={!searchMode}
            className={cn("mp-mode-btn", !searchMode && "is-active")}
            onClick={() => switchMode("resolve")}>
            <Link2 />
            粘贴链接解析
          </button>
        </div>

        {searchMode ? (
          <>
            <form className="mp-search-big" onSubmit={runSearch}>
              <Search />
              <input
                value={keyword}
                onChange={(e) => {
                  setKeyword(e.target.value);
                  if (searchError) setSearchError("");
                }}
                placeholder={
                  aggActive
                    ? "聚合搜索全部音源：歌名 / 歌手（并集去重 + 相关度排序）"
                    : `在 ${sourceLabel} 中搜索歌曲 / 歌手`
                }
                autoComplete="off"
              />
              <button
                type="submit"
                title="搜索"
                disabled={searching || !keyword.trim()}>
                {searching ? <Loader2 className="mp-spin" /> : <Search />}
              </button>
            </form>

            <div className="mp-chiprow">
              {/* 聚合搜索伪 chip：一次搜全部音源（独立于单源 chip，不写入 source 状态） */}
              <button
                type="button"
                aria-pressed={aggActive}
                title="聚合搜索：一次搜索全部音源，跨源合并去重并按相关度排序展示"
                className={cn("mp-src-chip", "mp-src-chip-agg", aggActive && "is-active")}
                style={{ "--sc": "var(--mp-primary)" } as CSSProperties}
                onClick={() => setAggActive(!aggActive)}>
                <span className="dot" aria-hidden="true" />
                聚合搜索
              </button>
              {sourceChips.map((s) => {
                // 聚合模式下列表来源混合，source 仅是“退出聚合后的回退值”，不视为当前选中
                const active = !aggActive && source === s.key;
                return (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => switchSource(s.key)}
                    title={
                      s.ext
                        ? `洛雪扩展音源 · ${s.label}`
                        : s.self
                          ? `自研直连搜索 · ${s.label}（站点直连音源，不经 GD 上游）`
                          : `切到 ${s.label}`
                    }
                    className={cn(
                      "mp-src-chip",
                      active && "is-active",
                      s.ext && "mp-src-chip-ext",
                      s.self && "mp-src-chip-self"
                    )}
                    style={{ "--sc": s.color } as CSSProperties}>
                    {s.ext || s.self ? (
                      <span className="dot" aria-hidden="true" />
                    ) : (
                      <PlatformIcon source={s.key} />
                    )}
                    {s.label}
                  </button>
                );
              })}
            </div>

            {!searching && (
              <div className="mp-tags">
                {tags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className="mp-tag"
                    onClick={() => runSearch(tag)}>
                    {tag}
                  </button>
                ))}
              </div>
            )}

            {searchError && (
              <div
                className="mp-error"
                style={{ width: "min(520px,100%)", marginTop: 14 }}>
                <AlertCircle />
                <span>{searchError}</span>
              </div>
            )}
          </>
        ) : (
          <>
            <form className="mp-search-big mp-link-form" onSubmit={runResolve}>
              <Link2 />
              <input
                value={link}
                onChange={(e) => {
                  setLink(e.target.value);
                  if (resolveError) setResolveError("");
                }}
                placeholder="粘贴歌曲分享链接，如 https://music.163.com/song?id=…"
                autoComplete="off"
                spellCheck={false}
                inputMode="url"
              />
              <button
                type="submit"
                title="解析歌曲"
                disabled={resolving || !link.trim()}>
                {resolving ? <Loader2 className="mp-spin" /> : <Link2 />}
              </button>
            </form>

            <p className="mp-resolve-tip">
              支持：<strong>网易云音乐 / QQ音乐 / 酷我音乐</strong> 歌曲链接直接解析播放；
              <span className="dim">
                酷狗歌曲链接可识别，直链引擎接入后开放
              </span>
            </p>

            {resolveError && (
              <div
                className="mp-error"
                style={{ width: "min(560px,100%)", marginTop: 12 }}>
                <AlertCircle />
                <span>{resolveError}</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
