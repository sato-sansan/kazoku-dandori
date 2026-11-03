import { DurableObject } from "cloudflare:workers";
import {
  computeAdventure,
  parseThanks,
  thanksPrompt,
  weeklyCard,
  xpLine,
  type AdventureStats,
} from "./adventure";
import { renderCalendar, renderIcs } from "./calendar";
import { firstQuestion, type Card, type CardSource } from "./card";
import { absenceMessages, draftAbsence, looksLikeAbsence } from "./drafts";
import type { Env } from "./env";
import { fetchImage, push, reply, withButtons, type LineEvent, type OutMessage } from "./line";
import {
  alreadyDecidedMessage,
  askMessage,
  confirmMessages,
  dailySlots,
  declineMessage,
  describeSlot,
  parseAccept,
  parseDecline,
  parseRequest,
  reminderMessage,
  slotsFromCards,
  undecidedMessage,
} from "./pickup";
import { loadProfile } from "./profile";
import { readNotice, type ReadInput } from "./reader";
import { addDays, jstDate, jstTime, jstToMs, jstWeekday, nextSundayEvening, weekRange } from "./time";
import { ADULTS, type Adult, type FamilyEvent, type Slot } from "./types";

// 返信トークンは1分以内が目安。余裕をみて、これを過ぎたらプッシュで届ける
const REPLY_WINDOW_MS = 50_000;
const SEEN_KEEP_MS = 2 * 24 * 60 * 60 * 1000;
const ASK_EVENING = "19:00";
const ASK_MORNING = "07:00";
const REMIND_BEFORE_MS = 30 * 60 * 1000;

const GREETING = `だんどりさんです。このグループの発言と写真を読んで、予定にします。
写真は読むために Claude へ送り、だんどりさんの中には保存しません。外への連絡を勝手に送ることはありません。
まず、あなたがだれか教えてください。`;

const WHO_BUTTONS = ADULTS.map((name) => ({ label: name, text: `わたしは ${name}` }));

interface QueuedEvent {
  familyId: string;
  event: LineEvent;
  receivedAt: number;
}

interface Batch extends Record<string, SqlStorageValue> {
  id: number;
  cards: string;
}

interface SlotRow extends Record<string, SqlStorageValue> {
  id: number;
  date: string;
  time: string;
  kind: string;
  place: string;
  children: string;
  who: string | null;
  status: string;
  requested_by: string | null;
}

interface EventRow extends Record<string, SqlStorageValue> {
  id: number;
  at: number;
  kind: string;
  who: string;
  to_who: string | null;
  slot_id: number | null;
  note: string | null;
}

type JobType = "ask_evening" | "ask_morning" | "reminder" | "weekly_card";

/** 家族ごとに1つ。受け取りは急いで行い、Claude を呼ぶ重い処理と定時のお知らせはアラームの中で行う */
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
      CREATE TABLE IF NOT EXISTS members (user_id TEXT PRIMARY KEY, role TEXT NOT NULL, registered_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS slots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL, time TEXT NOT NULL, kind TEXT NOT NULL, place TEXT NOT NULL,
        children TEXT NOT NULL, who TEXT, status TEXT NOT NULL, requested_by TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL, kind TEXT NOT NULL, who TEXT NOT NULL, to_who TEXT, slot_id INTEGER, note TEXT
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        due_at INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL,
        UNIQUE (due_at, type, payload)
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  // ── 受け取り ───────────────────────────────────────────

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
    await this.ctx.storage.setAlarm(now);
  }

  async alarm() {
    const familyId = this.familyId();
    const rows = this.sql.exec("SELECT id, payload FROM inbox ORDER BY received_at").toArray();
    for (const row of rows) {
      const queued = JSON.parse(row.payload as string) as QueuedEvent;
      this.sql.exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('family_id', ?)", queued.familyId);
      // 先に消す。途中で止まったとき、同じ発言に2回返事するより1回落とすほうが安全
      this.sql.exec("DELETE FROM inbox WHERE id = ?", row.id);
      try {
        await this.handle(queued);
      } catch (error) {
        console.error("handle failed", queued.event.type, error instanceof Error ? error.message : "");
        const type = queued.event.message?.type;
        if (type === "image" || type === "text") {
          await this.send(queued, [
            { type: "text", text: "いま読めませんでした。少し待って、もう一度送ってください。" },
          ]).catch(() => console.error("failure notice failed"));
        }
      }
    }

    if (familyId ?? this.familyId()) {
      this.ensureJobs();
      await this.runDueJobs();
    }
    await this.scheduleNextAlarm();
  }

  private familyId() {
    const row = this.sql.exec("SELECT value FROM settings WHERE key = 'family_id'").toArray()[0];
    return row ? (row.value as string) : null;
  }

  private async scheduleNextAlarm() {
    const inbox = this.sql.exec("SELECT MIN(received_at) AS t FROM inbox").toArray()[0]?.t as number | null;
    const job = this.sql.exec("SELECT MIN(due_at) AS t FROM jobs").toArray()[0]?.t as number | null;
    const next = [inbox, job].filter((t): t is number => typeof t === "number");
    if (next.length > 0) await this.ctx.storage.setAlarm(Math.min(...next));
  }

  // ── 1通ずつの処理 ───────────────────────────────────────

  private async handle(queued: QueuedEvent) {
    const { event } = queued;
    const isPrivate = event.source.type === "user";

    if (event.type === "join") {
      await this.send(queued, [withButtons(GREETING, WHO_BUTTONS)]);
    } else if (event.type === "unsend" && event.unsend) {
      this.sql.exec(
        "UPDATE batches SET cards = '[]', status = 'removed', awaiting = NULL WHERE message_id = ?",
        event.unsend.messageId,
      );
    } else if (event.type === "message" && event.message?.type === "image") {
      if (isPrivate) return;
      const image = await fetchImage(this.env.LINE_CHANNEL_ACCESS_TOKEN, event.message.id);
      if (image) await this.read(queued, { image }, "写真");
    } else if (event.type === "message" && event.message?.type === "text") {
      const text = (event.message.text ?? "").trim();
      if (isPrivate) await this.handlePrivate(queued, text);
      else await this.handleGroupText(queued, text);
    }
  }

  /** 1対1：名簿にいる大人だけ。「明日17時のお迎え頼んでおいて」をグループで代わりに聞く */
  private async handlePrivate(queued: QueuedEvent, text: string) {
    const role = this.roleOf(queued.event.source.userId);
    if (!role) {
      await this.send(queued, [{ type: "text", text: "家族のグループで、まず「わたしは ○○」を送ってください。" }]);
      return;
    }
    const today = jstDate();
    const request = parseRequest(text, today);
    // 1対1でも「今すぐ」なら今日の今の時刻
    if (request && /今すぐ|今から|至急|すぐ/.test(text)) {
      request.date = today;
      request.time = jstTime();
    }
    if (!request) {
      await this.send(queued, [
        { type: "text", text: "分かりませんでした。例：「明日17時のお迎え頼んでおいて」" },
      ]);
      return;
    }
    const slot = this.findOrCreateSlot(request.date, request.time, request.kind, "1対1");
    if (slot.status === "決定") {
      await this.send(queued, [{ type: "text", text: `${describeSlot(slot, today)}は、もう${slot.who}に決まっています。` }]);
      return;
    }
    if (slot.status === "お願い中") {
      await this.send(queued, [{ type: "text", text: `${describeSlot(slot, today)}は、もうグループで聞いています。` }]);
      return;
    }
    this.sql.exec("UPDATE slots SET status = 'お願い中', requested_by = '1対1' WHERE id = ?", slot.id);
    // 頼んだ人の名前は出さず、頼んだ人のボタンも出さない
    await this.pushToGroup([askMessage({ ...slot, status: "お願い中" }, { exclude: role })]);
    await this.send(queued, [{ type: "text", text: "グループで聞きました。グループを見ていてください。" }]);
  }

  private async handleGroupText(queued: QueuedEvent, text: string) {
    const userId = queued.event.source.userId;
    const today = jstDate();

    // 「わたしは ばあば」→ 名簿に登録。1対1の道が開く
    const who = /^わたしは\s*(パパ|ママ|じいじ|ばあば)$/.exec(text);
    if (who && userId) {
      const role = who[1] as Adult;
      this.sql.exec(
        "INSERT OR REPLACE INTO members (user_id, role, registered_at) VALUES (?, ?, ?)",
        userId,
        role,
        Date.now(),
      );
      await this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("directory")).register(userId, queued.familyId);
      await this.send(queued, [
        { type: "text", text: `${role}、よろしくね。1対1でも「明日17時のお迎え頼んでおいて」と言えます。` },
      ]);
      return;
    }

    // 名前ボタン：先に押した人で確定
    const accept = parseAccept(text);
    if (accept) {
      await this.accept(queued, accept.slotId, accept.who, today);
      return;
    }

    // ［ありがとう］
    const thanks = parseThanks(text);
    if (thanks) {
      await this.thank(queued, thanks.eventId, userId);
      return;
    }

    // ［OK］［直す］
    const button = /^(OK|直す) #(\d+)$/.exec(text);
    if (button) {
      await this.confirmBatch(queued, button[1], button[2]);
      return;
    }

    // 「予定 見せて」「カレンダー」→ 合言葉つきの URL（ログインなし）
    if (/^(予定|カレンダー)[\s　]*(見せて|みせて|教えて|おしえて)?$/.test(text)) {
      const token = await this.calendarToken(queued.familyId);
      const base = `https://kazoku-dandori.dandori.workers.dev/cal/${token}`;
      await this.send(queued, [
        {
          type: "text",
          text: `わが家の予定（週・月）はこちら。家族以外に送らないでください。\n${base}\n\nGoogleカレンダーに入れるときは、この URL を「URL で追加」に貼ります。\n${base}.ics`,
        },
      ]);
      return;
    }

    // デモと確認用：「段取り 明日」で19:00の処理を今やる、「段取り 冒険」で日曜のカードを今出す
    if (/^段取り[\s：:]*明日$/.test(text)) {
      await this.askForDate(addDays(today, 1), false);
      return;
    }
    if (/^段取り[\s：:]*冒険$/.test(text)) {
      await this.sendWeeklyCard();
      return;
    }

    // 急なお迎え：「園から電話、今すぐお迎え」「今日15時にお迎えだれか行ける？」→ その場で名前ボタン
    if (isUrgentPickup(text)) {
      const role = this.roleOf(userId);
      const parsed = parseRequest(text, today);
      const now = jstTime();
      // 時刻が書いてなければ「今」。書いてあっても今より前なら「今」
      const time = parsed && parsed.date === today && parsed.time > now ? parsed.time : now;
      const slot = this.findOrCreateSlot(today, time, "迎え", "グループ");
      if (slot.status === "決定") {
        await this.send(queued, [{ type: "text", text: `${describeSlot(slot, today)}は、${slot.who}に決まっています。` }]);
        return;
      }
      this.sql.exec("UPDATE slots SET status = 'お願い中', requested_by = 'グループ' WHERE id = ?", slot.id);
      await this.send(queued, [
        { type: "text", text: "🚨 急ぎのお迎えです。行ける人はボタンを押してください。" },
        askMessage({ ...slot, status: "お願い中" }, { exclude: role ?? undefined }),
      ]);
      return;
    }

    // 断り：担当が決まっていた枠を未定に戻し、角を立てずに言い直す
    if (parseDecline(text)) {
      const role = this.roleOf(userId);
      if (!role) {
        await this.send(queued, [withButtons("どなたですか？", WHO_BUTTONS)]);
        return;
      }
      // 「明日のお迎え無理」なら明日の迎えだけ。日や種類が書いてなければ、本人の枠が1つのときだけ取り消す
      const mine = this.slotsOf([today, addDays(today, 1)]).filter((s) => s.status === "決定" && s.who === role);
      const hint = parseRequest(text, today);
      const matched = hint ? mine.filter((s) => s.kind === hint.kind && (/今日|きょう|明日|あした/.test(text) ? s.date === hint.date : true)) : mine;
      const slot = matched.length === 1 ? matched[0] : null;
      if (!slot) {
        if (matched.length > 1) {
          await this.send(queued, [
            withButtons(
              "どれを取り消しますか？",
              matched.slice(0, 4).map((s) => ({ label: describeSlot(s, today).slice(0, 20), text: `${describeSlot(s, today)} 無理` })),
            ),
          ]);
        } else {
          await this.send(queued, [{ type: "text", text: "分かりました。" }]);
        }
        return;
      }
      this.sql.exec("UPDATE slots SET who = NULL, status = 'お願い中' WHERE id = ?", slot.id);
      this.sql.exec("INSERT INTO events (at, kind, who, slot_id) VALUES (?, '取消', ?, ?)", Date.now(), role, slot.id);
      await this.send(queued, [declineMessage(role), askMessage({ ...slot, who: null, status: "お願い中" }, { exclude: role })]);
      return;
    }

    // 「そうた 熱37.8 休み」→ 相手ごとの連絡文
    if (looksLikeAbsence(text)) {
      const draft = await draftAbsence(this.env.ANTHROPIC_API_KEY, {
        text,
        profile: loadProfile(this.env.FAMILY_PROFILE),
        today,
      });
      console.log(JSON.stringify({ step: "absence", attends: draft.attends, ask: !!draft.ask }));
      await this.send(queued, absenceMessages(draft));
      return;
    }

    await this.read(queued, { text }, "ひとこと");
  }

  // ── 芯A：読んで、聞く ─────────────────────────────────

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
    // 何を読んだかは記録しない。形だけ残す（件数・自信・聞き返しの有無）
    console.log(
      JSON.stringify({
        step: "read",
        source,
        is_notice: result.is_notice,
        cards: result.cards.length,
        low: result.cards.filter((card) => card.confidence === "低").length,
        ask: result.cards.some((card) => card.ask),
        summary_lines: result.summary.length,
      }),
    );
    // 雑談には黙っている
    if (!result.is_notice || result.cards.length === 0) return;

    // 聞き返しへの答えなら前のカードと入れ替える。別の子の別の連絡なら、前のカードはそのまま残す
    if (awaiting) {
      const before = JSON.parse(awaiting.cards) as Card[];
      const related = result.cards.some((card) => before.some((b) => b.child === card.child));
      if (related) this.sql.exec("UPDATE batches SET status = 'replaced', awaiting = NULL WHERE id = ?", awaiting.id);
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

    // 要約が空だと LINE が受け付けない。カードから1行ずつ作って補う
    const summary =
      result.summary.join("\n").trim() ||
      result.cards.map((card) => `${card.child}：${card.title}${card.date ? `（${card.date}）` : ""}`).join("\n");
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

  private async confirmBatch(queued: QueuedEvent, action: string, id: string) {
    if (action === "OK") {
      const done = this.sql
        .exec<Batch>("UPDATE batches SET status = 'ok', awaiting = NULL WHERE id = ? AND status = 'pending' RETURNING id, cards", id)
        .toArray();
      if (done.length === 0) return;
      // 送迎が要る予定は、その日の枠として覚えておく（19:00 に聞く元になる）
      const cards = JSON.parse(done[0].cards) as Card[];
      const dates = new Set(cards.map((card) => card.date).filter((d): d is string => !!d));
      for (const date of dates) this.upsertSlots(slotsFromCards(cards, date));
      await this.send(queued, [{ type: "text", text: "予定に入れました。" }]);
    } else {
      const open = this.sql
        .exec("UPDATE batches SET awaiting = 'fix' WHERE id = ? AND status = 'pending' RETURNING id", id)
        .toArray();
      if (open.length > 0) {
        await this.send(queued, [{ type: "text", text: "どこを直しますか？ひとことで送ってください。" }]);
      }
    }
  }

  // ── 芯B：間に立って、頼む ───────────────────────────────

  private async accept(queued: QueuedEvent, slotId: number, who: Adult, today: string) {
    const slot = this.slotById(slotId);
    if (!slot) return;
    if (slot.status === "決定") {
      await this.send(queued, [alreadyDecidedMessage(slot)]);
      return;
    }
    this.sql.exec("UPDATE slots SET who = ?, status = '決定' WHERE id = ?", who, slotId);
    const decided = { ...slot, who, status: "決定" as const };
    // 当日の頼みを引き受けたら「急な引受」。ファインプレーの候補になる
    const kind = slot.date === today ? "急な引受" : "引受";
    const event = this.sql
      .exec<{ id: number }>(
        "INSERT INTO events (at, kind, who, slot_id, note) VALUES (?, ?, ?, ?, ?) RETURNING id",
        Date.now(),
        kind,
        who,
        slotId,
        describeSlot(decided, today),
      )
      .one();
    const familyEvent: FamilyEvent = { id: event.id, at: Date.now(), kind, who, slotId, note: describeSlot(decided, today) };
    const stats = this.stats();
    const messages: OutMessage[] = [
      ...confirmMessages(decided, who),
      { type: "text", text: xpLine(stats, kind === "急な引受" ? 20 : 10, who) },
      thanksPrompt(familyEvent),
    ];
    await this.send(queued, messages.slice(0, 5));
    // 出る30分前に念押し
    this.addJob(jstToMs(slot.date, slot.time) - REMIND_BEFORE_MS, "reminder", String(slotId));
  }

  private async thank(queued: QueuedEvent, eventId: number, userId?: string) {
    const target = this.sql.exec<EventRow>("SELECT * FROM events WHERE id = ?", eventId).toArray()[0];
    if (!target) return;
    const from = this.roleOf(userId);
    if (!from) {
      await this.send(queued, [withButtons("どなたですか？", WHO_BUTTONS)]);
      return;
    }
    if (from === target.who) {
      await this.send(queued, [{ type: "text", text: "自分へのありがとうは数えません 😊" }]);
      return;
    }
    const dup = this.sql
      .exec("SELECT id FROM events WHERE kind = 'ありがとう' AND who = ? AND to_who = ? AND slot_id IS ? LIMIT 1", from, target.who, target.slot_id)
      .toArray();
    if (dup.length > 0) {
      await this.send(queued, [{ type: "text", text: "もう届いています 🙏" }]);
      return;
    }
    this.sql.exec(
      "INSERT INTO events (at, kind, who, to_who, slot_id) VALUES (?, 'ありがとう', ?, ?, ?)",
      Date.now(),
      from,
      target.who,
      target.slot_id,
    );
    await this.send(queued, [{ type: "text", text: `${target.who}に、${from}からのありがとうが届きました 🙏` }]);
  }

  /** その日の未定の枠をグループに聞く（19:00 と、翌朝7:00 の2回まで） */
  private async askForDate(date: string, retry: boolean) {
    const profile = loadProfile(this.env.FAMILY_PROFILE);
    // 土日は保育所の送迎がない。お便り由来の枠（行事・習い事）だけ
    if (!isWeekend(date)) this.upsertSlots(dailySlots(profile, date));
    const cards = this.okCards();
    this.upsertSlots(slotsFromCards(cards, date));

    const open = this.slotsOf([date]).filter((s) => s.status === "未定" || (retry && s.status === "お願い中"));
    if (open.length === 0) return;
    // 先に印と予約を済ませてから送る。送信が1回失敗しても、朝の聞き直しと念押しは残る
    for (const slot of open) this.sql.exec("UPDATE slots SET status = 'お願い中', requested_by = COALESCE(requested_by, '自動') WHERE id = ?", slot.id);
    if (!retry) this.addJob(jstToMs(date, ASK_MORNING), "ask_morning", date);
    for (const slot of open) this.addJob(jstToMs(slot.date, slot.time) - REMIND_BEFORE_MS, "reminder", String(slot.id));
    // 1回の push は5通まで。6件以上なら分けて送る
    for (let i = 0; i < open.length; i += 5) {
      await this.pushToGroup(open.slice(i, i + 5).map((slot) => askMessage(slot, { retry })));
    }
  }

  // ── 締め：ありがとう → 家族の冒険 ────────────────────────

  private stats(): AdventureStats {
    const { start, end } = weekRange();
    const events = this.sql.exec<EventRow>("SELECT * FROM events ORDER BY at").toArray().map(toFamilyEvent);
    const first = events[0]?.at ?? Date.now();
    const weekIndex = Math.floor((start - weekRange(first).start) / (7 * 86_400_000)) + 1;
    return computeAdventure(events, start, end, weekIndex);
  }

  private async sendWeeklyCard() {
    const reward = this.sql.exec("SELECT value FROM settings WHERE key = 'reward'").toArray()[0]?.value as string | undefined;
    await this.pushToGroup([weeklyCard(this.stats(), reward)]);
  }

  // ── 定時の仕事（Cron は使わず、DO のアラームで） ───────────

  private ensureJobs() {
    const today = jstDate();
    const evening = jstToMs(today, ASK_EVENING);
    const target = evening > Date.now() ? addDays(today, 1) : addDays(today, 2);
    const at = evening > Date.now() ? evening : jstToMs(addDays(today, 1), ASK_EVENING);
    // 翌日が土日でも、お便り由来の枠があるかもしれないので予約はする（askForDate 側で毎日の枠だけ省く）
    this.addJob(at, "ask_evening", target);
    this.addJob(nextSundayEvening(), "weekly_card", "");
  }

  private addJob(dueAt: number, type: JobType, payload: string) {
    if (dueAt <= Date.now()) return;
    this.sql.exec("INSERT OR IGNORE INTO jobs (due_at, type, payload) VALUES (?, ?, ?)", dueAt, type, payload);
  }

  private async runDueJobs() {
    const due = this.sql
      .exec<{ id: number; type: string; payload: string }>("SELECT id, type, payload FROM jobs WHERE due_at <= ? ORDER BY due_at", Date.now())
      .toArray();
    for (const job of due) {
      this.sql.exec("DELETE FROM jobs WHERE id = ?", job.id);
      // payload の末尾 "|n" は失敗した回数。3回までは5分後にやり直す
      const [payload, tries = "0"] = job.payload.split("|");
      try {
        await this.runJob(job.type as JobType, payload);
      } catch (error) {
        console.error("job failed", job.type, error instanceof Error ? error.message : "");
        if (Number(tries) < 3) this.addJob(Date.now() + 5 * 60 * 1000, job.type as JobType, `${payload}|${Number(tries) + 1}`);
      }
    }
  }

  private async runJob(type: JobType, payload: string) {
    if (type === "ask_evening") await this.askForDate(payload, false);
    else if (type === "ask_morning") await this.askForDate(payload, true);
    else if (type === "reminder") {
      const slot = this.slotById(Number(payload));
      if (!slot) return;
      await this.pushToGroup([slot.status === "決定" ? reminderMessage(slot) : undecidedMessage(slot)]);
    } else if (type === "weekly_card") await this.sendWeeklyCard();
  }

  // ── カレンダー（週・月のページと、購読用の ICS） ─────────────

  /** 合言葉は家族ごとに1つ。なければ作って Directory に登録する */
  private async calendarToken(familyId: string) {
    const row = this.sql.exec("SELECT value FROM settings WHERE key = 'cal_token'").toArray()[0];
    if (row) return row.value as string;
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    this.sql.exec("INSERT INTO settings (key, value) VALUES ('cal_token', ?)", token);
    await this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("directory")).registerToken(token, familyId);
    return token;
  }

  async calendarPage(baseUrl: string, view: "week" | "month", anchor?: string) {
    const today = jstDate();
    return renderCalendar({
      today,
      view,
      anchor: anchor && /^\d{4}-\d{2}-\d{2}$/.test(anchor) ? anchor : today,
      cards: this.okCards(),
      slots: this.allSlots(),
      photos: [],
      baseUrl,
    });
  }

  async calendarIcs() {
    return renderIcs({ cards: this.okCards(), slots: this.allSlots() });
  }

  private allSlots(): Slot[] {
    return this.sql.exec<SlotRow>("SELECT * FROM slots ORDER BY date, time").toArray().map(toSlot);
  }

  // ── 小さな道具 ───────────────────────────────────────────

  private roleOf(userId?: string): Adult | null {
    if (!userId) return null;
    const row = this.sql.exec("SELECT role FROM members WHERE user_id = ?", userId).toArray()[0];
    return row ? (row.role as Adult) : null;
  }

  private okCards(): Card[] {
    return this.sql
      .exec<Batch>("SELECT id, cards FROM batches WHERE status = 'ok'")
      .toArray()
      .flatMap((row) => JSON.parse(row.cards) as Card[]);
  }

  /** 同じ日・同じ種類・同じ場所の枠は1つにまとめる。決まっている枠は上書きしない */
  private upsertSlots(slots: Omit<Slot, "id">[]) {
    for (const slot of slots) {
      const same = this.slotsOf([slot.date]).find((s) => s.kind === slot.kind && s.place === slot.place);
      if (!same) {
        this.sql.exec(
          `INSERT INTO slots (date, time, kind, place, children, who, status, requested_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          slot.date,
          slot.time,
          slot.kind,
          slot.place,
          JSON.stringify(slot.children),
          slot.who,
          slot.status,
          slot.requestedBy ?? null,
        );
        continue;
      }
      if (same.status === "決定") continue;
      // お便りに担当が書いてあればそれで決まる。子どもの名前は多いほうを残す
      const children = slot.children.length > same.children.length ? slot.children : same.children;
      this.sql.exec(
        "UPDATE slots SET time = ?, children = ?, who = COALESCE(?, who), status = ? WHERE id = ?",
        slot.time,
        JSON.stringify(children),
        slot.who,
        slot.who ? "決定" : same.status,
        same.id,
      );
    }
  }

  private findOrCreateSlot(date: string, time: string, kind: Slot["kind"], requestedBy: Slot["requestedBy"]): Slot {
    // 「17時」と毎日の 17:30 を別枠にしない。同じ日・同じ種類なら同じ枠
    const existing = this.slotsOf([date]).find((s) => s.kind === kind && s.place === "保育所");
    if (existing) {
      if (existing.status !== "決定" && existing.time !== time) {
        this.sql.exec("UPDATE slots SET time = ? WHERE id = ?", time, existing.id);
        return { ...existing, time };
      }
      return existing;
    }
    const profile = loadProfile(this.env.FAMILY_PROFILE);
    const children = profile.children.filter((c) => c.attends === "保育所").map((c) => c.name);
    this.upsertSlots([{ date, time, kind, place: "保育所", children, who: null, status: "未定", requestedBy }]);
    return this.slotsOf([date]).find((s) => s.kind === kind && s.time === time)!;
  }

  private slotsOf(dates: string[]): Slot[] {
    return this.sql
      .exec<SlotRow>(`SELECT * FROM slots WHERE date IN (${dates.map(() => "?").join(",")}) ORDER BY date, time`, ...dates)
      .toArray()
      .map(toSlot);
  }

  private slotById(id: number): Slot | null {
    const row = this.sql.exec<SlotRow>("SELECT * FROM slots WHERE id = ?", id).toArray()[0];
    return row ? toSlot(row) : null;
  }

  private async pushToGroup(messages: OutMessage[]) {
    const familyId = this.familyId();
    if (!familyId) return;
    await push(this.env.LINE_CHANNEL_ACCESS_TOKEN, familyId, messages.slice(0, 5));
  }

  private async send(queued: QueuedEvent, messages: OutMessage[]) {
    const token = this.env.LINE_CHANNEL_ACCESS_TOKEN;
    const { replyToken } = queued.event;
    const inTime = Date.now() - queued.receivedAt < REPLY_WINDOW_MS;
    if (replyToken && inTime && (await reply(token, replyToken, messages))) return;
    const to = queued.event.source.type === "user" ? queued.event.source.userId! : queued.familyId;
    await push(token, to, messages);
  }
}

function isWeekend(date: string) {
  const day = jstWeekday(date);
  return day === 0 || day === 6;
}

/** グループでの急なお迎えの頼み。「お迎え」＋急ぎ・呼びかけの言葉。引受のボタン文は除く */
function isUrgentPickup(text: string) {
  if (/引受 #\d+/.test(text)) return false;
  return /迎え|むかえ/.test(text) && /今すぐ|今から|至急|すぐ|電話|呼び出し|だれか|誰か|行ける|頼め|頼ん|お願い/.test(text);
}

function toSlot(row: SlotRow): Slot {
  return {
    id: row.id,
    date: row.date,
    time: row.time,
    kind: row.kind as Slot["kind"],
    place: row.place,
    children: JSON.parse(row.children) as string[],
    who: (row.who as Adult | null) ?? null,
    status: row.status as Slot["status"],
    requestedBy: (row.requested_by as Slot["requestedBy"]) ?? undefined,
  };
}

function toFamilyEvent(row: EventRow): FamilyEvent {
  return {
    id: row.id,
    at: row.at,
    kind: row.kind as FamilyEvent["kind"],
    who: row.who as Adult,
    to: (row.to_who as Adult | null) ?? undefined,
    slotId: row.slot_id ?? undefined,
    note: row.note ?? undefined,
  };
}
