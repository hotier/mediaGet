// 临时调试：不存在的推文 id=0000... 走了哪条路径
// @ts-nocheck
import { describe, it } from "vitest";
import { parseVideoId, parseViaFixer, parseViaSyndication } from "@/app/api/twitter/route";
import { writeFileSync } from "node:fs";

describe("debug ghost tweet", () => {
  it("追踪不存在推文的解析路径", async () => {
    const fixer = await parseViaFixer("0000000000000000000");
    const synd = await parseViaSyndication("0000000000000000000");
    const final = await parseVideoId("0000000000000000000");
    const out = JSON.stringify({ fixer, synd, final }, null, 2);
    writeFileSync("d:/My_code/mediaGet/tests/ghost-output.json", out, "utf8");
  }, 90000);
}, 90000);
