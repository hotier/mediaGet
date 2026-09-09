"use client";

/**
 * AMLL 动态背景的 React 客户端壳（对 amll-background 的懒加载入口）。
 *
 * 与 amll-player.tsx 同套路：核心模块依赖真实 DOM / WebGL / Pixi，
 * 因此经 next/dynamic ssr:false 引用，让动态背景不参与服务端预渲染。
 * 数据流：LyricPage 在封面可用且整页歌词展开时挂载本组件；
 * 封面变化时仅触发内部 setAlbum，库内完成旧图 → 新图淡入过渡。
 */
import dynamic from "next/dynamic";
import { memo } from "react";
import type { AmllBackgroundProps } from "./amll-background";

const AmllBackgroundImpl = dynamic(() => import("./amll-background"), {
  ssr: false,
});

export type { AmllBackgroundProps } from "./amll-background";

export default memo(function AmllBackground(props: AmllBackgroundProps) {
  return <AmllBackgroundImpl {...props} />;
});
