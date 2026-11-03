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
import {
  createRichMenu,
  deleteRichMenu,
  fetchImage,
  linkRichMenu,
  mentionText,
  push,
  reply,
  uploadRichMenuImage,
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
  declineMessage,
  describeSlot,
  parseAccept,
  parseDecline,
  parseRequest,
  reminderMessage,
  slotsFromCards,
  undecidedMessage,
} from "./pickup";
import { loadProfile, type FamilyProfile } from "./profile";
import { readNotice, type ReadInput } from "./reader";
import { addDays, jstDate, jstTime, jstToMs, jstWeekday, nextSundayEvening, weekRange } from "./time";
import { ADULTS, type Adult, type FamilyEvent, type Slot } from "./types";

// 返信トークンは1分以内が目安。余裕をみて、これを過ぎたらプッシュで届ける
const REPLY_WINDOW_MS = 50_000;
const SEEN_KEEP_MS = 2 * 24 * 60 * 60 * 1000;
const ASK_EVENING = "19:00";
const ASK_MORNING = "07:00";
const REMIND_BEFORE_MS = 30 * 60 * 1000;

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
const HOW_TO = `できること
📷 お便りの写真を送る → 予定にします（写真は残るので紙は捨ててOK）
🤒「そうた 熱37.8 休み」→ 園・学校への連絡文
🚗「明日17時のお迎え頼んでおいて」→ 代わりに聞きます
📅「予定 見せて」→ 週・月のカレンダー（お便りの写真もここ）
🙏 引き受けた人に［ありがとう］
1対1のトークでは、下の「メニュー」から同じことができます`;

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
      CREATE TABLE IF NOT EXISTS photos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL, message_id TEXT, date TEXT NOT NULL, label TEXT NOT NULL,
        media_type TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recent_images (message_id TEXT PRIMARY KEY, received_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS flows (user_id TEXT PRIMARY KEY, step TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
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
    } else if (event.type === "message" && event.message?.type === "text") {
      const text = (event.message.text ?? "").trim();
      // 1対1は名簿にいる大人だけ。中身の扱いはグループと同じで、家族に聞くことだけグループへ流す
      if (isPrivate && !this.roleOf(event.source.userId)) {
        await this.send(queued, [{ type: "text", text: "家族のグループで、まず「わたしは ○○」を送ってください。" }]);
        return;
      }
      await this.handleText(queued, text);
    }
  }

  /** 1対1の自由な文：「明日17時のお迎え頼んでおいて」をグループで代わりに聞く。頼みとして読めなければ false */
  private async privateRequest(queued: QueuedEvent, text: string, role: Adult): Promise<boolean> {
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
    await this.askGroup(queued, [askMessage({ ...slot, status: "お願い中" }, { exclude: role })]);
    return true;
  }

  /** 家族に聞く文。グループで言われたならそのまま返事、1対1ならグループへ流して本人には「聞きました」 */
  private async askGroup(queued: QueuedEvent, messages: OutMessage[]) {
    if (queued.event.source.type !== "user") {
      await this.send(queued, messages);
      return;
    }
    await this.pushToGroup(messages);
    await this.send(queued, [{ type: "text", text: "グループで聞きました。グループを見ていてください。" }]);
  }

  private async handleText(queued: QueuedEvent, text: string) {
    const userId = queued.event.source.userId;
    const isPrivate = queued.event.source.type === "user";
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
    if (/^(予定|カレンダー)[\s　]*(見せて|みせて|教えて|おしえて|を見る)?$/.test(text)) {
      const token = await this.calendarToken(queued.familyId);
      const base = `https://kazoku-dandori.dandori.workers.dev/c/${token}`;
      // URL は見せず、ボタンで開く。Google カレンダー用の購読 URL はコピーで渡す
      await this.send(queued, [
        {
          type: "flex",
          altText: "わが家の予定（週・月）",
          contents: {
            type: "bubble",
            size: "kilo",
            body: {
              type: "box",
              layout: "vertical",
              spacing: "sm",
              paddingAll: "12px",
              contents: [
                { type: "text", text: "わが家の予定", weight: "bold", size: "md" },
                { type: "text", text: "家族だけのページです。外に送らないでください。", size: "xs", color: "#666666", wrap: true },
                { type: "button", style: "primary", height: "sm", action: { type: "uri", label: "📅 カレンダーを開く", uri: base } },
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
      await this.askGroup(queued, [declineMessage(role), askMessage({ ...slot, who: null, status: "お願い中" }, { exclude: role })]);
      return;
    }

    // 「そうた 熱37.8 休み」→ 相手ごとの連絡文
    if (looksLikeAbsence(text)) {
      const draft = await draftAbsence(this.env.ANTHROPIC_API_KEY, {
        text,
        profile: this.profile(),
        today,
      });
      console.log(JSON.stringify({ step: "absence", attends: draft.attends, ask: !!draft.ask }));
      await this.send(queued, absenceMessages(draft, this.profile().contacts));
      return;
    }

    // 1対1の自由な文は、まず「頼んでおいて」として読む
    const role = this.roleOf(userId);
    if (isPrivate && role && (await this.privateRequest(queued, text, role))) return;

    const saved = await this.read(queued, { text }, "ひとこと");
    // グループの雑談には黙る。1対1で分からなかったときだけ、入口を出す
    if (!saved && isPrivate) await this.send(queued, [withButtons("分かりませんでした。下のボタンからどうぞ。", MENU_BUTTONS)]);
  }

  // ── 芯A：読んで、聞く ─────────────────────────────────

  /** お便りと判断して返事をしたら、写真を残すための日付と題名を返す。雑談なら null */
  private async read(
    queued: QueuedEvent,
    input: Pick<ReadInput, "text" | "image">,
    source: CardSource,
  ): Promise<{ date: string; label: string } | null> {
    // 文は聞き返しや直しへの答えかもしれない。新しい写真は別の連絡として読む
    const awaiting = input.text
      ? this.sql
          .exec<Batch>("SELECT id, cards FROM batches WHERE awaiting IS NOT NULL AND status = 'pending' ORDER BY id DESC LIMIT 1")
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
          ? `成長記録に残しました（${label}）。家のページの「成長記録」に並びます。`
          : "思い出に残しました。家のページの「成長記録」と今日の日付から見られます。",
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
    const profile = this.profile();
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

  // ── ボタンで進む会話（選ばせる。文を考えさせない） ──────────

  /** 進行中の会話があれば1歩進めて true。「お迎えを頼む」「休みの連絡」の入口もここ */
  private async continueFlow(queued: QueuedEvent, userId: string, text: string): Promise<boolean> {
    const today = jstDate();
    const profile = this.profile();
    const row = this.sql.exec<{ step: string; data: string }>("SELECT step, data FROM flows WHERE user_id = ?", userId).toArray()[0];
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
