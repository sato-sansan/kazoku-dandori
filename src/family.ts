import { DurableObject } from "cloudflare:workers";
import { firstQuestion, type Card, type CardSource } from "./card";
import type { Env } from "./env";
import { fetchImage, push, reply, withButtons, type LineEvent, type OutMessage } from "./line";
import { loadProfile } from "./profile";
import { readNotice, type ReadInput } from "./reader";

// 返信トークンは1分以内が目安。余裕をみて、これを過ぎたらプッシュで届ける
const REPLY_WINDOW_MS = 50_000;
const SEEN_KEEP_MS = 2 * 24 * 60 * 60 * 1000;

const GREETING = `だんどりさんです。このグループの発言と写真を読んで、予定にします。
写真は読むために Claude へ送り、だんどりさんの中には保存しません。外への連絡を勝手に送ることはありません。
お便りの写真を送ってみてください。`;

interface QueuedEvent {
  familyId: string;
  event: LineEvent;
  receivedAt: number;
}

interface Batch extends Record<string, SqlStorageValue> {
  id: number;
  cards: string;
}

/** 家族ごとに1つ。受け取りは急いで行い、Claude を呼ぶ重い処理はアラームの中で行う */
export class Family extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, payload TEXT NOT NULL, received_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT,
        source TEXT NOT NULL,
        cards TEXT NOT NULL,
        status TEXT NOT NULL,
        awaiting TEXT,
        created_at INTEGER NOT NULL
      );
    `);
  }

  /** Webhook から呼ばれる。LINE の再送は webhookEventId で捨てる */
  async enqueue(familyId: string, event: LineEvent) {
    const now = Date.now();
    this.sql.exec("DELETE FROM seen WHERE at < ?", now - SEEN_KEEP_MS);
    const fresh = this.sql
      .exec("INSERT OR IGNORE INTO seen (id, at) VALUES (?, ?) RETURNING id", event.webhookEventId, now)
      .toArray();
    if (fresh.length === 0) return;

    const queued: QueuedEvent = { familyId, event, receivedAt: now };
    this.sql.exec(
      "INSERT INTO inbox (id, payload, received_at) VALUES (?, ?, ?)",
      event.webhookEventId,
      JSON.stringify(queued),
      now,
    );
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(now);
    }
  }

  async alarm() {
    const rows = this.sql.exec("SELECT id, payload FROM inbox ORDER BY received_at").toArray();
    for (const row of rows) {
      const queued = JSON.parse(row.payload as string) as QueuedEvent;
      try {
        await this.handle(queued);
      } catch (error) {
        console.error("handle failed", queued.event.type, error instanceof Error ? error.message : "");
        if (queued.event.message?.type === "image") {
          await this.send(queued, [
            { type: "text", text: "うまく読めませんでした。もう一度写真を送ってください。" },
          ]).catch(() => console.error("failure notice failed"));
        }
      }
      this.sql.exec("DELETE FROM inbox WHERE id = ?", row.id);
    }
  }

  private async handle(queued: QueuedEvent) {
    const { event } = queued;
    if (event.type === "join") {
      await this.send(queued, [{ type: "text", text: GREETING }]);
    } else if (event.type === "unsend" && event.unsend) {
      this.sql.exec(
        "UPDATE batches SET cards = '[]', status = 'removed', awaiting = NULL WHERE message_id = ?",
        event.unsend.messageId,
      );
    } else if (event.type === "message" && event.message?.type === "image") {
      const image = await fetchImage(this.env.LINE_CHANNEL_ACCESS_TOKEN, event.message.id);
      if (image) await this.read(queued, { image }, "写真");
    } else if (event.type === "message" && event.message?.type === "text") {
      await this.handleText(queued, event.message.text ?? "");
    }
  }

  private async handleText(queued: QueuedEvent, text: string) {
    const button = /^(OK|直す) #(\d+)$/.exec(text.trim());
    if (!button) {
      await this.read(queued, { text }, "ひとこと");
      return;
    }

    const [, action, id] = button;
    if (action === "OK") {
      const done = this.sql
        .exec("UPDATE batches SET status = 'ok', awaiting = NULL WHERE id = ? AND status = 'pending' RETURNING id", id)
        .toArray();
      if (done.length > 0) await this.send(queued, [{ type: "text", text: "予定に入れました。" }]);
    } else {
      const open = this.sql
        .exec("UPDATE batches SET awaiting = 'fix' WHERE id = ? AND status = 'pending' RETURNING id", id)
        .toArray();
      if (open.length > 0) {
        await this.send(queued, [{ type: "text", text: "どこを直しますか？ひとことで送ってください。" }]);
      }
    }
  }

  private async read(queued: QueuedEvent, input: Pick<ReadInput, "text" | "image">, source: CardSource) {
    // 文は聞き返しや直しへの答えかもしれない。新しい写真は別の連絡として読む
    const awaiting = input.text
      ? this.sql
          .exec<Batch>("SELECT id, cards FROM batches WHERE awaiting IS NOT NULL AND status = 'pending' ORDER BY id DESC LIMIT 1")
          .toArray()[0]
      : undefined;

    const result = await readNotice(this.env.ANTHROPIC_API_KEY, {
      ...input,
      profile: loadProfile(this.env.FAMILY_PROFILE),
      previousCards: awaiting ? (JSON.parse(awaiting.cards) as Card[]) : undefined,
    });
    // 雑談には黙っている
    if (!result.is_notice || result.cards.length === 0) return;

    if (awaiting) {
      this.sql.exec("UPDATE batches SET status = 'replaced', awaiting = NULL WHERE id = ?", awaiting.id);
    }
    const question = firstQuestion(result.cards);
    const batch = this.sql
      .exec<{ id: number }>(
        `INSERT INTO batches (message_id, source, cards, status, awaiting, created_at)
         VALUES (?, ?, ?, 'pending', ?, ?) RETURNING id`,
        queued.event.message?.id ?? null,
        source,
        JSON.stringify(result.cards.map((card) => ({ ...card, source }))),
        question ? "ask" : null,
        Date.now(),
      )
      .one();

    const summary = result.summary.join("\n");
    await this.send(queued, [
      question
        ? withButtons(`${summary}\n\n${question}`, [
            { label: "はい", text: "はい" },
            { label: "ちがう", text: "ちがう" },
          ])
        : withButtons(summary, [
            { label: "OK", text: `OK #${batch.id}` },
            { label: "直す", text: `直す #${batch.id}` },
          ]),
    ]);
  }

  private async send(queued: QueuedEvent, messages: OutMessage[]) {
    const token = this.env.LINE_CHANNEL_ACCESS_TOKEN;
    const { replyToken } = queued.event;
    const inTime = Date.now() - queued.receivedAt < REPLY_WINDOW_MS;
    if (replyToken && inTime && (await reply(token, replyToken, messages))) return;
    await push(token, queued.familyId, messages);
  }
}
