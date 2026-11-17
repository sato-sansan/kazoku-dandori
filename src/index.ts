import type { Env } from "./env";
import { verifySignature, type LineEvent } from "./line";

export { Family } from "./family";
export { Directory } from "./directory";

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    // だんどり帳の編集（送迎の担当・予定や写真を消す・呼び名）。合言葉を知っている人だけ。
    // ほかのサイトからは送らせない：Origin が違えば断り、JSON だけ受ける（よそのページからの JSON の送信は、事前の確認で止まる）
    const edit = /^\/c\/([a-z0-9]{10})\/edit$/.exec(url.pathname);
    if (edit) {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const origin = request.headers.get("Origin");
      if ((origin && origin !== url.origin) || !(request.headers.get("Content-Type") ?? "").startsWith("application/json")) {
        return new Response("Forbidden", { status: 403 });
      }
      const familyId = await env.DIRECTORY.get(env.DIRECTORY.idFromName("directory")).familyOfToken(edit[1]);
      if (!familyId) return new Response("Not Found", { status: 404 });
      const raw = await request.text();
      let body: unknown = null;
      try {
        body = raw.length <= 10_000 ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) return new Response("Bad Request", { status: 400 });
      const result = await env.FAMILY.get(env.FAMILY.idFromName(familyId)).pageAction(body as Record<string, unknown>);
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    }

    // Google カレンダー用の購読（見るだけ）。だんどり帳とは別の合言葉（台帳では "i:" つき）
    const feed = /^\/i\/([a-z0-9]{10})\.ics$/.exec(url.pathname);
    if (feed && request.method === "GET") {
      const familyId = await env.DIRECTORY.get(env.DIRECTORY.idFromName("directory")).familyOfToken(`i:${feed[1]}`);
      if (!familyId) return new Response("Not Found", { status: 404 });
      return new Response(await env.FAMILY.get(env.FAMILY.idFromName(familyId)).calendarIcs(), {
        headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "Content-Type": "text/calendar; charset=utf-8" },
      });
    }

    // 家族のカレンダー。長い合言葉を知っている人だけ。ログインはない。
    // 前に配った /c/<合言葉>.ics もそのまま見られる（もう貼ってある Google カレンダーを止めない）
    const cal = /^\/c\/([a-z0-9]{10})(\.ics|\/photo\/(\d+))?$/.exec(url.pathname);
    if (cal && request.method === "GET") {
      const familyId = await env.DIRECTORY.get(env.DIRECTORY.idFromName("directory")).familyOfToken(cal[1]);
      if (!familyId) return new Response("Not Found", { status: 404 });
      const family = env.FAMILY.get(env.FAMILY.idFromName(familyId));
      const noStore = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
      if (cal[3]) {
        const photo = await family.photo(Number(cal[3]));
        if (!photo) return new Response("Not Found", { status: 404 });
        return new Response(photo.body, { headers: { ...noStore, "Content-Type": photo.contentType } });
      }
      if (cal[2] === ".ics") {
        return new Response(await family.calendarIcs(), {
          headers: { ...noStore, "Content-Type": "text/calendar; charset=utf-8" },
        });
      }
      const view = url.searchParams.get("view") === "week" ? "week" : "month";
      const anchor = url.searchParams.get("anchor") ?? undefined;
      return new Response(await family.calendarPage(`${url.origin}/c/${cal[1]}`, view, anchor), {
        headers: { ...noStore, "Content-Type": "text/html; charset=utf-8" },
      });
    }

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
