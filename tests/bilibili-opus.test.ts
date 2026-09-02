// @ts-nocheck
import { describe, expect, it } from "vitest";
import { classifyOpusDetail } from "@/lib/bilibili-opus.js";

/** 用图文 item 组装完整 detail 响应（与真实接口外层一致） */
function wrapDetail(item) {
  return { code: 0, data: { item, res: { code: 0 } } };
}

/** 纯图文 item：EWEADN前行者 鼠标垫宣发动态（DYNAMIC_TYPE_DRAW，默认单图） */
function drawItem(pics = [{ url: "http://i0.hdslb.com/bfs/new_dyn/pic1" }]) {
  return {
    type: "DYNAMIC_TYPE_DRAW",
    modules: {
      module_author: {
        mid: 3493259242375305,
        name: "EWEADN前行者",
        face: "http://i1.hdslb.com/bfs/face/avatar.jpg",
        pub_ts: 1769395574,
      },
      module_dynamic: {
        major: {
          opus: {
            title: "经典设计美学——前行者ES98",
            pics,
            summary: { text: "以精工细作，雕琢每一处光影与弧度" },
          },
        },
      },
      module_stat: {
        like: { count: 1129 },
        comment: { count: 1936 },
        forward: { count: 1645 },
      },
    },
  };
}

describe("classifyOpusDetail：图文动态分类与归一", () => {
  it("DYNAMIC_TYPE_DRAW 纯图文 → ok，图片 http 转 https 且全量归入 images", () => {
    const out = classifyOpusDetail(
      wrapDetail(
        drawItem([
          { url: "http://i0.hdslb.com/bfs/new_dyn/pic1" },
          { url: "http://i0.hdslb.com/bfs/new_dyn/pic2" },
        ])
      )
    );
    expect(out.ok).toBe(true);
    expect(out.data.type).toBe("image");
    expect(out.data.images).toEqual([
      "https://i0.hdslb.com/bfs/new_dyn/pic1",
      "https://i0.hdslb.com/bfs/new_dyn/pic2",
    ]);
    expect(out.data.cover).toBe("https://i0.hdslb.com/bfs/new_dyn/pic1");
    expect(out.data.title).toBe("经典设计美学——前行者ES98");
    expect(out.data.desc).toBe("以精工细作，雕琢每一处光影与弧度");
    expect(out.data.author).toBe("EWEADN前行者");
    expect(out.data.authorId).toBe("3493259242375305");
    expect(out.data.authorUrl).toBe("https://space.bilibili.com/3493259242375305");
    expect(out.data.avatar).toBe(
      `/api/image?url=${encodeURIComponent(
        "https://i1.hdslb.com/bfs/face/avatar.jpg"
      )}`
    );
    expect(out.data.time).toBe(1769395574);
    expect(out.data.stat).toEqual({ like: 1129, reply: 1936, share: 1645 });
  });

  it("DYNAMIC_TYPE_OPUS（新版图文）同样支持", () => {
    const out = classifyOpusDetail(
      wrapDetail({ ...drawItem(), type: "DYNAMIC_TYPE_OPUS" })
    );
    expect(out.ok).toBe(true);
    expect(out.data.images.length).toBeGreaterThan(0);
  });

  it("DYNAMIC_TYPE_ARTICLE（专栏文章）→ 拒绝并提示专栏", () => {
    const out = classifyOpusDetail(
      wrapDetail({ ...drawItem(), type: "DYNAMIC_TYPE_ARTICLE" })
    );
    expect(out.ok).toBe(false);
    expect(out.msg).toContain("专栏");
  });

  it("纯文字动态（DRAW 无 pics）→ 拒绝并提示不包含图片", () => {
    const out = classifyOpusDetail(wrapDetail(drawItem([])));
    expect(out.ok).toBe(false);
    expect(out.msg).toContain("不包含图片");
  });

  it("视频/其它动态类型 → 拒绝并提示不是图文内容", () => {
    const out = classifyOpusDetail(
      wrapDetail({ ...drawItem(), type: "DYNAMIC_TYPE_AV" })
    );
    expect(out.ok).toBe(false);
    expect(out.msg).toContain("不是图文内容");
  });

  it("detail 缺失 item（接口异常）→ 解析失败", () => {
    expect(classifyOpusDetail({ code: -352, message: "风控" })).toEqual({
      ok: false,
      msg: "解析失败！",
    });
  });
});
