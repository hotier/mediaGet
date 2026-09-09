import { SEARCH_SOURCES, SELF_SEARCH_SOURCES, type SearchSourceKey } from "./types";

/** 搜索源 chip 的统一展示形态：内置 GD 源 + 内置自研直连搜索源 + 动态加载的 lx 脚本扩展源 */
export interface SearchChip {
  key: SearchSourceKey;
  label: string;
  color: string;
  /** 是否为内置自研直连搜索源（站点服务端直连音源搜索接口，不经 GD；无品牌 logo 时改渲染彩色圆点） */
  self?: boolean;
  /** 是否为 lx 脚本扩展源（扩展源没有品牌 logo，chip 改渲染彩色圆点区分） */
  ext?: boolean;
}

/** lx 扩展源 chip 的强调色：脚本自报名称但无品牌色，按出现顺序轮换配色 */
export const LX_SOURCE_COLORS = [
  "#a855f7",
  "#0ea5e9",
  "#f43f5e",
  "#f59e0b",
  "#10b981",
  "#ec4899",
];

/**
 * 引擎注册表视图：由「内置 GD 源 + 内置自研直连搜索源 + 动态加载的 lx 扩展源目录」
 * 合并出可选搜索源 chips。内置源固定在前、key 冲突时内置优先；扩展源没有品牌 logo，
 * chip 改渲染轮换色点。
 * 新增搜索引擎的接入点：向 SEARCH_SOURCES（GD 聚合源）/ SELF_SEARCH_SOURCES（自研直连
 * 搜索，不经 GD）注册，或部署侧 lx 目录注册即出现在搜索面板；调用方（MusicExplorer /
 * SearchPanel / 各列表面板）无需感知源属于哪个通道引擎。
 */
export function buildSearchChips(
  extSources: ReadonlyArray<{ key: string; label?: string }>
): SearchChip[] {
  const chips: SearchChip[] = [
    ...SEARCH_SOURCES.map((s) => ({ key: s.key, label: s.label, color: s.color })),
    ...SELF_SEARCH_SOURCES.map((s) => ({
      key: s.key,
      label: s.label,
      color: s.color,
      self: true,
    })),
  ];
  const builtinKeys = new Set(chips.map((c) => c.key));
  for (const s of extSources || []) {
    if (!s || !s.key || builtinKeys.has(s.key)) continue;
    chips.push({
      key: s.key,
      label: s.label || s.key,
      color: LX_SOURCE_COLORS[chips.length % LX_SOURCE_COLORS.length],
      ext: true,
    });
  }
  return chips;
}

/**
 * 「链接解析」产物平台的展示元信息（source 键按 GD 直链通道命名）。kugou / migu 亦以内置
 * 自研直连搜索源 chip 出现（sourceMetaFor 优先命中 chip）；tencent 搜索引擎默认停用（部署侧
 * MUSIC_PLATFORM_SEARCH 可开启），但链接解析 / 历史缓存仍可能携带 tencent 产物，故保留兜底
 * 文案/配色；未收录平台退回原始 source 键。
 */
export const RESOLVE_EXTRA_META: Record<string, { label: string; color: string }> = {
  tencent: { label: "QQ音乐", color: "#31c27c" },
  kugou: { label: "酷狗音乐", color: "#0fa5e9" },
  migu: { label: "咪咕音乐", color: "#ee3a8a" },
};

/**
 * 行内「来源」展示元信息：先按 chip（内置源/扩展源）命中，链接解析专属平台
 * （如 tencent）走 RESOLVE_EXTRA_META，均未命中则退回原始 source 键。
 */
export const sourceMetaFor = (
  key: string,
  chips: SearchChip[]
): { label: string; color: string } => {
  const chip = chips.find((s) => s.key === key);
  if (chip) return chip;
  const extra = RESOLVE_EXTRA_META[key];
  return {
    label: extra?.label ?? (key || "未知平台"),
    color: extra?.color ?? "",
  };
};
