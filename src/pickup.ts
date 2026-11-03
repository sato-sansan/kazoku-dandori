// 送り迎えの枠と、だんどりさんがグループに出す文。純粋関数だけ（保存・送信は family.ts）

import type { Card } from "./card";
import type { FlexMessage, OutMessage, TextMessage } from "./line";
import type { FamilyProfile } from "./profile";
import { ADULTS, type Adult, type Slot } from "./types";

// 毎日の枠の時刻。朝は未確認なので 7:30 で仮置き（DESIGN §4）
const MORNING = "07:30";
const EVENING = "17:30";

/** 園の連絡アプリは続柄で書く */
const ROLE: Record<Adult, string> = { パパ: "父", ママ: "母", じいじ: "祖父", ばあば: "祖母" };
const WEEKDAY = ["日", "月", "火", "水", "木", "金", "土"];

function kindWord(kind: Slot["kind"]) {
  return kind === "迎え" ? "お迎え" : "送り";
}

/** Workers は UTC。文字列を UTC の日付としてだけ扱い、タイムゾーンに触れない */
function addDays(date: string, n: number) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** 「11/4（火）」。年は家族には要らない */
function shortDate(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  const w = WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}/${d}（${w}）`;
}

/** 枠が何人・だれの分か。「保育所3人」か「ゆいの保育所」。子が分からなければ場所だけ */
function whose(slot: Slot) {
  if (slot.children.length === 0) return slot.place;
  if (slot.children.length === 1) return `${slot.children[0]}の${slot.place}`;
  return `${slot.place}${slot.children.length}人`;
}

/** 毎日の決まった枠（朝の送り・夕のお迎え）。profile.children の attends が「保育所」の子を対象にする */
export function dailySlots(profile: FamilyProfile, date: string): Omit<Slot, "id">[] {
  const children = profile.children.filter((c) => c.attends === "保育所").map((c) => c.name);
  if (children.length === 0) return [];
  const base = { date, place: "保育所", children, who: null, status: "未定" as const, requestedBy: "自動" as const };
  return [
    { ...base, time: MORNING, kind: "送り" },
    { ...base, time: EVENING, kind: "迎え" },
  ];
}

/** 予定カードから足す枠（kind が 送迎・習い事・通院、または下校時刻の変更など time がある行事）。date が同じ日のものだけ */
export function slotsFromCards(cards: Card[], date: string): Omit<Slot, "id">[] {
  return cards
    .filter((card) => card.date === date)
    .filter((card) => ["送迎", "習い事", "通院"].includes(card.kind) || (card.kind === "行事" && card.time))
    .map((card) => {
      // 時刻がなければ夕方の枠に合わせる（朝と決めつけると送りが二重になる）
      const time = card.time ?? EVENING;
      // 題名に書いてあればそれを信じ、なければ昼前は送り・昼過ぎは迎え
      const kind: Slot["kind"] = /迎え|むかえ/.test(card.title)
        ? "迎え"
        : /送り|おくり/.test(card.title)
          ? "送り"
          : time < "12:00"
            ? "送り"
            : "迎え";
      const who = card.who_acts === "未定" ? null : card.who_acts;
      // 場所が読めなかったときは種類で補う（習い事を「保育所」と言わない）
      const place = card.place ?? (card.kind === "通院" ? "病院" : card.kind === "習い事" ? "習い事" : "保育所");
      return {
        date,
        time,
        kind,
        place,
        children: card.child === "全員" ? [] : [card.child],
        who,
        status: who ? "決定" : "未定",
        requestedBy: "自動",
      };
    });
}

/** 未定の枠をお願いする Flex。ボタンは message action、送る文字列は `お迎え引受 #<slotId> <名前>`（朝の送りなら `送り引受 #<id> <名前>`）。exclude の人のボタンは出さない。文は短く・1行15字以内を目安（ばあばが読む） */
export function askMessage(slot: Slot, options?: { exclude?: Adult; retry?: boolean }): FlexMessage {
  const word = kindWord(slot.kind);
  // 「今日・明日」は today がないと間違えるので、日付そのものを出す
  const when = `${shortDate(slot.date)} ${slot.time}`;
  const what = `${whose(slot)}の${word}`;
  const head = options?.retry ? `まだ決まっていません ${when}` : when;
  // exclude は頼んだ人。理由は書かない（だれが頼んだか出さない）
  const buttons = ADULTS.filter((a) => a !== options?.exclude).map((name) => ({
    type: "button",
    style: "primary",
    height: "sm",
    action: { type: "message", label: name, text: `${word}引受 #${slot.id} ${name}` },
  }));
  // 縦に長いと前のやり取りが隠れる。小さめの1枚に、ボタンは横並び（4つなら2段）
  const rows = [buttons.slice(0, 2), buttons.slice(2)].filter((r) => r.length > 0);
  return {
    type: "flex",
    altText: `${when} ${what}、行ける人？`,
    contents: {
      type: "bubble",
      size: "kilo",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "xs",
        paddingAll: "12px",
        contents: [
          { type: "text", text: head, size: "sm", color: "#666666", wrap: true },
          { type: "text", text: `${what}、行ける人？`, size: "md", weight: "bold", wrap: true },
          ...rows.map((row) => ({ type: "box", layout: "horizontal", spacing: "sm", margin: "sm", contents: row })),
        ],
      },
    },
  };
}

/** 「お迎え引受 #12 ばあば」のような発言を解く。合わなければ null */
export function parseAccept(text: string): { slotId: number; who: Adult } | null {
  const m = /^(?:お迎え|送り)引受\s*#(\d+)\s+(パパ|ママ|じいじ|ばあば)$/.exec(text.trim());
  if (!m) return null;
  return { slotId: Number(m[1]), who: m[2] as Adult };
}

/** 「今日は無理」「無理」「行けない」など断りの発言か。「無理しないで」は拾ってしまう（短文を優先） */
export function parseDecline(text: string): boolean {
  if (parseAccept(text)) return false;
  return /無理|むり|行けない|いけない|行けません|難しい|むずかしい|都合が悪い|だめ|ダメ|できない/.test(text);
}

/** 園の連絡アプリ（自由文の欄）に貼る文。翌朝に貼るので「本日」 */
function noticeText(slot: Slot, who: Adult) {
  const role = ROLE[who];
  if (slot.kind === "迎え") return `本日のお迎えは${role}が${slot.time}にうかがいます。よろしくお願いします。`;
  return `本日は${role}が${slot.time}に送ります。よろしくお願いします。`;
}

/** 確定の知らせ＋園の連絡アプリに貼る文。コピーは clipboard action、古い端末向けに本文にも同じ文を出す */
export function confirmMessages(slot: Slot, who: Adult): OutMessage[] {
  const notice = noticeText(slot, who);
  const flex: FlexMessage = {
    type: "flex",
    altText: `${slot.place}への連絡文：${notice}`,
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: `${slot.place}への連絡文`, size: "sm", color: "#888888" },
          { type: "text", text: notice, wrap: true, size: "md" },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "button",
            style: "primary",
            height: "md",
            action: { type: "clipboard", label: "コピー", clipboardText: notice },
          },
        ],
      },
    },
  };
  return [{ type: "text", text: `${who}に決まりました。ありがとう。` }, flex];
}

/** 2人目が押したとき */
export function alreadyDecidedMessage(slot: Slot): TextMessage {
  const who = slot.who ?? "ほかの人";
  return { type: "text", text: `${kindWord(slot.kind)}はもう${who}に決まっています。ありがとう。` };
}

/** 断りを角を立てずに言い直す。例「じいじは今日は難しいそうです。ほかに行ける人？」 */
export function declineMessage(who: Adult): TextMessage {
  // 前の晩に断られることが多いので「今日は」と言わない
  return { type: "text", text: `${who}は難しいそうです。ほかに行ける人？` };
}

/** 念押し（出る30分前）。担当の名前を文頭に */
export function reminderMessage(slot: Slot): TextMessage {
  const head = slot.who ? `${slot.who}、` : "";
  return { type: "text", text: `${head}${slot.time} ${whose(slot)}の${kindWord(slot.kind)}です。よろしくお願いします。` };
}

/** 朝7:00まで決まらなかったとき。だれにも振らない（勝手に決めない） */
export function undecidedMessage(slot: Slot): TextMessage {
  return { type: "text", text: `${slot.time} ${whose(slot)}の${kindWord(slot.kind)}、まだ決まっていません。` };
}

/** 全角の数字と記号を半角に（「１７時」「17：00」を読めるように） */
function toHalfWidth(text: string) {
  return text.replace(/[０-９：＃]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/** 「明日17時のお迎え頼んでおいて」のような1対1の頼みを解く。日付は today（YYYY-MM-DD、JST）基準で「明日」「あした」「今日」を解釈。時刻がなければ 17:30。合わなければ null */
export function parseRequest(text: string, today: string): { date: string; time: string; kind: "送り" | "迎え" } | null {
  const t = toHalfWidth(text);
  const kind: "送り" | "迎え" | null = /迎え|むかえ/.test(t) ? "迎え" : /送り|おくり/.test(t) ? "送り" : null;
  if (!kind) return null;
  // 日の言葉がなければ明日。1対1で頼むのはほぼ前の晩
  const date = /今日|きょう/.test(t) ? today : /明後日|あさって/.test(t) ? addDays(today, 2) : addDays(today, 1);
  const m = /(\d{1,2})(?::(\d{2})|時(半|(\d{1,2})分)?)/.exec(t);
  let time = kind === "迎え" ? EVENING : MORNING;
  if (m) {
    const h = Number(m[1]);
    const min = m[2] ?? (m[3] === "半" ? "30" : (m[4] ?? "0"));
    if (h < 24 && Number(min) < 60) time = `${String(h).padStart(2, "0")}:${min.padStart(2, "0")}`;
  }
  // 呼び出し側は date と kind が同じ毎日の枠があればそちらに寄せる（17:00 と 17:30 を別枠にしない）
  return { date, time, kind };
}

/** 枠の説明文「明日 17:30、保育所3人のお迎え」のような短い1行 */
export function describeSlot(slot: Slot, today: string): string {
  const rel = slot.date === today ? "今日" : slot.date === addDays(today, 1) ? "明日" : shortDate(slot.date);
  return `${rel} ${slot.time}、${whose(slot)}の${kindWord(slot.kind)}`;
}

/*
askMessage の出力例（17:30 の迎え、exclude なし）:
{
  "type": "flex",
  "altText": "11/4（水） 17:30 保育所3人のお迎え、行ける人？",
  "contents": {
    "type": "bubble",
    "body": {
      "type": "box",
      "layout": "vertical",
      "spacing": "md",
      "contents": [
        { "type": "text", "text": "11/4（水） 17:30", "wrap": true, "size": "lg", "weight": "regular" },
        { "type": "text", "text": "保育所3人のお迎え", "wrap": true, "size": "lg", "weight": "regular" },
        { "type": "text", "text": "行ける人？", "wrap": true, "size": "lg", "weight": "bold" }
      ]
    },
    "footer": {
      "type": "box",
      "layout": "vertical",
      "spacing": "sm",
      "contents": [
        { "type": "button", "style": "primary", "height": "md",
          "action": { "type": "message", "label": "パパ", "text": "お迎え引受 #12 パパ" } },
        { "type": "button", "style": "primary", "height": "md",
          "action": { "type": "message", "label": "ママ", "text": "お迎え引受 #12 ママ" } },
        { "type": "button", "style": "primary", "height": "md",
          "action": { "type": "message", "label": "じいじ", "text": "お迎え引受 #12 じいじ" } },
        { "type": "button", "style": "primary", "height": "md",
          "action": { "type": "message", "label": "ばあば", "text": "お迎え引受 #12 ばあば" } }
      ]
    }
  }
}
*/
