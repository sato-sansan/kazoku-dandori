import type { Env } from "./env";
import { verifySignature, type LineEvent } from "./line";

export { Family } from "./family";

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
    await Promise.all(
      events.map((event) => {
        // 相手は大人のグループだけ。1対1のトークには応じない（子どもと直接話さないため）
        const familyId = event.source.groupId ?? event.source.roomId;
        if (!familyId) return;
        return env.FAMILY.get(env.FAMILY.idFromName(familyId)).enqueue(familyId, event);
      }),
    );
    return new Response("OK");
  },
} satisfies ExportedHandler<Env>;
