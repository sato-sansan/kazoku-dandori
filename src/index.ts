import type { Env } from "./env";
import { verifySignature, type LineEvent } from "./line";

export { Family } from "./family";
export { Directory } from "./directory";

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname !== "/line/webhook") {
      return new Response("だんどりさん", { status: url.pathname === "/" ? 200 : 404 });
    }
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    const body = await request.text();
    const signature = request.headers.get("x-line-signature");
    if (!(await verifySignature(body, signature, env.LINE_CHANNEL_SECRET))) {
      return new Response("Unauthorized", { status: 401 });
    }

    // 2秒以内に200を返す。ここでは家族ごとの箱に入れるだけ
    const { events } = JSON.parse(body) as { events: LineEvent[] };
    const directory = env.DIRECTORY.get(env.DIRECTORY.idFromName("directory"));
    await Promise.all(
      events.map(async (event) => {
        let familyId = event.source.groupId ?? event.source.roomId;
        // 1対1のトークは、グループで登録した大人だけ。知らない人・子どもには応じない
        if (!familyId && event.source.userId) {
          familyId = (await directory.familyOf(event.source.userId)) ?? undefined;
          if (!familyId) return;
        }
        if (!familyId) return;
        await env.FAMILY.get(env.FAMILY.idFromName(familyId)).enqueue(familyId, event);
      }),
    );
    return new Response("OK");
  },
} satisfies ExportedHandler<Env>;
