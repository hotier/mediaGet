/** 歌词行：time<0 表示无时间轴文本（顶部纯文本行） */
export interface LyricLine {
  time: number;
  text: string;
}

/** 解析 LRC 歌词文本 → 歌词行数组 */
export function parseLrc(raw: string): LyricLine[] {
  const lines: LyricLine[] = [];
  raw.split(/\r?\n/).forEach((line) => {
    const text = line.trim();
    if (!text) return;
    const m = /^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/.exec(text);
    if (m) {
      const time = Number(m[1]) * 60 + Number(m[2]);
      lines.push({ time, text: m[3].trim() });
    } else {
      lines.push({ time: -1, text });
    }
  });
  return lines;
}

/** 根据当前播放位置取高亮的歌词行下标（无则 -1） */
export function getActiveLyricIndex(lines: LyricLine[], currentTime: number): number {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time >= 0 && lines[i].time <= currentTime) idx = i;
  }
  return idx;
}
