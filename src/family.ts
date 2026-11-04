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
import { absenceMessages, draftAbsence, groupAbsence, looksLikeAbsence } from "./drafts";
import { classifyIntent, type IntentResult } from "./intent";
import type { Env } from "./env";
import {
  createRichMenu,
  deleteRichMenu,
  fetchImage,
  chatMemberCount,
  linkRichMenu,
  memberName,
  mentionText,
  push,
  pushRemaining,
  reply,
  uploadRichMenuImage,
  useLineBase,
  withButtons,
  type LineEvent,
  type OutMessage,
  type QuickButton,
  type RichMenuArea,
} from "./line";
import richMenuPng from "../docs/assets/richmenu.png";
import {
  alreadyDecidedMessage,
  askMessage,
  confirmMessages,
  dailySlots,
  dayLabel,
  declineMessage,
  itemsMessage,
  describeSlot,
  parseAccept,
  parseAssignment,
  parseDay,
  parseDecline,
  parseRequest,
  reminderMessage,
  ROLE_WORDS,
  slotsFromCards,
  undecidedMessage,
  type Assignment,
} from "./pickup";
import { loadProfile, type FamilyProfile } from "./profile";
import { readNotice, type ReadInput } from "./reader";
import { addDays, jstDate, jstTime, jstToMs, jstWeekday, nextSundayEvening, weekRange } from "./time";
import { ADULTS, type Adult, type FamilyEvent, type Slot } from "./types";

// 返信トークンは1分以内が目安。余裕をみて、これを過ぎたらプッシュで届ける
const SEEN_KEEP_MS = 2 * 24 * 60 * 60 * 1000;
const ASK_EVENING = "19:00";
const ASK_MORNING = "07:00";
const REMIND_BEFORE_MS = 30 * 60 * 1000;
/** 定時のお知らせは、今月の送信数がこれだけ残るところで止める（家族が頼んだときのぶん。4人なら3回） */
const PUSH_RESERVE = 12;

const GREETING = `だんどりさんです。家族の段取りを手伝います。
お便りの写真や「熱で休み」の一言を読んで、予定と連絡文にします。外へは勝手に送りません。
まず、あなたはだれですか？（下のボタン）`;

/** あとから入った人への投げかけ（先頭に @名前 が付く） */
const JOINED_TEXT = `だんどりさんです。家族の段取りを手伝います。
まず、あなたはだれですか？（下のボタンを押してください）`;

const WHO_BUTTONS = ADULTS.map((name) => ({ label: name, text: `わたしは ${name}` }));

/** 何をしたらいいか迷わないための入口。カメラはその場で開く */
const MENU_BUTTONS: QuickButton[] = [
  { type: "camera", label: "📷 お便りを撮る" },
  { type: "cameraRoll", label: "🖼 写真を選ぶ" },
  { label: "🚗 お迎えを頼む", text: "お迎えを頼む" },
  { label: "🤒 休みの連絡", text: "休みの連絡" },
  { label: "📅 予定を見る", text: "予定 見せて" },
  { label: "❓ 使い方", text: "使い方" },
];
const MENU_TEXT = "何をしますか？";
/** 呼ばれたのに分からなかったとき。黙らずに入口を出す */
const NOT_UNDERSTOOD = "ごめんなさい、分かりませんでした。下のボタンからどうぞ。";
const HOW_TO = `だんどりさんへの頼み方
📷 お便りの写真を送る → 予定にします（写真は残るので紙は捨ててOK）
🤒「熱で休み」→ 園・学校への連絡文を［コピー］
🚗「明日のお迎え だれか」→ 家族の名前ボタン
🙋「5日の朝の送り 難しい」→ 家族に聞き直します
👉「ばあばに頼んで」→ その人に名指しで聞きます
🌱 写真＋「思い出に入れておいて」→ 成長記録に
📅「予定 見せて」→ わが家のだんどり帳（月・週・今日と明日）
🙏 引き受けた人に［ありがとう］
1対1のトークでは、下の「メニュー」から同じことができます`;

interface QueuedEvent {
  familyId: string;
  event: LineEvent;
  receivedAt: number;
  /** この発言への返事（flush で1回の返信にまとめて送る。保存はしない） */
  outbox?: OutMessage[];
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
  note: string | null;
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
    useLineBase(env.LINE_API_BASE);
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
      CREATE TABLE IF NOT EXISTS photos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL, message_id TEXT, date TEXT NOT NULL, label TEXT NOT NULL,
        media_type TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recent_images (message_id TEXT PRIMARY KEY, received_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS flows (user_id TEXT PRIMARY KEY, step TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS counts (day TEXT NOT NULL, key TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, key));
      CREATE TABLE IF NOT EXISTS later (kind TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    `);
    // 11/4 追加：家族が行かない枠のわけ（ファミサポ・お休み）。前からある箱には列を足す
    const cols = this.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('slots')").toArray().map((c) => c.name);
    if (!cols.includes("note")) this.sql.exec("ALTER TABLE slots ADD COLUMN note TEXT");
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
          queued.outbox = [{ type: "text", text: "いま読めませんでした。少し待って、もう一度送ってください。" }];
        }
      }
      // 返事は1回の返信にまとめて送る（2回目の返信がプッシュに化けて送信数を使わないように）
      await this.flush(queued).catch((error) => console.error("flush failed", error instanceof Error ? error.message.slice(0, 120) : ""));
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
      // だんどりさんが入ったとき：最初の投げかけ
      await this.send(queued, [withButtons(GREETING, WHO_BUTTONS)]);
    } else if (event.type === "memberJoined") {
      // あとから家族が入ったとき：その人を @ で名指しして名乗ってもらう。名指しが通らなければ普通の文で
      const ids = (event.joined?.members ?? []).map((m) => m.userId).filter((id): id is string => !!id);
      try {
        await this.send(queued, [ids.length > 0 ? mentionText(ids, JOINED_TEXT, WHO_BUTTONS) : withButtons(GREETING, WHO_BUTTONS)]);
      } catch {
        await this.pushToGroup([withButtons(GREETING, WHO_BUTTONS)]);
      }
    } else if (event.type === "unsend" && event.unsend) {
      this.sql.exec(
        "UPDATE batches SET cards = '[]', status = 'removed', awaiting = NULL WHERE message_id = ?",
        event.unsend.messageId,
      );
      // 送信取消なら、残していた写真も消す
      await this.deletePhotosOf(event.unsend.messageId);
    } else if (event.type === "message" && event.message?.type === "image") {
      // 1対1の写真は、名簿にいる大人からだけ読む
      if (isPrivate && !this.roleOf(event.source.userId)) return;
      const image = await fetchImage(this.env.LINE_CHANNEL_ACCESS_TOKEN, event.message.id);
      if (!image) return;
      // 「この写真 残して」が続くかもしれないので、しばらく覚えておく（中身は持たない）
      this.sql.exec("DELETE FROM recent_images WHERE received_at < ?", Date.now() - 10 * 60 * 1000);
      this.sql.exec("INSERT OR REPLACE INTO recent_images (message_id, received_at) VALUES (?, ?)", event.message.id, Date.now());
      const saved = await this.read(queued, { image }, "写真");
      // お便りなら写真を残す。紙を捨てられるように
      if (saved) await this.savePhoto(queued.familyId, event.message.id, image, saved.date, saved.label, "お便り");
      if (saved) this.count("読んだお便り");
    } else if (event.type === "message" && event.message?.type === "text") {
      const text = (event.message.text ?? "").trim();
      // 提出用の数字：グループで大人が打った文の数（中身は持たない）。ボタンが送る文は別に数える
      if (!isPrivate) this.count(isButtonText(text) ? "ボタン" : "手で打った文");
      // 1対1は名簿にいる大人だけ。中身の扱いはグループと同じで、家族に聞くことだけグループへ流す
      if (isPrivate && !this.roleOf(event.source.userId)) {
        await this.send(queued, [{ type: "text", text: "家族のグループで、まず「わたしは ○○」を送ってください。" }]);
        return;
      }
      await this.handleText(queued, text);
    }
  }

  /** 1対1の自由な文：「明日17時のお迎え頼んでおいて」をグループで代わりに聞く。頼みとして読めなければ false */
  private async privateRequest(queued: QueuedEvent, text: string, role: Adult | null): Promise<boolean> {
    const today = jstDate();
    const request = parseRequest(text, today);
    if (!request) return false;
    // 1対1でも「今すぐ」なら今日の今の時刻
    if (/今すぐ|今から|至急|すぐ/.test(text)) {
      request.date = today;
      request.time = jstTime();
    }
    const slot = this.findOrCreateSlot(request.date, request.time, request.kind, "1対1");
    if (slot.status === "決定") {
      await this.send(queued, [{ type: "text", text: `${describeSlot(slot, today)}は、もう${slot.who}に決まっています。` }]);
      return true;
    }
    if (slot.status === "お願い中") {
      await this.send(queued, [{ type: "text", text: `${describeSlot(slot, today)}は、もうグループで聞いています。` }]);
      return true;
    }
    this.sql.exec("UPDATE slots SET status = 'お願い中', requested_by = '1対1' WHERE id = ?", slot.id);
    // 頼んだ人の名前は出さず、頼んだ人のボタンも出さない
    await this.askGroup(queued, [askMessage({ ...slot, status: "お願い中" }, { exclude: role ?? undefined })]);
    return true;
  }

  /**
   * 「5日の朝の送り 難しい」で、その枠がまだ無い・決まっていないとき。枠を立てて家族に聞く。
   * @名指しがあればその人に「お願いできますか？」。名指しの人の役が分かればその人のボタンだけ
   */
  private async askInsteadOf(
    queued: QueuedEvent,
    request: { date: string; time: string; kind: Slot["kind"] },
    from: Adult,
    toUserIds: string[],
    today: string,
  ) {
    const slot = this.findOrCreateSlot(request.date, request.time, request.kind, "グループ");
    if (slot.status === "決定" && slot.who && slot.who !== from) {
      await this.send(queued, [{ type: "text", text: `${describeSlot(slot, today)}は、${slot.who}に決まっています。` }]);
      return;
    }
    if (slot.status === "決定") {
      this.sql.exec("UPDATE slots SET who = NULL, status = 'お願い中' WHERE id = ?", slot.id);
      this.sql.exec("INSERT INTO events (at, kind, who, slot_id) VALUES (?, '取消', ?, ?)", Date.now(), from, slot.id);
    } else {
      this.sql.exec("UPDATE slots SET status = 'お願い中', requested_by = 'グループ' WHERE id = ?", slot.id);
    }
    const open = { ...slot, who: null, status: "お願い中" as const };
    // ボタンは頼んだ人以外の全員。名指しの人が無理でも、ほかの人が押せる
    const ask = askMessage(open, { exclude: from });
    if (toUserIds.length > 0) {
      await this.askGroup(queued, [mentionText(toUserIds, `${describeSlot(slot, today)}、お願いできますか？`), ask]);
    } else {
      await this.askGroup(queued, [declineMessage(from), ask]);
    }
  }

  /** 「ママに頼んで」「さくらに依頼して」「@ばあば にお願いして」：相手を決めて、名指しで聞く。相手が分からなければ名前ボタン */
  private async delegate(queued: QueuedEvent, plain: string, mentioned: string[], today: string) {
    const userId = queued.event.source.userId;
    const from = this.roleOf(userId);
    // 相手：①本文の「ママ」などの呼び名 ②@名指しの人 ③LINE の表示名（「さくらに」）
    let role: Adult | null = roleInText(plain);
    let ids = mentioned;
    if (!role) role = mentioned.map((id) => this.roleOf(id)).find((r): r is Adult => !!r) ?? null;
    const name = /^(?:.*?[、。\s　])?([^、。\s　]+?)(?:さん|ちゃん|くん)?[\s　]*(?:に|へ)[\s　]*(?:頼|たの|依頼|お願い|聞|きい|任|まか)/.exec(plain)?.[1];
    if (!role && ids.length === 0 && name) {
      const hit = await this.memberByName(queued.familyId, name, userId);
      if (hit) {
        role = hit.role;
        ids = [hit.userId];
      }
    }
    if (role && role === from) role = null;
    if (ids.length === 0 && role) ids = this.userIdsOf(role).filter((id) => id !== userId);
    if (!role && ids.length === 0) {
      await this.send(queued, [
        withButtons(
          `${name ? `「${name}」さんは、パパ・ママ・じいじ・ばあばのどなたですか？` : "どなたに頼みますか？"}`,
          ADULTS.filter((a) => a !== from).map((a) => ({ label: a, text: `${a}に頼んで` })),
        ),
      ]);
      return;
    }
    // 何を頼むか：文に送り迎えがあればその枠、無ければ一番近い決まっていない枠
    const request = parseRequest(plain, today, { loose: true });
    // 「今すぐお迎え ばあばにお願い」は今日の今の時刻（1対1の頼みと同じ扱い）
    if (request && /今すぐ|今から|至急|すぐ/.test(plain)) {
      request.date = today;
      request.time = jstTime();
    }
    const slot = request ? this.findOrCreateSlot(request.date, request.time, request.kind, "グループ") : this.nearestOpenSlot(today);
    if (!slot) {
      await this.send(queued, [
        { type: "text", text: "何を頼むのか分かりませんでした。「5日の朝の送り ママに頼んで」のように教えてください。" },
      ]);
      return;
    }
    // ほかの人に決まっている枠は、本人に聞かずに外さない。手放せるのは自分の担当だけ
    if (slot.status === "決定" && slot.who && slot.who !== from) {
      await this.send(queued, [{ type: "text", text: `${describeSlot(slot, today)}は、もう${slot.who}に決まっています。` }]);
      return;
    }
    if (slot.status === "決定" && slot.who) {
      // 自分の担当を手放して、頼む相手に渡す
      this.sql.exec("UPDATE slots SET who = NULL, status = 'お願い中' WHERE id = ?", slot.id);
      this.sql.exec("INSERT INTO events (at, kind, who, slot_id) VALUES (?, '取消', ?, ?)", Date.now(), slot.who, slot.id);
    } else {
      this.sql.exec("UPDATE slots SET status = 'お願い中', requested_by = 'グループ' WHERE id = ?", slot.id);
    }
    const open = { ...slot, who: null, status: "お願い中" as const };
    const line = `${describeSlot(slot, today)}、お願いできますか？`;
    const head: OutMessage = ids.length > 0 ? mentionText(ids, line) : { type: "text", text: `${role}、${line}` };
    await this.askGroup(queued, [head, askMessage(open, { exclude: from ?? undefined })]);
  }

  private userIdsOf(role: Adult): string[] {
    return this.sql
      .exec<{ user_id: string }>("SELECT user_id FROM members WHERE role = ?", role)
      .toArray()
      .map((m) => m.user_id);
  }

  /** 「さくら」→ 名簿のだれか。LINE の表示名で探す（名前は家族の箱にだけ覚える。ログに出さない） */
  private async memberByName(familyId: string, name: string, self?: string): Promise<{ userId: string; role: Adult } | null> {
    const want = name.replace(/[\s　]/g, "");
    if (!want) return null;
    const members = this.sql.exec<{ user_id: string; role: string }>("SELECT user_id, role FROM members").toArray();
    for (const m of members) {
      if (m.user_id === self) continue;
      const key = `name.${m.user_id}`;
      let display: string | null = this.sql.exec<{ value: string }>("SELECT value FROM settings WHERE key = ?", key).toArray()[0]?.value ?? null;
      if (!display) {
        display = await memberName(this.env.LINE_CHANNEL_ACCESS_TOKEN, familyId, m.user_id).catch(() => null);
        if (display) this.sql.exec("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", key, display);
      }
      const d = (display ?? "").replace(/[\s　]/g, "");
      if (d && (d.includes(want) || want.includes(d))) return { userId: m.user_id, role: m.role as Adult };
    }
    return null;
  }

  /** 一番近い決まっていない枠。いま家族に聞いている枠を先に。過ぎた枠は除く */
  private nearestOpenSlot(today: string): Slot | null {
    const row = this.sql
      .exec<SlotRow>(
        `SELECT * FROM slots WHERE status != '決定' AND (date > ? OR (date = ? AND time >= ?))
         ORDER BY (status = 'お願い中') DESC, date, time LIMIT 1`,
        today,
        today,
        jstTime(),
      )
      .toArray()[0];
    return row ? toSlot(row) : null;
  }

  /** 家族に聞く文。グループで言われたならそのまま返事、1対1ならグループへ流して本人には「聞きました」 */
  private async askGroup(queued: QueuedEvent, messages: OutMessage[]) {
    if (queued.event.source.type !== "user") {
      await this.send(queued, messages);
      return;
    }
    if (!(await this.pushToGroup(messages))) {
      await this.send(queued, [
        { type: "text", text: "今月の LINE の送信数が足りず、グループに送れませんでした。グループで「お迎えを頼む」を押してください。" },
      ]);
      return;
    }
    await this.send(queued, [{ type: "text", text: "グループで聞きました。グループを見ていてください。" }]);
  }

  /**
   * routed：聞き分け（Claude）から、決まった言い方に直して戻ってきた一言。もう一度聞き分けには回さない（回り続けないため）
   */
  private async handleText(queued: QueuedEvent, rawText: string, routed = false) {
    const userId = queued.event.source.userId;
    const isPrivate = queued.event.source.type === "user";
    const today = jstDate();
    // 「@だんどりさん 予定見せて」も「予定見せて」と同じに読む（だんどりさんへの呼びかけだけ外す）
    const text = routed ? rawText : withoutSelfMention(queued.event, rawText);

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
      await this.send(queued, [withButtons(`${role}、よろしくね。${MENU_TEXT}`, MENU_BUTTONS)]);
      // 1対1のトークにホーム画面（リッチメニュー）を出す。できなくても名乗りは成立
      try {
        await this.giveRichMenu(queued.familyId, [userId]);
      } catch (error) {
        console.error("richmenu failed", error instanceof Error ? error.message : "");
      }
      return;
    }

    // 入口のメニューと使い方
    if (/^(メニュー|めにゅー|使い方|つかいかた|ヘルプ|help)$/i.test(text)) {
      await this.send(queued, [withButtons(/使い方|つかいかた|ヘルプ|help/i.test(text) ? HOW_TO : MENU_TEXT, MENU_BUTTONS)]);
      return;
    }
    // リッチメニューの「お便りを送る」→ カメラを開くボタン
    if (/^お便りを送る$/.test(text)) {
      await this.send(queued, [
        withButtons("お便りの写真を送ってください。撮ったら、紙は捨ててOKです。", [
          { type: "camera", label: "📷 撮る" },
          { type: "cameraRoll", label: "🖼 写真を選ぶ" },
        ]),
      ]);
      return;
    }
    // 撮影用のグループ：本物の呼び名を出さず、見本の4人で動かす
    if (/^(架空の家族で|本物の家族で)$/.test(text)) {
      const sample = text === "架空の家族で";
      if (sample) this.sql.exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('profile', 'sample')");
      else this.sql.exec("DELETE FROM settings WHERE key = 'profile'");
      const names = this.profile().children.map((c) => c.name).join("・");
      await this.send(queued, [{ type: "text", text: `このグループは${sample ? "見本の家族" : "本物の家族"}（${names}）で動きます。` }]);
      return;
    }
    // 連絡文の札の［📞 電話］を、番号が未登録のときに押した
    const teach = text.match(/^(保育所|小学校)の電話を教える$/);
    if (teach) {
      await this.send(queued, [
        { type: "text", text: `${teach[1]}の電話番号を、このように送ってください：\n${teach[1]}の電話 0226-00-0000 9:00まで\n（「9:00まで」は、何時までに連絡するか。無くてもOK）` },
      ]);
      return;
    }
    // 園・学校の電話番号：「保育所の電話 0120-444-444 9:00まで」。休みの連絡に［電話をかける］が付く
    const phone = text.match(
      /^(保育所|保育園|幼稚園|こども園|園|小学校|学校)の電話(?:番号)?[\s　]*[:：]?[\s　]*([0-9０-９\-－()（）\s　]+?)(?:[\s　]*([0-9０-９]{1,2}[:：][0-9０-９]{2})[\s　]*まで)?$/,
    );
    if (phone) {
      const place = /小学校|学校/.test(phone[1]) ? "小学校" : "保育所";
      const digits = phone[2].replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[^0-9\-]/g, "");
      if (digits.replace(/-/g, "").length < 10) {
        await this.send(queued, [{ type: "text", text: "番号が短いようです。「保育所の電話 0226-00-0000 9:00まで」のように送ってください。" }]);
        return;
      }
      const by = phone[3]?.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace("：", ":");
      this.sql.exec("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", `contact.${place}`, JSON.stringify({ phone: digits, by }));
      await this.send(queued, [
        { type: "text", text: `${place}の電話を覚えました：${digits}${by ? `（${by}までに）` : ""}。休みの連絡に［電話をかける］が付きます。` },
      ]);
      return;
    }
    // ホーム画面を作り直す（画像や入口を変えたとき）
    if (/^リッチメニュー[\s　]*(作り直し|作り直して|つくりなおし)$/.test(text)) {
      const members = this.sql.exec<{ user_id: string }>("SELECT user_id FROM members").toArray().map((m) => m.user_id);
      try {
        await this.giveRichMenu(queued.familyId, members, true);
        await this.send(queued, [{ type: "text", text: `ホーム画面を作り直しました（${members.length}人）。1対1のトークを開くと下に出ます。` }]);
      } catch (error) {
        console.error("richmenu failed", error instanceof Error ? error.message : "");
        await this.send(queued, [{ type: "text", text: "ホーム画面を作れませんでした。あとでもう一度。" }]);
      }
      return;
    }

    // ボタンで進む会話（お迎えを頼む／休みの連絡）。途中の答えはここで受ける
    if (userId && (await this.continueFlow(queued, userId, text))) return;

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

    // 聞き返しに「ちがう」だけ：何が正しいかは読み直しても分からない。正しい形をひとことで聞く
    // （11/4：「ちがう」がどの問いへの答えか分からず、問いが続いた）
    const pendingAsk = this.sql
      .exec<{ id: number }>("SELECT id FROM batches WHERE awaiting = 'ask' AND status = 'pending' ORDER BY id DESC LIMIT 1")
      .toArray()[0];
    if (pendingAsk && /^(ちがう|違う|ちがいます|違います|いいえ)[。！!]?$/.test(text)) {
      // 'fix2'＝聞き返しのあとの直し。次の答えでは、もう聞き返さない
      this.sql.exec("UPDATE batches SET awaiting = 'fix2' WHERE id = ?", pendingAsk.id);
      await this.send(queued, [{ type: "text", text: "正しくは？ひとことで送ってください。（例：16日です／18:30です）" }]);
      return;
    }

    // 写真：「この写真 残して」／「学芸会のお便り見せて」
    // 「この写真 残して」「思い出に入れておいて」「この写真 ○○と△△の成長記録にしておいて」。成長記録は子どもの名前つきで家のページに並ぶ
    if (wantsToKeepPhoto(text)) {
      await this.keepRecentPhoto(queued, text);
      return;
    }
    const show = /^(.+?)の(お便り|おたより|写真|プリント)[\s　]*(見せて|みせて|出して|だして)$/.exec(text);
    if (show) {
      await this.showPhoto(queued, show[1].trim());
      return;
    }

    // 「予定 見せて」「カレンダー」→ 合言葉つきの URL（ログインなし）
    if (/^(予定|カレンダー|だんどり帳)[\s　]*(見せて|みせて|教えて|おしえて|を見る|開いて)?$/.test(text)) {
      const token = await this.calendarToken(queued.familyId);
      const base = `https://kazoku-dandori.dandori.workers.dev/c/${token}`;
      // URL は見せず、ボタンで開く。Google カレンダー用の購読 URL はコピーで渡す
      await this.send(queued, [
        {
          type: "flex",
          altText: "わが家のだんどり帳（今日と明日・月・週）",
          contents: {
            type: "bubble",
            size: "kilo",
            body: {
              type: "box",
              layout: "vertical",
              spacing: "sm",
              paddingAll: "12px",
              contents: [
                { type: "text", text: "わが家のだんどり帳", weight: "bold", size: "md" },
                { type: "text", text: "家族だけのページです。ほかの人に送らないでください。", size: "xs", color: "#666666", wrap: true },
                { type: "button", style: "primary", height: "sm", action: { type: "uri", label: "📒 だんどり帳を開く", uri: base } },
                {
                  type: "button",
                  style: "secondary",
                  height: "sm",
                  action: { type: "clipboard", label: "Googleカレンダー用URLをコピー", clipboardText: `${base}.ics` },
                },
              ],
            },
          },
        },
      ]);
      return;
    }

    // デモと確認用：「段取り 明日」で19:00の処理を今やる、「段取り 冒険」で日曜のカードを今出す
    if (/^段取り[\s：:]*明日$/.test(text)) {
      await this.askForDate(addDays(today, 1), false, queued);
      return;
    }
    // 確認と撮影用：「段取り 念押し」で、次の送り迎えの念押しを今（返信で）出す
    if (/^段取り[\s：:]*念押し$/.test(text)) {
      const now = jstTime();
      const next = this.slotsOf([today, addDays(today, 1)]).find((s) => s.status !== "取消" && (s.date > today || s.time >= now));
      await this.send(queued, [
        next ? (next.status === "決定" ? reminderMessage(next) : undecidedMessage(next)) : { type: "text", text: "これからの送り迎えはありません。" },
      ]);
      return;
    }
    if (/^段取り[\s：:]*数字$/.test(text)) {
      // LINE の今月の残り（管理画面の数字は遅れることがあるので、ここで直接確かめられるように）
      const left = await pushRemaining(this.env.LINE_CHANNEL_ACCESS_TOKEN).catch(() => null);
      const quota = left === null ? "読めませんでした" : left === Infinity ? "上限なし" : `${left}通`;
      await this.send(queued, [{ type: "text", text: `${this.numbersText()}\nLINE の今月の残り：${quota}` }]);
      return;
    }
    if (/^段取り[\s：:]*冒険$/.test(text)) {
      await this.sendWeeklyCard(queued);
      return;
    }

    // 決まった報告：「明日5時迎えばーばになりました」「28日土曜お迎え パパ」「5日はファミサポにお迎え頼みました」「16日は全員お休み」
    // 確認の問いにせず、その日の枠にすぐ入れて1行で返す（11/4：報告が読み取りに回り、確認の問いが10往復した）
    const assigned = parseAssignment(text, today, this.recentAssignDate());
    if (assigned) {
      await this.applyAssignment(queued, assigned, today, text);
      return;
    }

    // 「白紙にして」「取り消して」：確かめ中の内容（まだ［OK］していない読み取り）を入れずに消す
    if (/白紙|取り消して|取消して|なしにして|無しにして|全部消して|入れないで/.test(text)) {
      const pending = this.sql
        .exec<{ id: number }>("SELECT id FROM batches WHERE status = 'pending' AND created_at > ?", Date.now() - 3 * 60 * 60 * 1000)
        .toArray();
      if (pending.length > 0) {
        for (const b of pending) this.sql.exec("UPDATE batches SET status = 'removed', awaiting = NULL WHERE id = ?", b.id);
        await this.send(queued, [{ type: "text", text: "確かめ中だった内容は、入れずに消しました。" }]);
        return;
      }
    }

    // 「ママに頼んで」「@ばあば にお願いして」「5日の朝の送り じいじに依頼して」→ その人に名指しで聞く
    // 雑談の「先生にお願いして」は拾わない：だんどりさんを呼んだ・@名指しがある・家族の呼び名・送り迎えの話のどれかのときだけ
    // 聞き分けから戻った一言は、直した文（text）で読む。元の言い方で読み直すと、また通らない
    const plain = routed ? text : stripMentions(queued.event).trim();
    const mentioned = mentionedUserIds(queued.event).filter((id) => id !== userId);
    const asksSomeone =
      /(に|へ)[\s　]*(頼ん|たのん|頼み|たのみ|依頼|お願い|聞いて|きいて|任せ|まかせ)/.test(plain) ||
      (mentioned.length > 0 && /頼ん|たのん|依頼|お願い/.test(plain));
    if (
      asksSomeone &&
      (isPrivate || botMentioned(queued.event) || mentioned.length > 0 || roleInText(plain) !== null || parseRequest(plain, today))
    ) {
      await this.delegate(queued, plain, mentioned, today);
      return;
    }

    // 急なお迎え：「園から電話、今すぐお迎え」「今日15時にお迎えだれか行ける？」→ その場で名前ボタン
    // 「金曜の夕方だれか迎え行ける？」のように別の日なら、急ぎではなくその日の頼み
    const otherDay = parseDay(text, today);
    if (isUrgentPickup(text) && otherDay && otherDay !== today && !/今すぐ|今から|至急/.test(text)) {
      if (await this.privateRequest(queued, text, this.roleOf(userId))) return;
    }
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
      await this.askGroup(queued, [
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
      const hint = parseRequest(text, today, { loose: true });
      const day = parseDay(text, today);
      const mine = this.slotsOf(day ? [day] : [today, addDays(today, 1)]).filter((s) => s.status === "決定" && s.who === role);
      const matched = hint ? mine.filter((s) => s.kind === hint.kind && (day ? s.date === hint.date : true)) : mine;
      const slot = matched.length === 1 ? matched[0] : null;
      if (!slot) {
        if (matched.length > 1) {
          await this.send(queued, [
            withButtons(
              "どれを取り消しますか？",
              matched.slice(0, 4).map((s) => ({ label: describeSlot(s, today).slice(0, 20), text: `${describeSlot(s, today)} 無理` })),
            ),
          ]);
        } else if (hint) {
          // 「5日の朝の送り 難しい」：まだ決まっていない日でも、枠を立てて家族に聞く。@名指しがあればその人へ
          await this.askInsteadOf(queued, hint, role, mentionedUserIds(queued.event).filter((id) => id !== userId), today);
        } else {
          await this.send(queued, [
            { type: "text", text: "どの送り迎えのことか分かりませんでした。「5日の朝の送り 難しい」のように教えてください。" },
          ]);
        }
        return;
      }
      this.sql.exec("UPDATE slots SET who = NULL, status = 'お願い中' WHERE id = ?", slot.id);
      this.sql.exec("INSERT INTO events (at, kind, who, slot_id) VALUES (?, '取消', ?, ?)", Date.now(), role, slot.id);
      await this.askGroup(queued, [declineMessage(role), askMessage({ ...slot, who: null, status: "お願い中" }, { exclude: role })]);
      return;
    }

    // 「そうた 熱37.8 休み」→ 相手ごとの連絡文
    if (looksLikeAbsence(text)) {
      await this.absence(queued, text, today);
      return;
    }

    // 1対1の自由な文は、まず「頼んでおいて」として読む
    const role = this.roleOf(userId);
    if (isPrivate && role && (await this.privateRequest(queued, text, role))) return;

    // 呼ばれた（@だんどりさん・1対1）のに決まった言い方に当てはまらない → Claude で聞き分けて、今ある仕組みに回す
    const called = isPrivate || botMentioned(queued.event);
    if (routed) {
      // 直した一言でも通らなかった。お便りとして読ませない（作った文を予定にしない）
      await this.send(queued, [withButtons(NOT_UNDERSTOOD, MENU_BUTTONS)]);
      return;
    }
    if (called && (await this.routeCalled(queued, text, today))) return;

    const saved = await this.read(queued, { text }, "ひとこと");
    // グループの雑談には黙る。呼ばれたのに分からなかったときだけ、入口を出す（黙らない）
    if (!saved && called) await this.send(queued, [withButtons(NOT_UNDERSTOOD, MENU_BUTTONS)]);
  }

  /** 30分以内に報告があった日。「ファミサポは18:30迎えです」のような続きを、その日のこととして読む */
  private recentAssignDate(): string | null {
    const row = this.sql.exec("SELECT value FROM settings WHERE key = 'assign.recent'").toArray()[0];
    if (!row) return null;
    const { date, at } = JSON.parse(row.value as string) as { date: string; at: number };
    return Date.now() - at < 30 * 60 * 1000 ? date : null;
  }

  /** その日・その種類の枠（無ければ毎日の枠の形で作る）。保育所の枠を先に */
  private slotFor(date: string, kind: Slot["kind"], time: string | null): Slot {
    const same = this.slotsOf([date]).filter((s) => s.kind === kind && s.status !== "取消");
    const found = same.find((s) => s.place === "保育所") ?? same[0];
    if (found) return found;
    const fallback = kind === "迎え" ? "17:30" : "07:30";
    return this.findOrCreateSlot(date, time ?? fallback, kind, "グループ");
  }

  /**
   * 決まった報告を枠に入れて、短く返す。家族のだれかなら「決定」（引き受けとして数え、［ありがとう］と念押し）、
   * ファミサポ・お休みなら「不要」（19:00 の「行ける人？」も念押しも出さない）
   */
  private async applyAssignment(queued: QueuedEvent, list: Assignment[], today: string, text: string) {
    const lines: string[] = [];
    const extra: OutMessage[] = [];
    for (const a of list) {
      const slot = this.slotFor(a.date, a.kind, a.time);
      const time = a.time ?? slot.time;
      if (a.who) {
        const same = slot.status === "決定" && slot.who === a.who && slot.time === time;
        this.sql.exec("UPDATE slots SET time = ?, who = ?, status = '決定', note = NULL WHERE id = ?", time, a.who, slot.id);
        const decided: Slot = { ...slot, time, who: a.who, status: "決定", note: undefined };
        const said = describeSlot(decided, today);
        lines.push(`✅ ${said}は ${a.who}。`);
        if (same) continue;
        const kind = slot.date === today ? "急な引受" : "引受";
        const ev = this.sql
          .exec<{ id: number }>("INSERT INTO events (at, kind, who, slot_id, note) VALUES (?, ?, ?, ?, ?) RETURNING id", Date.now(), kind, a.who, slot.id, said)
          .one();
        extra.push(thanksPrompt({ id: ev.id, at: Date.now(), kind, who: a.who, slotId: slot.id, note: said }));
        // 担当が変わったら念押しはやり直し（1回だけ）
        this.sql.exec("DELETE FROM settings WHERE key = ?", `reminded.${slot.id}`);
        this.addReminder(decided);
      } else {
        this.sql.exec("UPDATE slots SET time = ?, who = NULL, status = '不要', note = ? WHERE id = ?", time, a.note, slot.id);
        this.sql.exec("DELETE FROM jobs WHERE type = 'reminder' AND (payload = ? OR payload LIKE ?)", String(slot.id), `${slot.id}|%`);
        if (a.note !== "お休み") lines.push(`✅ ${describeSlot({ ...slot, time }, today, a.time !== null)}は ${a.note}。家族に「行ける人？」は聞きません。`);
      }
    }
    // 全員お休み：1行にまとめ、だんどり帳にも「お休み」を出す。連絡文は頼まれたら（「都合」「連絡」と書いてあれば）すぐ作る
    const off = list.filter((a) => a.note === "お休み");
    const buttons: QuickButton[] = [];
    if (off.length > 0) {
      const date = off[0].date;
      lines.unshift(`✅ ${dayLabel(date, today)}は${off.length >= 2 ? "全員お休み" : `${off[0].kind === "迎え" ? "お迎え" : "送り"}なし`}。送り迎えの「行ける人？」は聞きません。`);
      if (off.length >= 2) {
        const card: Card = {
          child: "全員", kind: "欠席", title: "お休み", date, time: null, place: null, deadline: null,
          items: [], money: null, who_acts: "未定", confidence: "高", ask: null,
        };
        this.sql.exec(
          "INSERT INTO batches (message_id, source, cards, status, awaiting, created_at) VALUES (?, 'ひとこと', ?, 'ok', NULL, ?)",
          queued.event.message?.id ?? null,
          JSON.stringify([{ ...card, source: "ひとこと" }]),
          Date.now(),
        );
        const drafts = groupAbsence(text, this.profile(), today, date);
        if (drafts && /都合|連絡|理由|欠席/.test(text)) {
          this.count("連絡文の下書き");
          extra.unshift(...drafts.flatMap((d) => absenceMessages(d, this.profile().contacts)));
        } else if (drafts) {
          buttons.push({ label: "🤒 連絡文を作る", text: `休みの連絡 ${dayLabel(date, today).replace(/（.）/, "")} 全員` });
        }
      }
    }
    this.sql.exec(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('assign.recent', ?)",
      JSON.stringify({ date: list[0].date, at: Date.now() }),
    );
    console.log(JSON.stringify({ step: "assign", n: list.length, who: list.some((a) => a.who), note: list.some((a) => a.note) }));
    this.count("決まった報告");
    const head = `${lines.join("\n")}\nだんどり帳に入れました。`;
    const first: OutMessage = buttons.length > 0 ? withButtons(head, buttons) : { type: "text", text: head };
    await this.send(queued, [first, ...extra].slice(0, 5));
  }

  /** 「熱で休み」→ 相手ごとの連絡文の下書き（［コピー］［📞 電話］）。「全員」「3人とも」は通い先ごとにまとめて作る */
  private async absence(queued: QueuedEvent, text: string, today: string) {
    const profile = this.profile();
    const group = groupAbsence(text, profile, today, parseDay(text, today) ?? today);
    if (group) {
      console.log(JSON.stringify({ step: "absence", group: group.length }));
      this.count("連絡文の下書き");
      await this.send(queued, group.flatMap((d) => absenceMessages(d, profile.contacts)).slice(0, 5));
      return;
    }
    const draft = await draftAbsence(this.env.ANTHROPIC_API_KEY, { text, profile, today });
    console.log(JSON.stringify({ step: "absence", attends: draft.attends, ask: !!draft.ask }));
    this.count("連絡文の下書き");
    // 聞き返したら、次のひとことは最初の文に足して読み直す（「全員です」だけを別の話として読まない）
    const userId = queued.event.source.userId;
    if (draft.ask && userId) {
      this.sql.exec(
        "INSERT OR REPLACE INTO flows (user_id, step, data, updated_at) VALUES (?, 'absence.ask', ?, ?)",
        userId,
        JSON.stringify({ text }),
        Date.now(),
      );
    }
    await this.send(queued, absenceMessages(draft, profile.contacts));
  }

  /**
   * 呼ばれた一言を Claude（安いモデル）で聞き分け、決まった言い方に直して今ある仕組みに回す。
   * 返事の文はモデルに書かせない。true なら返事済み、false ならお便りとして読む（read）に任せる
   */
  private async routeCalled(queued: QueuedEvent, text: string, today: string): Promise<boolean> {
    const userId = queued.event.source.userId;
    const role = this.roleOf(userId);
    // 名簿にいない人には応じない（子どもと話さない）。まず名乗ってもらう
    if (!role) {
      await this.send(queued, [withButtons("どなたですか？", WHO_BUTTONS)]);
      return true;
    }
    // お礼・あいさつは Claude を呼ばずに短く返す（「ありがとね」に「分かりませんでした」と言わない）
    if (/^(ありがと|ありがとう|助かる|助かった|おはよう|こんにちは|こんばんは|おやすみ|よろしく|お疲れ|おつかれ|いつも)/.test(text.replace(/[\s　]/g, ""))) {
      await this.send(queued, [withButtons("はい、ここにいます。用事があれば下のボタンからどうぞ。", MENU_BUTTONS)]);
      return true;
    }
    let r: IntentResult | null = null;
    try {
      r = await classifyIntent(this.env.ANTHROPIC_API_KEY, { text, today, profile: this.profile() });
    } catch (error) {
      console.error("intent failed", error instanceof Error ? error.message.slice(0, 200) : "");
    }
    // 中身は記録しない。形だけ
    console.log(JSON.stringify({ step: "intent", intent: r?.intent ?? null, date: !!r?.date, kind: r?.kind ?? null, person: !!r?.person }));
    this.count("聞き分け");
    if (!r) return false;

    const md = r.date ? `${Number(r.date.slice(5, 7))}/${Number(r.date.slice(8, 10))}の` : "";
    const kindWord = r.kind === "迎え" ? "お迎え" : r.kind === "送り" ? "送り" : "";
    const when = `${md}${r.time ? `${r.time} ` : ""}${kindWord}`;
    const now = /今すぐ|今から|至急/.test(text) ? " 今すぐ" : "";
    // 相手の名前が書いてある「送迎を頼む」は、その人への名指しとして扱う（「おばあちゃんが行けるか聞いといて」）
    const intent = r.intent === "送迎を頼む" && r.person ? "人に頼む" : r.intent;
    switch (intent) {
      case "送迎を頼む":
        if (!r.kind) return this.askWhich(queued);
        await this.privateRequest(queued, `${when}${now}`, role);
        return true;
      case "送迎を断る":
        await this.handleText(queued, `${when || md} 難しい`.trim(), true);
        return true;
      case "人に頼む":
        if (!r.person && mentionedUserIds(queued.event).filter((id) => id !== userId).length === 0) {
          await this.send(queued, [
            withButtons(
              "どなたに頼みますか？",
              ADULTS.filter((a) => a !== role).map((a) => ({ label: a, text: `${when} ${a}に頼んで`.trim() })),
            ),
          ]);
          return true;
        }
        await this.handleText(queued, `${when} ${r.person ?? ""}に頼んで`.trim(), true);
        return true;
      case "休みの連絡":
        await this.absence(queued, text, today);
        return true;
      case "写真を残す":
        await this.keepRecentPhoto(queued, text);
        return true;
      case "予定を見る":
        await this.handleText(queued, "予定 見せて", true);
        return true;
      case "使い方":
        await this.send(queued, [withButtons(HOW_TO, MENU_BUTTONS)]);
        return true;
      case "雑談":
        await this.send(queued, [withButtons("はい、ここにいます。用事があれば下のボタンからどうぞ。", MENU_BUTTONS)]);
        return true;
      case "お便り・予定の連絡":
        return false;
      default:
        await this.send(queued, [withButtons(NOT_UNDERSTOOD, MENU_BUTTONS)]);
        return true;
    }
  }

  /** 送り迎えのどちらか分からないとき */
  private async askWhich(queued: QueuedEvent) {
    await this.send(queued, [withButtons("送りとお迎え、どちらですか？「明日の朝の送り だれか」のように教えてください。", MENU_BUTTONS)]);
    return true;
  }

  // ── 芯A：読んで、聞く ─────────────────────────────────

  /** お便りと判断して返事をしたら、写真を残すための日付と題名を返す。雑談なら null */
  private async read(
    queued: QueuedEvent,
    input: Pick<ReadInput, "text" | "image">,
    source: CardSource,
  ): Promise<{ date: string; label: string } | null> {
    // 文は聞き返しや直しへの答えかもしれない。新しい写真は別の連絡として読む。
    // 3時間たった聞き返しは引きずらない（11/4：前日の写真の問いに、翌朝の報告が答えとして読まれた）
    this.sql.exec("UPDATE batches SET awaiting = NULL WHERE awaiting IS NOT NULL AND created_at < ?", Date.now() - 3 * 60 * 60 * 1000);
    const awaiting = input.text
      ? this.sql
          .exec<Batch & { awaiting: string }>(
            "SELECT id, cards, awaiting FROM batches WHERE awaiting IS NOT NULL AND status = 'pending' ORDER BY id DESC LIMIT 1",
          )
          .toArray()[0]
      : undefined;

    const result = await readNotice(this.env.ANTHROPIC_API_KEY, {
      ...input,
      profile: this.profile(),
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
    if (!result.is_notice || result.cards.length === 0) return null;

    // 聞き返しへの答えなら前のカードと入れ替える。別の子の別の連絡なら、前のカードはそのまま残す
    const before = awaiting ? (JSON.parse(awaiting.cards) as Card[]) : [];
    // 前の問いへの答えか：同じ子・同じ題名がある、または短い一言（「11/16です」で子が「未定」→「はると」に変わっても答え）
    const related = awaiting
      ? (input.text ?? "").length <= 30 || result.cards.some((card) => before.some((b) => b.child === card.child || b.title === card.title))
      : false;
    if (awaiting && related) this.sql.exec("UPDATE batches SET status = 'replaced', awaiting = NULL WHERE id = ?", awaiting.id);
    // 自由な文での聞き返しは1回まで（docs/brand.md）。答えのあとは聞かずに［OK］［直す］。分からない所は「日にち未定」のまま
    const answering = awaiting && related && (awaiting.awaiting === "ask" || awaiting.awaiting === "fix2");
    const asked = answering ? null : firstQuestion(result.cards);
    // 問いは1つ。カードに残すのも、聞いた1つだけ（次の「ちがう」がどの問いへの答えか迷わないように）
    let kept = false;
    const cards = result.cards.map((card) => {
      const keep = !!asked && !kept && card.ask === asked;
      if (keep) kept = true;
      return { ...card, ask: keep ? card.ask : null, source };
    });
    const question = asked;
    const batch = this.sql
      .exec<{ id: number }>(
        `INSERT INTO batches (message_id, source, cards, status, awaiting, created_at)
         VALUES (?, ?, ?, 'pending', ?, ?) RETURNING id`,
        queued.event.message?.id ?? null,
        source,
        JSON.stringify(cards),
        question ? "ask" : null,
        Date.now(),
      )
      .one();

    // 返事は、今回ふえた・変わった予定だけを短く（11/4：答えるたびに全員ぶんの予定が4行ずつ繰り返された）。
    // モデルの要約は使わない（「承知しました」のような、できない約束を書いたため）
    const changed = related ? cards.filter((c) => !before.some((b) => sameCard(b, c))) : cards;
    const summary = changed.length > 0 ? summarizeCards(changed, this.profile()) : "このまま入れます。";
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
    const first = result.cards[0];
    return { date: first.date ?? jstDate(), label: first.title };
  }

  // ── 写真（お便りは自動で、家族の写真は「残して」と言ったものだけ） ──

  private async savePhoto(
    familyId: string,
    messageId: string,
    image: { mediaType: string; data: string },
    date: string,
    label: string,
    kind: "お便り" | "家族" | "成長",
  ) {
    const ext = image.mediaType.split("/")[1] ?? "jpg";
    const key = `${familyId}/${date}/${messageId}.${ext}`;
    const bytes = Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0));
    try {
      await this.env.PHOTOS.put(key, bytes, { httpMetadata: { contentType: image.mediaType } });
    } catch (error) {
      console.error("photo save failed", error instanceof Error ? error.message : "");
      await this.pushToGroup([{ type: "text", text: "写真を残せませんでした。紙はまだ捨てないでください。" }]);
      return;
    }
    this.sql.exec(
      "INSERT INTO photos (key, message_id, date, label, media_type, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      key,
      messageId,
      date,
      label,
      image.mediaType,
      kind,
      Date.now(),
    );
  }

  private async deletePhotosOf(messageId: string) {
    const rows = this.sql.exec("SELECT id, key FROM photos WHERE message_id = ?", messageId).toArray();
    for (const row of rows) {
      await this.env.PHOTOS.delete(row.key as string).catch(() => console.error("photo delete failed"));
      this.sql.exec("DELETE FROM photos WHERE id = ?", row.id);
    }
  }

  /** 「この写真 残して」「思い出に入れておいて」：直前の写真を家族の写真として残す */
  private async keepRecentPhoto(queued: QueuedEvent, text: string) {
    // 文に出てくる子どもの呼び名で「だれの成長記録か」を決める。名前が無ければ家族の写真（思い出）
    const names = this.profile().children.map((c) => c.name).filter((n) => text.includes(n));
    const growth = names.length > 0 || /成長記録/.test(text);
    const label = names.length > 0 ? names.join("・") : growth ? "成長記録" : /思い出|アルバム/.test(text) ? "思い出" : "家族の写真";
    const recent = this.sql
      .exec("SELECT message_id FROM recent_images ORDER BY received_at DESC LIMIT 1")
      .toArray()[0];
    if (!recent) {
      await this.send(queued, [
        { type: "text", text: `残す写真が見つかりません。写真を送ってから「思い出に入れておいて」か「この写真 ${names[0] ?? "○○"}の成長記録に」と言ってください。` },
      ]);
      return;
    }
    const messageId = recent.message_id as string;
    if (this.sql.exec("SELECT id FROM photos WHERE message_id = ?", messageId).toArray().length > 0) {
      await this.send(queued, [{ type: "text", text: "その写真はもう残してあります。" }]);
      return;
    }
    const image = await fetchImage(this.env.LINE_CHANNEL_ACCESS_TOKEN, messageId);
    if (!image) {
      await this.send(queued, [{ type: "text", text: "写真を取り出せませんでした。もう一度送ってから言ってください。" }]);
      return;
    }
    await this.savePhoto(queued.familyId, messageId, image, jstDate(), label, growth ? "成長" : "家族");
    await this.send(queued, [
      {
        type: "text",
        text: growth
          ? `成長記録に残しました（${label}）。だんどり帳の「成長記録」に並びます。`
          : "思い出に残しました。だんどり帳の「成長記録」に並びます。",
      },
    ]);
  }

  /** 「学芸会のお便り見せて」：題名で探して LINE に再送 */
  private async showPhoto(queued: QueuedEvent, word: string) {
    const rows = this.sql
      .exec<{ id: number; label: string; date: string }>(
        "SELECT id, label, date FROM photos WHERE label LIKE ? ORDER BY created_at DESC LIMIT 3",
        `%${word}%`,
      )
      .toArray();
    if (rows.length === 0) {
      await this.send(queued, [{ type: "text", text: `「${word}」のお便りは見つかりませんでした。` }]);
      return;
    }
    const token = await this.calendarToken(queued.familyId);
    const messages: OutMessage[] = rows.map((row) => ({
      type: "image" as const,
      originalContentUrl: `https://kazoku-dandori.dandori.workers.dev/c/${token}/photo/${row.id}`,
      previewImageUrl: `https://kazoku-dandori.dandori.workers.dev/c/${token}/photo/${row.id}`,
    }));
    await this.send(queued, messages);
  }

  /** カレンダーのページから写真を出す。合言葉の確認は Worker 側 */
  async photo(id: number): Promise<{ body: ReadableStream; contentType: string } | null> {
    const row = this.sql.exec("SELECT key, media_type FROM photos WHERE id = ?", id).toArray()[0];
    if (!row) return null;
    const object = await this.env.PHOTOS.get(row.key as string);
    if (!object) return null;
    return { body: object.body, contentType: row.media_type as string };
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
    // 出る30分前に念押し（1回だけ）
    this.addReminder(slot);
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

  /**
   * その日の未定の枠をグループに聞く（19:00 と、翌朝7:00 の2回まで）。19:00 は明日の持ち物・集金も同じ1回に入れる。
   * queued があれば（「段取り 明日」と言われた）返信で出す。返信は LINE の送信数を使わない
   */
  private async askForDate(date: string, retry: boolean, queued?: QueuedEvent) {
    const profile = this.profile();
    // 土日は保育所の送迎がない。お便り由来の枠（行事・習い事）だけ
    if (!isWeekend(date)) this.upsertSlots(dailySlots(profile, date));
    const cards = this.okCards();
    this.upsertSlots(slotsFromCards(cards, date));

    const open = this.slotsOf([date]).filter((s) => s.status === "未定" || (retry && s.status === "お願い中"));
    const items = retry ? null : itemsMessage(cards, date);
    if (open.length === 0 && !items) {
      if (queued) await this.send(queued, [{ type: "text", text: "明日の送り迎えは、全部決まっています。" }]);
      return;
    }
    // 印と予約を先に済ませる。送れなくても、朝の聞き直しと念押しは残る
    for (const slot of open) this.sql.exec("UPDATE slots SET status = 'お願い中', requested_by = COALESCE(requested_by, '自動') WHERE id = ?", slot.id);
    if (!retry && open.length > 0) this.addJob(jstToMs(date, ASK_MORNING), "ask_morning", date);
    // 朝 7:00 の聞き直しと同じころに「まだ決まっていません」を重ねない（7:30 の送りは 7:00 の聞き直しが念押しを兼ねる）
    const morning = jstToMs(date, ASK_MORNING);
    for (const slot of open) {
      if (jstToMs(slot.date, slot.time) - REMIND_BEFORE_MS > morning + 45 * 60 * 1000) this.addReminder(slot);
    }
    // 1回で送るのは5通まで（送迎4枠＋持ち物でちょうど）
    const messages: OutMessage[] = [...open.map((slot) => askMessage(slot, { retry })), ...(items ? [items] : [])].slice(0, 5);
    if (queued) {
      await this.send(queued, messages);
      return;
    }
    // 自動のお知らせは「今日のぶん」の中で1回だけ。送れなければ、その日の夕方まで次の返信に相乗り
    if (!(await this.pushToGroup(messages, true))) this.defer(messages, `ask:${date}`, jstToMs(date, "18:00"));
  }

  // ── 締め：ありがとう → 家族の冒険 ────────────────────────

  private stats(): AdventureStats {
    const { start, end } = weekRange();
    const events = this.sql.exec<EventRow>("SELECT * FROM events ORDER BY at").toArray().map(toFamilyEvent);
    const first = events[0]?.at ?? Date.now();
    const weekIndex = Math.floor((start - weekRange(first).start) / (7 * 86_400_000)) + 1;
    return computeAdventure(events, start, end, weekIndex);
  }

  /** 家のページの「わが家の冒険」：今週の数字と、今週だれが何回引き受けたか（順位は付けない） */
  private adventureForPage() {
    const { start, end } = weekRange();
    const events = this.sql.exec<EventRow>("SELECT * FROM events ORDER BY at").toArray().map(toFamilyEvent);
    const takes = new Map<string, number>();
    for (const e of events) {
      if (e.at >= start && e.at < end && (e.kind === "引受" || e.kind === "急な引受")) takes.set(e.who, (takes.get(e.who) ?? 0) + 1);
    }
    return { stats: this.stats(), takes: [...takes].map(([who, count]) => ({ who, count })) };
  }

  /** 提出用の数字を1日ぶん足す（文の中身は持たない） */
  private count(key: string, n = 1) {
    this.sql.exec(
      "INSERT INTO counts (day, key, n) VALUES (?, ?, ?) ON CONFLICT (day, key) DO UPDATE SET n = n + excluded.n",
      jstDate(),
      key,
      n,
    );
  }

  /** 「段取り 数字」：今週と先週の数。提出の「使ってみた前後」に、確かめられた数字だけを書くため */
  private numbersText(): string {
    const { start } = weekRange();
    const monday = jstDate(start);
    const week = (from: string) => {
      const to = addDays(from, 7);
      const sum = (key: string) =>
        Number(this.sql.exec<{ n: number }>("SELECT COALESCE(SUM(n), 0) AS n FROM counts WHERE key = ? AND day >= ? AND day < ?", key, from, to).toArray()[0]?.n ?? 0);
      const slots = this.sql
        .exec<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM slots WHERE date >= ? AND date < ? GROUP BY status", from, to)
        .toArray();
      const decided = slots.filter((r) => r.status === "決定").reduce((a, r) => a + Number(r.n), 0);
      const open = slots.filter((r) => r.status === "未定" || r.status === "お願い中").reduce((a, r) => a + Number(r.n), 0);
      const fromMs = jstToMs(from, "00:00");
      const ev = (kind: string) =>
        Number(this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE kind = ? AND at >= ? AND at < ?", kind, fromMs, fromMs + 7 * 86_400_000).toArray()[0]?.n ?? 0);
      return {
        typed: sum("手で打った文"),
        buttons: sum("ボタン"),
        decided,
        open,
        takes: ev("引受") + ev("急な引受"),
        thanks: ev("ありがとう"),
        drafts: sum("連絡文の下書き"),
        notices: sum("読んだお便り"),
        routed: sum("聞き分け"),
        reports: sum("決まった報告"),
        pushes: sum("プッシュ"),
      };
    };
    const now = week(monday);
    const prev = week(addDays(monday, -7));
    const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
    return [
      `📊 今週（${md(monday)}〜${md(addDays(monday, 6))}）の数字`,
      `手で打った文：${now.typed}通（ボタン ${now.buttons}回は別）`,
      `送迎：決まった ${now.decided}件・まだ ${now.open}件（引き受け ${now.takes}回・「○○になりました」の報告 ${now.reports}回）`,
      `ありがとう：${now.thanks}回`,
      `連絡文の下書き：${now.drafts}回`,
      `読んだお便り：${now.notices}件`,
      `だんどりさんへの呼びかけ（聞き分け）：${now.routed}回`,
      `だんどりさんから送った知らせ（LINE の送信数）：${now.pushes}通　返信は数えません`,
      `先週：手で打った文 ${prev.typed}通・決まった送迎 ${prev.decided}件・ありがとう ${prev.thanks}回`,
      "数えているのは数だけです。文の中身は残していません。",
    ].join("\n");
  }

  /** 日曜 20:00 の冒険カード。「段取り 冒険」と言われたら返信で出す（送信数を使わない） */
  private async sendWeeklyCard(queued?: QueuedEvent) {
    const reward = this.sql.exec("SELECT value FROM settings WHERE key = 'reward'").toArray()[0]?.value as string | undefined;
    const card = weeklyCard(this.stats(), reward);
    if (queued) {
      await this.send(queued, [card]);
      return;
    }
    // 日曜 20:00 のカードはプッシュしない。次にグループで話したときの返信に乗せる（3日まで待つ）
    this.defer([card], "weekly", Date.now() + 3 * 86_400_000);
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
      .exec<{ id: number; due_at: number; type: string; payload: string }>(
        "SELECT id, due_at, type, payload FROM jobs WHERE due_at <= ? ORDER BY due_at",
        Date.now(),
      )
      .toArray();
    for (const job of due) {
      this.sql.exec("DELETE FROM jobs WHERE id = ?", job.id);
      // payload の末尾 "|n" は失敗した回数。3回までは5分後にやり直す
      const [payload, tries = "0"] = job.payload.split("|");
      try {
        await this.runJob(job.type as JobType, payload, Number(tries) === 0 ? job.due_at : null);
      } catch (error) {
        console.error("job failed", job.type, error instanceof Error ? error.message : "");
        if (Number(tries) < 3) this.addJob(Date.now() + 5 * 60 * 1000, job.type as JobType, `${payload}|${Number(tries) + 1}`);
      }
    }
  }

  /** 念押しの予約。同じ枠の古い予約は消す（枠の時刻が変わると古い時刻の予約が残り、念押しが2回出た：11/4） */
  private addReminder(slot: Pick<Slot, "id" | "date" | "time">) {
    this.sql.exec("DELETE FROM jobs WHERE type = 'reminder' AND (payload = ? OR payload LIKE ?)", String(slot.id), `${slot.id}|%`);
    this.addJob(jstToMs(slot.date, slot.time) - REMIND_BEFORE_MS, "reminder", String(slot.id));
  }

  /** dueAt は予約した時刻（やり直しのときは null） */
  private async runJob(type: JobType, payload: string, dueAt: number | null = null) {
    if (type === "ask_evening") await this.askForDate(payload, false);
    else if (type === "ask_morning") await this.askForDate(payload, true);
    else if (type === "reminder") {
      const slot = this.slotById(Number(payload));
      if (!slot || slot.status === "取消" || slot.status === "不要") return;
      // 念押しは1枠1回（佐藤 11/4「事前通知は1回で良い」）。今の時刻とずれた古い予約は捨てる
      const key = `reminded.${slot.id}`;
      if (this.sql.exec("SELECT 1 FROM settings WHERE key = ?", key).toArray().length > 0) return;
      if (dueAt !== null && Math.abs(dueAt - (jstToMs(slot.date, slot.time) - REMIND_BEFORE_MS)) > 5 * 60 * 1000) return;
      this.sql.exec("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", key, String(Date.now()));
      if (slot.status === "決定" && slot.who) {
        // 念押しは担当の人だけに（グループ全員に送ると人数ぶん数える）。届かなくてもグループには送らない
        for (const id of this.userIdsOf(slot.who)) await this.pushTo(id, [reminderMessage(slot)], true);
        return;
      }
      // まだ決まっていない：グループに。今日のぶんが無ければ、その時刻まで次の返信に相乗り
      const msg = [undecidedMessage(slot)];
      if (!(await this.pushToGroup(msg, true))) this.defer(msg, `undecided:${slot.id}`, jstToMs(slot.date, slot.time));
    } else if (type === "weekly_card") await this.sendWeeklyCard();
  }

  // ── ボタンで進む会話（選ばせる。文を考えさせない） ──────────

  /** 進行中の会話があれば1歩進めて true。「お迎えを頼む」「休みの連絡」の入口もここ */
  private async continueFlow(queued: QueuedEvent, userId: string, text: string): Promise<boolean> {
    const today = jstDate();
    const profile = this.profile();
    const row = this.sql
      .exec<{ step: string; data: string; updated_at: number }>("SELECT step, data, updated_at FROM flows WHERE user_id = ?", userId)
      .toArray()[0];
    const data = row ? (JSON.parse(row.data) as Record<string, string>) : {};
    const set = (step: string, patch: Record<string, string>) =>
      this.sql.exec(
        "INSERT OR REPLACE INTO flows (user_id, step, data, updated_at) VALUES (?, ?, ?, ?)",
        userId,
        step,
        JSON.stringify({ ...data, ...patch }),
        Date.now(),
      );
    const done = () => this.sql.exec("DELETE FROM flows WHERE user_id = ?", userId);

    if (/^(やめる|キャンセル|取り消し)$/.test(text) && row) {
      done();
      await this.send(queued, [withButtons("やめました。", MENU_BUTTONS)]);
      return true;
    }

    // 入口
    if (/^お迎えを頼む$/.test(text)) {
      set("pickup.day", {});
      await this.send(queued, [
        withButtons("いつのお迎え？", [
          { label: "今日", text: "今日" },
          { label: "明日", text: "明日" },
          { label: "やめる", text: "やめる" },
        ]),
      ]);
      return true;
    }
    if (/^休みの連絡$/.test(text)) {
      set("absence.child", {});
      await this.send(queued, [
        withButtons("どの子が休みますか？", [
          ...profile.children.map((c) => ({ label: c.name, text: c.name })),
          { label: "全員", text: "全員" },
          { label: "やめる", text: "やめる" },
        ]),
      ]);
      return true;
    }
    if (!row) return false;

    // 途中の答え。10分たった会話は捨てる
    if (row.step === "pickup.day" && /^(今日|明日)$/.test(text)) {
      set("pickup.time", { day: text });
      await this.send(queued, [
        withButtons("何時？", [
          { label: "17:30", text: "17:30" },
          { label: "17:00", text: "17:00" },
          { label: "18:00", text: "18:00" },
          { label: "今すぐ", text: "今すぐ" },
          { label: "やめる", text: "やめる" },
        ]),
      ]);
      return true;
    }
    if (row.step === "pickup.time" && /^(\d{1,2}:\d{2}|今すぐ)$/.test(text)) {
      done();
      const date = data.day === "今日" ? today : addDays(today, 1);
      const time = text === "今すぐ" ? jstTime() : text.padStart(5, "0");
      const role = this.roleOf(userId);
      const slot = this.findOrCreateSlot(date, time, "迎え", "グループ");
      if (slot.status === "決定") {
        await this.send(queued, [{ type: "text", text: `${describeSlot(slot, today)}は、${slot.who}に決まっています。` }]);
        return true;
      }
      this.sql.exec("UPDATE slots SET status = 'お願い中', requested_by = 'グループ' WHERE id = ?", slot.id);
      await this.askGroup(queued, [askMessage({ ...slot, time, status: "お願い中" }, { exclude: role ?? undefined })]);
      return true;
    }
    // 休みの連絡で聞き返した答え（「全員です」「16日です」）：最初の文に足して読み直す。30分たったら別の話
    if (row.step === "absence.ask") {
      done();
      if (Date.now() - row.updated_at > 30 * 60 * 1000 || isButtonText(text) || parseAccept(text)) return false;
      await this.absence(queued, `${data.text}\n${text}`, today);
      return true;
    }
    if (row.step === "absence.child" && text === "全員") {
      set("absence.reason", { child: "全員" });
      await this.send(queued, [
        withButtons("理由は？", [
          { label: "体調不良", text: "体調不良" },
          { label: "家庭の都合", text: "家庭の都合" },
          { label: "やめる", text: "やめる" },
        ]),
      ]);
      return true;
    }
    if (row.step === "absence.child" && profile.children.some((c) => c.name === text)) {
      set("absence.reason", { child: text });
      await this.send(queued, [
        withButtons("理由は？", [
          { label: "熱", text: "熱" },
          { label: "体調不良", text: "体調不良" },
          { label: "家庭の都合", text: "家庭の都合" },
          { label: "通院", text: "通院" },
          { label: "やめる", text: "やめる" },
        ]),
      ]);
      return true;
    }
    if (row.step === "absence.reason" && data.child === "全員") {
      done();
      await this.absence(queued, `今日 全員 ${text} 休み`, today);
      return true;
    }
    if (row.step === "absence.reason") {
      done();
      const draft = await draftAbsence(this.env.ANTHROPIC_API_KEY, {
        text: `${data.child} ${text} 今日休み`,
        profile,
        today,
      });
      console.log(JSON.stringify({ step: "absence", attends: draft.attends, ask: !!draft.ask, via: "buttons" }));
      await this.send(queued, absenceMessages(draft, profile.contacts));
      return true;
    }
    // 会話の途中で別の話が来たら、会話は捨てて普通に処理する
    done();
    return false;
  }

  // ── カレンダー（週・月のページと、購読用の ICS） ─────────────

  /** 合言葉は家族ごとに1つ。なければ作って Directory に登録する */
  private async calendarToken(familyId: string) {
    const row = this.sql.exec("SELECT value FROM settings WHERE key = 'cal_token'").toArray()[0];
    if (row && (row.value as string).length === 10) return row.value as string;
    // 10文字（英小文字と数字）。当てずっぽうでは開けない長さで、口で伝えられる短さ
    const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
    const bytes = crypto.getRandomValues(new Uint8Array(10));
    const token = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
    this.sql.exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('cal_token', ?)", token);
    await this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("directory")).registerToken(token, familyId);
    return token;
  }

  /** 家族ごとのホーム画面（リッチメニュー）。なければ作って、名簿の人の1対1のトークに結びつける。rebuild なら作り直す */
  private async giveRichMenu(familyId: string, userIds: string[], rebuild = false) {
    const token = this.env.LINE_CHANNEL_ACCESS_TOKEN;
    const row = this.sql.exec("SELECT value FROM settings WHERE key = 'richmenu'").toArray()[0];
    let id = row ? (row.value as string) : null;
    if (rebuild && id) {
      await deleteRichMenu(token, id);
      this.sql.exec("DELETE FROM settings WHERE key = 'richmenu'");
      id = null;
    }
    if (!id) {
      const base = `https://kazoku-dandori.dandori.workers.dev/c/${await this.calendarToken(familyId)}`;
      const w = 625;
      const area = (i: number, action: RichMenuArea["action"]): RichMenuArea => ({ bounds: { x: i * w, y: 0, width: w, height: 843 }, action });
      id = await createRichMenu(token, `だんどりさん ${familyId.slice(0, 8)}`, [
        area(0, { type: "uri", label: "カレンダー", uri: base }),
        area(1, { type: "message", label: "お迎えを頼む", text: "お迎えを頼む" }),
        area(2, { type: "message", label: "休みの連絡", text: "休みの連絡" }),
        area(3, { type: "message", label: "お便りを送る", text: "お便りを送る" }),
      ]);
      await uploadRichMenuImage(token, id, richMenuPng);
      this.sql.exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('richmenu', ?)", id);
    }
    await linkRichMenu(token, id, userIds);
  }

  async calendarPage(baseUrl: string, view: "week" | "month", anchor?: string) {
    const today = jstDate();
    return renderCalendar({
      today,
      view,
      anchor: anchor && /^\d{4}-\d{2}-\d{2}$/.test(anchor) ? anchor : today,
      cards: this.okCards(),
      slots: this.allSlots(),
      photos: this.sql
        .exec<{ id: number; date: string; label: string; kind: string }>("SELECT id, date, label, kind FROM photos ORDER BY date")
        .toArray()
        .map((row) => ({ date: row.date, label: row.label, kind: row.kind, url: `${baseUrl}/photo/${row.id}` })),
      adventure: this.adventureForPage(),
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

  /** 家族の呼び名と学年。撮影用のグループで「架空の家族で」と言うと、見本の4人（はると・ゆい・そうた・めい）になる */
  private profile(): FamilyProfile {
    const row = this.sql.exec("SELECT value FROM settings WHERE key = 'profile'").toArray()[0];
    const base = loadProfile(row?.value === "sample" ? undefined : this.env.FAMILY_PROFILE);
    // 園・学校の電話は LINE で「保育所の電話 0120-…  9:00まで」と教えてもらい、家族ごとの箱に置く（secret を触らずに済む）
    const contacts = { ...base.contacts };
    for (const r of this.sql.exec<{ key: string; value: string }>("SELECT key, value FROM settings WHERE key LIKE 'contact.%'").toArray()) {
      const place = r.key.slice("contact.".length);
      if (place === "保育所" || place === "小学校") contacts[place] = JSON.parse(r.value);
    }
    return { ...base, contacts };
  }

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
      // 決まった枠・家族が行かない枠（ファミサポ・お休み）は、お便りや毎日の枠で上書きしない
      if (same.status === "決定" || same.status === "不要") continue;
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
    const profile = this.profile();
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

  // ── LINE への送り方（送信数を使わないように） ─────────────────
  // 返信は無料で何通でも。数えるのはプッシュだけ（グループ宛ては人数ぶん）。だから：
  //  1) 1つの発言への返事は、全部まとめて1回の返信にする（send は箱に入れるだけ、flush で送る）
  //  2) 急がない知らせ（冒険カード・送れなかった聞き取り）は、次にグループで話したときの返信に相乗りさせる
  //  3) 定時のお知らせは、今月の残りを残りの日数で割った「今日のぶん」の中だけで送る
  //  4) 念押しは担当の人だけに送る（人数ぶん → 1）

  /** 返事を箱に入れる。送るのは flush（1つの発言に1回の返信） */
  private send(queued: QueuedEvent, messages: OutMessage[]): Promise<void> {
    (queued.outbox ??= []).push(...messages);
    return Promise.resolve();
  }

  /** 1つの発言への返事を、1回の返信で送る。グループなら、待っている知らせも空きに相乗りさせる */
  private async flush(queued: QueuedEvent) {
    const own = fitFive(queued.outbox ?? []);
    queued.outbox = [];
    const isGroup = queued.event.source.type !== "user";
    const later = isGroup ? this.takeLater(5 - own.length) : [];
    const messages = [...own, ...later.flatMap((l) => l.messages)];
    const { replyToken } = queued.event;
    if (messages.length === 0 || !replyToken) return;
    if (await reply(this.env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, messages)) {
      for (const l of later) this.sql.exec("DELETE FROM later WHERE kind = ?", l.kind);
      if (later.length > 0) console.log(JSON.stringify({ step: "later_sent", n: later.length }));
      return;
    }
    // 返信できなかった（期限切れなど）。相乗りぶんは待たせたまま、自分の返事だけ
    if (own.length === 0) return;
    console.log(JSON.stringify({ step: "reply_fallback", to: isGroup ? "group" : "user" }));
    if (!isGroup) {
      await this.pushTo(queued.event.source.userId!, own, false);
      return;
    }
    // グループ宛ては定時のお知らせと同じ「今日のぶん」で。足りなければ次の返信に相乗り
    if (!(await this.pushTo(queued.familyId, own, true))) this.defer(own, `late:${queued.event.webhookEventId}`, Date.now() + 2 * 86_400_000);
  }

  /** あとで次の返信に相乗りさせる。kind が同じものは新しいほうに置き換える */
  private defer(messages: OutMessage[], kind: string, expiresAt: number) {
    this.sql.exec(
      "INSERT OR REPLACE INTO later (kind, payload, created_at, expires_at) VALUES (?, ?, ?, ?)",
      kind,
      JSON.stringify(messages.slice(0, 5)),
      Date.now(),
      expiresAt,
    );
    console.log(JSON.stringify({ step: "deferred", kind: kind.split(":")[0], n: messages.length }));
  }

  /** 空き（room 通）に入るぶんだけ、古い順に取り出す。期限切れは捨てる */
  private takeLater(room: number): { kind: string; messages: OutMessage[] }[] {
    this.sql.exec("DELETE FROM later WHERE expires_at < ?", Date.now());
    if (room <= 0) return [];
    const rows = this.sql.exec<{ kind: string; payload: string }>("SELECT kind, payload FROM later ORDER BY created_at").toArray();
    const out: { kind: string; messages: OutMessage[] }[] = [];
    // 待っている間に決まった枠（名前ボタン・「ファミサポに頼みました」）の「行ける人？」「まだ決まっていません」は出さない
    const open = (id: number) => {
      const slot = this.slotById(id);
      return !!slot && (slot.status === "未定" || slot.status === "お願い中");
    };
    for (const r of rows) {
      const undecided = /^undecided:(\d+)$/.exec(r.kind);
      let messages = (JSON.parse(r.payload) as OutMessage[]).filter((m) => {
        const asked = /引受 #(\d+)/.exec(JSON.stringify(m));
        return !asked || open(Number(asked[1]));
      });
      if (undecided && !open(Number(undecided[1]))) messages = [];
      if (messages.length === 0) {
        this.sql.exec("DELETE FROM later WHERE kind = ?", r.kind);
        continue;
      }
      if (messages.length > room) continue;
      out.push({ kind: r.kind, messages });
      room -= messages.length;
    }
    return out;
  }

  /** グループへのプッシュ。auto は定時のお知らせ（今日のぶんの中だけ）。送れたら true */
  private async pushToGroup(messages: OutMessage[], auto = false): Promise<boolean> {
    const familyId = this.familyId();
    if (!familyId) return false;
    return this.pushTo(familyId, messages, auto);
  }

  /** プッシュ（グループなら人数ぶん、1人なら1通）。送信数が足りない・届かないときは false（例外にしない） */
  private async pushTo(to: string, messages: OutMessage[], auto: boolean): Promise<boolean> {
    const token = this.env.LINE_CHANNEL_ACCESS_TOKEN;
    const isUser = to.startsWith("U");
    const need = isUser ? 1 : ((await chatMemberCount(token, to).catch(() => null)) ?? ADULTS.length);
    if (!(await this.budget(need, auto))) return false;
    try {
      await push(token, to, messages.slice(0, 5));
    } catch (error) {
      console.error("push failed", isUser ? "user" : "group", error instanceof Error ? error.message.slice(0, 120) : "");
      return false;
    }
    this.count("プッシュ", need);
    return true;
  }

  /**
   * 送ってよいか。家族が頼んだとき（auto=false）は、残りが足りれば送る。
   * 定時のお知らせ（auto）は、PUSH_RESERVE を残し、さらに「残り÷今月の残りの日数」を今日のぶんとして、その中だけ。
   * 上限なしのプランなら止めない。残りが読めないときは、家族が頼んだぶんだけ送り、定時のお知らせは送らない
   * （11/4：読めないまま「送る」に倒れて、定時のお知らせがグループに4回出た）
   */
  private async budget(need: number, auto: boolean): Promise<boolean> {
    const remaining = await pushRemaining(this.env.LINE_CHANNEL_ACCESS_TOKEN).catch(() => null);
    if (remaining === null) {
      if (auto) console.log(JSON.stringify({ step: "push_skipped", auto, remaining: null, need }));
      return !auto;
    }
    if (remaining === Infinity) return true;
    if (!auto) {
      const ok = remaining >= need;
      if (!ok) console.log(JSON.stringify({ step: "push_skipped", auto, remaining, need }));
      return ok;
    }
    const today = jstDate();
    const usedToday = this.countOf("プッシュ", today);
    const daily = Math.floor((remaining + usedToday - PUSH_RESERVE) / daysLeftInMonth(today));
    const ok = remaining - need >= PUSH_RESERVE && usedToday + need <= daily;
    if (!ok) console.log(JSON.stringify({ step: "push_skipped", auto, remaining, need, usedToday, daily }));
    return ok;
  }

  private countOf(key: string, day: string): number {
    return Number(this.sql.exec<{ n: number }>("SELECT n FROM counts WHERE day = ? AND key = ?", day, key).toArray()[0]?.n ?? 0);
  }
}

/** 1回の返信は5通まで。超えるときは、続いた文だけの吹き出しを1つにまとめ、それでも多ければ先頭の5通 */
function fitFive(messages: OutMessage[]): OutMessage[] {
  if (messages.length <= 5) return messages;
  const merged: OutMessage[] = [];
  for (const m of messages) {
    const last = merged[merged.length - 1];
    if (m.type === "text" && !m.quickReply && last?.type === "text" && !last.quickReply) {
      merged[merged.length - 1] = { ...last, text: `${last.text}\n\n${m.text}` };
    } else merged.push(m);
  }
  if (merged.length > 5) console.log(JSON.stringify({ step: "reply_trimmed", dropped: merged.length - 5 }));
  return merged.slice(0, 5);
}

/** 今月の残りの日数（今日を含む） */
function daysLeftInMonth(today: string): number {
  const [y, m, d] = today.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return last - d + 1;
}

function isWeekend(date: string) {
  const day = jstWeekday(date);
  return day === 0 || day === 6;
}

/** 本文で @名指しされた人（だんどりさん自身は除く） */
function mentionedUserIds(event: LineEvent): string[] {
  return (event.message?.mention?.mentionees ?? [])
    .filter((m) => !m.isSelf && m.userId)
    .map((m) => m.userId as string);
}

/** ボタンが代わりに送る文（名前ボタン・ありがとう・OK・名乗り・メニュー）。「手で打った文」から外す */
function isButtonText(text: string): boolean {
  return (
    !!parseAccept(text) ||
    !!parseThanks(text) ||
    /^(OK|直す) #\d+$/.test(text) ||
    /^わたしは\s*(パパ|ママ|じいじ|ばあば)$/.test(text) ||
    /^(メニュー|使い方|お迎えを頼む|休みの連絡|予定 見せて|お便りを送る|(保育所|小学校)の電話を教える|(パパ|ママ|じいじ|ばあば)に頼んで)$/.test(text)
  );
}

/** 「○○に頼んで」の ○○ が家族のだれか。呼び名・言い換えで見る */
function roleInText(text: string): Adult | null {
  // 「祖父に」を「父に」と読まないよう、じいじ・ばあばを先に見る
  const order: Adult[] = ["じいじ", "ばあば", "パパ", "ママ"];
  return order.find((a) => new RegExp(`(${ROLE_WORDS[a]})(さん|ちゃん)?[\\s　]*(に|へ)`).test(text)) ?? null;
}

/** だんどりさんへの呼びかけ（@だんどりさん）だけを本文から外す。ほかの人への @ は残す */
function withoutSelfMention(event: LineEvent, fallback: string): string {
  const raw = event.message?.text;
  if (!raw) return fallback;
  let text = raw;
  const spans = (event.message?.mention?.mentionees ?? []).filter((m) => m.isSelf).sort((a, b) => b.index - a.index);
  for (const s of spans) text = text.slice(0, s.index) + text.slice(s.index + s.length);
  // 改行は残す（「28日土曜お迎え パパ\nさくら遅番」の1行目だけを読むため。11/4 に改行がつぶれて読めなかった）
  return text.replace(/@だんどりさん/g, "").replace(/[ \t　]+/g, " ").replace(/ *\n */g, "\n").trim();
}

/** だんどりさん自身が @名指しされたか */
function botMentioned(event: LineEvent): boolean {
  return (event.message?.mention?.mentionees ?? []).some((m) => m.isSelf) || /@だんどりさん/.test(event.message?.text ?? "");
}

/** 本文から @名指しの部分を取り除く（「さくらに依頼して @だんどりさん」→「さくらに依頼して」） */
function stripMentions(event: LineEvent): string {
  let text = event.message?.text ?? "";
  const spans = [...(event.message?.mention?.mentionees ?? [])].sort((a, b) => b.index - a.index);
  for (const s of spans) text = text.slice(0, s.index) + text.slice(s.index + s.length);
  return text.replace(/@だんどりさん/g, "");
}

/** グループでの急なお迎えの頼み。「お迎え」＋急ぎ・呼びかけの言葉。引受のボタン文は除く */
function isUrgentPickup(text: string) {
  if (/引受 #\d+/.test(text)) return false;
  return /迎え|むかえ/.test(text) && /今すぐ|今から|至急|すぐ|電話|呼び出し|だれか|誰か|行ける|頼め|頼ん|お願い/.test(text);
}

/**
 * 直前の写真を残してほしい言い方。
 * 「思い出に入れておいて」「アルバムに」「この写真 残して」「写真とっといて」「○○の成長記録に」「保存して」
 * 「思い出」「写真」だけの雑談（「いい思い出になるね」）は拾わない
 */
export function wantsToKeepPhoto(text: string): boolean {
  const t = text.replace(/[\s　]/g, "");
  if (/成長記録/.test(t)) return true;
  if (/(思い出|アルバム|記録)に(入れ|いれ|して|残し|のこし|とっ|しといて|しておいて|追加)/.test(t)) return true;
  if (/^(この)?(写真|これ)(を|は)?.*(残し|のこし|とっ(て|と)お|とっとい|記録し|保存し|入れ(て|と)お|入れとい|思い出に)/.test(t)) return true;
  return /^(残して|のこして|とっておいて|とっといて|保存して|保存しておいて|保存しといて)$/.test(t);
}

/** 同じ予定か（聞き返しの答えで「変わったところ」だけを見せるため） */
function sameCard(a: Card, b: Card): boolean {
  const key = (c: Card) =>
    [c.child, c.kind, c.title, c.date, c.time, c.place, c.deadline, c.items.join("・"), c.money, c.who_acts].join("|");
  return key(a) === key(b);
}

/**
 * 予定カードを家族向けの短い行に。同じ予定のきょうだいは1行にまとめる（「ゆい・そうた・めい：11/16（月） 内科健診」）。
 * 日付順、6行まで
 */
function summarizeCards(cards: Card[], profile: FamilyProfile): string {
  const groups = new Map<string, { children: string[]; card: Card }>();
  for (const c of cards) {
    const key = [c.kind, c.title, c.date, c.time, c.who_acts, c.items.join("・"), c.money, c.deadline].join("|");
    const g = groups.get(key);
    if (g) {
      if (!g.children.includes(c.child)) g.children.push(c.child);
    } else groups.set(key, { children: [c.child], card: c });
  }
  const all = profile.children.map((c) => c.name);
  // 「生活発表会」と「生活発表会の送迎」は1行に（送迎は19:00 に聞くので、ここでは行事だけ見せる）
  const shown = [...groups.values()].filter(
    ({ card }) => !(card.kind === "送迎" && card.who_acts === "未定" && cards.some((o) => o !== card && o.kind !== "送迎" && o.date === card.date && card.title.startsWith(o.title))),
  );
  const rows = shown.sort((a, b) => (a.card.date ?? "9999").localeCompare(b.card.date ?? "9999"));
  const lines = rows.map(({ children, card }) => {
    const known = children.filter((n) => n && n !== "未定" && n !== "不明");
    const names =
      known.includes("全員") || (all.length > 1 && all.every((n) => known.includes(n))) ? "全員" : known.join("・");
    const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}（${"日月火水木金土"[jstWeekday(d)]}）`;
    const when = card.date ? `${md(card.date)}${card.time ? ` ${card.time}` : ""}` : "日にち未定";
    const extra = [
      card.who_acts !== "未定" ? card.who_acts : "",
      card.items.length > 0 ? card.items.slice(0, 3).join("・") : "",
      card.money ? `${card.money.toLocaleString("ja-JP")}円` : "",
      card.deadline ? `締切 ${md(card.deadline)}` : "",
    ].filter(Boolean);
    return `${names ? `${names}：` : ""}${when} ${card.title}${extra.length > 0 ? `（${extra.join("、")}）` : ""}`;
  });
  return lines.length > 6 ? [...lines.slice(0, 6), `ほか ${lines.length - 6}件`].join("\n") : lines.join("\n");
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
    note: row.note ?? undefined,
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
