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

/** 土日なら次の月曜。平日はそのまま（金曜に「明日の段取り」を聞かれたら、週末をはさんで月曜を見るため） */
export function nextWeekday(date: string): string {
  let d = date;
  for (let i = 0; i < 2; i++) {
    const [y, m, dd] = d.split("-").map(Number);
    const w = new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
    if (w !== 0 && w !== 6) break;
    d = addDays(d, 1);
  }
  return d;
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
/**
 * 前の晩 19:00 に、明日の持ち物・集金・締切を1通で。送迎の聞き取りと同じ1回のお知らせに入れる（送信数を増やさない）。
 * 何も無ければ null
 */
export function itemsMessage(cards: Card[], date: string): TextMessage | null {
  const who = (c: Card) => (c.child && c.child !== "全員" ? c.child : "みんな");
  const lines: string[] = [];
  for (const c of cards.filter((c) => c.date === date && (c.items.length > 0 || c.money))) {
    const rest = c.items.filter((i) => i !== c.title);
    const things = rest.length > 0 ? `（${rest.join("・")}）` : "";
    const money = c.money ? ` ${c.money.toLocaleString("ja-JP")}円` : "";
    lines.push(`・${who(c)}：${c.title}${things}${money}`);
  }
  for (const c of cards.filter((c) => c.deadline === date && c.date !== date)) {
    lines.push(`・${who(c)}：${c.title} の締切${c.money ? `（${c.money.toLocaleString("ja-JP")}円）` : ""}`);
  }
  if (lines.length === 0) return null;
  return { type: "text", text: [`🎒 ${shortDate(date)}の持ち物・集金`, ...lines.slice(0, 8)].join("\n") };
}

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
/**
 * 「今日」「明日」「明後日」「5日」「11/5」「11月5日」を日付に。日の言葉が無ければ null。
 * past：済んだ話（「4日のお迎えはママでした」）。過ぎた日を来月・来年にせず、「昨日」「月曜」も前の日として読む（11/5：「4日」を 12/4 と読んだ）
 */
export function parseDay(text: string, today: string, options?: { past?: boolean }): string | null {
  const t = toHalfWidth(text);
  const past = options?.past ?? false;
  if (/今日|きょう/.test(t)) return today;
  if (past && /一昨日|おととい/.test(t)) return addDays(today, -2);
  if (past && /昨日|きのう/.test(t)) return addDays(today, -1);
  if (/明後日|あさって/.test(t)) return addDays(today, 2);
  if (/明日|あした/.test(t)) return addDays(today, 1);
  const [y, m0, d0] = today.split("-").map(Number);
  // 「11月31日」のような無い日は null（枠を作らない）
  const iso = (yy: number, mm: number, dd: number) => {
    const s = `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    return new Date(Date.UTC(yy, mm - 1, dd)).toISOString().slice(0, 10) === s ? s : null;
  };
  const md = /(\d{1,2})[/月](\d{1,2})日?/.exec(t);
  if (md) {
    const m = Number(md[1]);
    const d = Number(md[2]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return iso(past ? (m > m0 ? y - 1 : y) : m < m0 ? y + 1 : y, m, d);
  }
  // 「5日」：今月のその日。もう過ぎていれば来月（済んだ話なら今月のまま）
  const dd = /(?:^|[^\d/:])(\d{1,2})日(?![\d:])/.exec(t);
  if (dd) {
    const d = Number(dd[1]);
    if (d >= 1 && d <= 31) {
      if (d >= d0 || past) return iso(y, m0, d) ?? (m0 === 12 ? iso(y + 1, 1, d) : iso(y, m0 + 1, d));
      return m0 === 12 ? iso(y + 1, 1, d) : iso(y, m0 + 1, d);
    }
  }
  // 「金曜」「木曜日」：今日から数えて次のその曜日（今日がその曜日なら今日）。「来週の金曜」は来週の月〜日の中。
  // 済んだ話なら、いちばん近い前のその曜日（今日がその曜日なら今日）
  const wk = /(来週の?)?([月火水木金土日])曜/.exec(t);
  if (wk) {
    const target = WEEKDAY.indexOf(wk[2]);
    const wd = new Date(Date.UTC(y, m0 - 1, d0)).getUTCDay();
    if (wk[1]) {
      const nextMonday = addDays(today, ((8 - wd) % 7) || 7);
      return addDays(nextMonday, (target + 6) % 7);
    }
    if (past) return addDays(today, -((wd - target + 7) % 7));
    return addDays(today, (target - wd + 7) % 7);
  }
  return null;
}

export function parseRequest(
  text: string,
  today: string,
  options?: { loose?: boolean },
): { date: string; time: string; kind: "送り" | "迎え" } | null {
  const t = toHalfWidth(text);
  // loose（断る・頼むと分かっている文だけ）：「朝」だけなら送り、「夕方」「帰り」だけなら迎え。
  // 1対1の「明日の朝、雨だって」を頼みにしないため、ふだんは「送り」「迎え」の言葉が要る
  const kind: "送り" | "迎え" | null = /迎え|むかえ/.test(t)
    ? "迎え"
    : /送り|おくり/.test(t)
      ? "送り"
      : options?.loose && /夕方|帰り/.test(t)
        ? "迎え"
        : options?.loose && /朝/.test(t)
          ? "送り"
          : null;
  if (!kind) return null;
  // 日の言葉がなければ明日。1対1で頼むのはほぼ前の晩
  const date = parseDay(t, today) ?? addDays(today, 1);
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

/** 家族の呼び方の言い換え。「おばあちゃん」「ばーば」「お父さん」も ばあば・パパ として読む */
// ひらがなの「まま」「ぱぱ」は「このまま」に、「夫」は「大丈夫」に紛れるので使わない（11/5 の見直し）。
// 「お義母さん」「義父」は じいじ・ばあば（パパ・ママを見るときは消してから見る）
export const ROLE_WORDS: Record<Adult, string> = {
  パパ: "パパ|お父さん|おとうさん|父|(?<![丈工])夫|旦那",
  ママ: "ママ(?!友)|お母さん|おかあさん|母|妻|嫁",
  じいじ: "じいじ|じぃじ|じーじ|おじいちゃん|祖父|お義父さん|義父",
  ばあば: "ばあば|ばぁば|ばーば|おばあちゃん|祖母|お義母さん|義母",
};

/**
 * 家族以外の人が迎えに行く。ファミサポに頼んだ日は、家族に「行ける人？」と聞かない。
 * 学童・延長保育は「場所」で、あとで家族が迎えに行くので入れない（11/5 の見直し：「学童のお迎えはばあば」が「家族は行かない」になった）
 */
const HELPER = /ファミサポ|ファミリーサポート|ファミリー・サポート|シッター|ママ友|お友達|友だち|友達/;

/** 決まった報告：その日の送り／迎えを、だれがするか（家族以外・なしも） */
export interface Assignment {
  date: string;
  kind: "送り" | "迎え";
  /** 書いてあった時刻。無ければ null（今の枠の時刻のまま） */
  time: string | null;
  who: Adult | null;
  /** 家族以外の担当（ファミサポなど）か、なしのわけ（お休み）。who と同時には入らない */
  note: string | null;
}

/**
 * 「5時迎え」は 17:00。お迎えで 1〜7時は午後とみなす（「朝」「午前」と書いてあれば別）。
 * 「11時」「10時半」の早いお迎えはそのまま。「1時間」は時刻ではない（11/5 の見直し：11時が 23:00 になった）
 */
function parseTime(line: string, kind: "送り" | "迎え"): string | null {
  const m = /(\d{1,2})(?::(\d{2})|時(?!間)(半|(\d{1,2})分)?)/.exec(line);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ?? (m[3] === "半" ? "30" : (m[4] ?? "0"));
  if (h >= 24 || Number(min) >= 60) return null;
  if (kind === "迎え" && h >= 1 && h <= 7 && !/朝|午前/.test(line)) h += 12;
  return `${String(h).padStart(2, "0")}:${min.padStart(2, "0")}`;
}

/**
 * 家族の「決まった」という報告を読む。頼み・断り・問いかけは読まない（別の道へ）。
 *  「明日5時迎えばーばになりました」→ 明日 17:00 迎え ばあば
 *  「28日土曜お迎え パパ」→ 28日 迎え パパ（行の終わりが家族の呼び名なら報告とみなす）
 *  「5日、保育所3人はファミサポにお迎え頼みました」→ 5日 迎え ファミサポ（家族は行かない）
 *  「16日は全員お休みだからお迎えなし」→ 16日 送り・迎え どちらもなし（お休み）
 * 日の言葉が無ければ読まない（いつのことか決めつけない）。ただし少し前に報告があった日（recentDate）の
 * 続き「ファミサポは18:30迎えです」は、その日のこととして読む。合わなければ null
 */
export function parseAssignment(text: string, today: string, recentDate?: string | null): Assignment[] | null {
  const t = toHalfWidth(text).trim();
  // 頼み・問いかけ・断り・迷い・連絡文の頼みは別の道（名前ボタン・聞き直し・休みの連絡）
  // 11/5 の見直しで足した：「行けなくなりました」「ばあばにお願いします」「パパですか」「パパでいいかな」「パパかも」
  if (
    /[?？]|頼んで|たのんで|頼んど|たのんど|頼める|頼みたい|お願いして|お願いしと|お願いでき|にお願いします|にお願いしたい|聞いと|きいと|依頼して|聞いて|きいて|行ける|いける|行けない|いけない|行けなく|いけなく|行けません|いけません|来られな|来れな|できな|できません|だれか|誰か|だれが|誰が|どうする|どうしよう|どっち|どちらが|難しい|むずかしい|無理|むり|ダメ|だめ|都合が悪|連絡文|ですか|ますか|でしょうか|かも|たぶん|多分|未定|決まってない|決まっていない/.test(t) ||
    /(かな|かしら)[ー〜!！。\s　]*($|\n)/.test(t)
  ) {
    return null;
  }
  // いつのことか：その話をしている文の中の日付 → 全体の日付 → 少し前の報告の日
  // （「5日のことは言っていません。16日を全員休み」の 16日 を取る）
  const sentences = t.split(/[。\n]/).filter((x) => x.trim());
  // その話の言葉（at）の一番近く前にある日付。無ければ後ろ、文全体、少し前の報告の日
  // （「きょうのかれんだーにいれて 16日は全員お休み」の 16日 を取る。parseDay は「今日」を先に見るので、日付の言葉だけを渡す）
  // 「28日土曜」「11/5(木)」は日付と曜日をひとまとまりに（「土曜」だけを読んで別の週にしない）
  const WD = "(?:[（(]?[月火水木金土日](?:曜日?)?[)）]?)?";
  const DAY = new RegExp(
    `\\d{1,2}[/月]\\d{1,2}日?${WD}|\\d{1,2}日${WD}|(来週の?)?[月火水木金土日]曜|今日|きょう|一昨日|おととい|昨日|きのう|明後日|あさって|明日|あした`,
    "g",
  );
  const dayNear = (part: string, at: number, past = false) => {
    const found = [...part.matchAll(DAY)];
    const pick = found.filter((m) => (m.index ?? 0) <= at).pop() ?? found[0];
    return pick ? parseDay(pick[0], today, { past }) : null;
  };
  const dayOf = (part: string, at = part.length, past = false) =>
    dayNear(part, at, past) ?? dayNear(t, t.length, past) ?? recentDate ?? null;

  // 全員お休み：その日は送りも迎えも要らない。「全員」のすぐあとの「休み」だけ（11/5 の見直し：
  // 「みんなおやすみ」のあいさつ・「そうた休み、みんなごめんね」で、その日の送り迎えが消えた）
  const allOff = /(全員|みんな|\d人とも|きょうだい)[^。\n、]{0,4}(休み|欠席)/;
  const offPart = sentences.find((x) => allOff.test(x));
  if (offPart) {
    const date = dayOf(offPart, allOff.exec(offPart)?.index ?? offPart.length);
    if (!date) return null;
    return (["送り", "迎え"] as const).map((kind) => ({ date, kind, time: null, who: null, note: "お休み" }));
  }
  const noneRe = /(お迎え|迎え|送り)は?[\s　、]*(なし|無し|いらない|要らない|不要|なくなり|無くなり)/;
  const nonePart = sentences.find((x) => noneRe.test(x));
  if (nonePart) {
    const none = noneRe.exec(nonePart)!;
    const date = dayOf(nonePart, none.index);
    if (!date) return null;
    const note = /休み|欠席/.test(t) ? "お休み" : "なし";
    // 「送り迎えなし」は両方
    const kinds: ("送り" | "迎え")[] = /送り迎え|送迎|送りも迎えも/.test(nonePart) ? ["送り", "迎え"] : [/迎え/.test(none[1]) ? "迎え" : "送り"];
    return kinds.map((kind) => ({ date, kind, time: null, who: null, note }));
  }

  // 報告の言い方か。行の終わりが呼び名（「お迎え パパ」）でもよい
  const said = /になりました|になった|になります|に決ま|で決ま|決まりました|です|でーす|だよ|入れて|いれて|行きます|いきます|行く|いく|やります|担当|頼みました|頼んだ|たのんだ|お願いしました|お願いした|依頼しました|依頼した|します|行ってくれ|が行|がお迎え|が送り/.test(t);
  // 「ばあばではなくママ」「パパの代わりにばあば」：打ち消された方は数えない（11/5：2人の名前が並んで読めず、黙った）
  const people = `${Object.values(ROLE_WORDS).join("|")}|${HELPER.source}`;
  const notThis = new RegExp(`(${people})(さん|ちゃん)?((では|じゃ)なく(て)?|の(代わり|かわり)に?)`, "g");

  // 送り／迎えの言葉がある文ごとに、だれが・何時かを読む
  // （11/5：「4日のお迎えはママでした。5日はファミサポさんに…」の2つ目を読み落とした）
  const found = new Map<string, Assignment>();
  for (const raw of t.split(/[\n。]/).filter((l) => /迎え|むかえ|送り|おくり/.test(l) && !/おくりもの|贈り/.test(l))) {
    const line = raw.replace(notThis, "");
    // 「送り迎えはばあば」は両方（11/5 の見直し：迎えだけになった）
    const kinds: ("送り" | "迎え")[] = /送り迎え|送迎|送りも迎えも/.test(line) ? ["送り", "迎え"] : [/迎え|むかえ/.test(line) ? "迎え" : "送り"];
    const helper = HELPER.exec(line)?.[0] ?? null;
    // 「祖父」「義母」の「父」「母」を パパ・ママ と読まない
    const withoutGrand = line.replace(/祖父|祖母|義父|義母/g, "");
    const roles = ADULTS.filter((a) => new RegExp(ROLE_WORDS[a]).test(a === "パパ" || a === "ママ" ? withoutGrand : line));
    // 2人の名前が並ぶ文（「パパ、ママ遅番」）は決めつけない
    const who = helper ? null : roles.length === 1 ? roles[0] : null;
    if (!helper && !who) continue;

    const tail = line.replace(/[\s　。、！!]+$/, "");
    const name = helper ?? (who ? ROLE_WORDS[who] : "$^");
    const endsWithName = new RegExp(`(${name})(さん|ちゃん)?$`).test(tail);
    // 「お迎え パパ」「送り：ばあば」のように、送り／迎えのすぐあとに名前（行の途中でも）
    // 名前のあとは区切りか行の終わり（「送りパパが寝坊しないか心配」は報告ではない）。「パパでした」「パパだった」も
    const kindThenName = new RegExp(`(迎え|送り)(は|を)?[\\s　、:：]*(${name})(さん|ちゃん)?([\\s　、。！!]|で|です|だ|$)`).test(line);
    if (!said && !endsWithName && !kindThenName) continue;

    // 済んだ話（「でした」「行った」）なら、過ぎた日を来月にしない。「ばあばになりました」はこれからの話
    const past = /でした|だった|行きました|いきました|行った|いった|行ってくれた|迎えた|送った|送りました|やりました/.test(line) && !/になりました|決まりました/.test(line);
    const at = line.search(/迎え|むかえ|送り|おくり/);
    // 「来週から」「毎週」のように、この文が別の日のことなら、ほかの文や少し前の報告の日を当てはめない
    if (!dayNear(line, at, past) && /再来週|来週|来月|毎週|毎日|いつも|ずっと|今後|これから/.test(line)) continue;
    const date = dayOf(line, at, past);
    if (!date) continue;
    for (const kind of kinds) found.set(`${date}|${kind}`, { date, kind, time: parseTime(line, kind), who, note: helper });
  }
  return found.size > 0 ? [...found.values()] : null;
}

/** 枠の説明文「明日 17:30、保育所3人のお迎え」のような短い1行 */
export function describeSlot(slot: Slot, today: string, withTime = true): string {
  const rel = slot.date === today ? "今日" : slot.date === addDays(today, 1) ? "明日" : shortDate(slot.date);
  return `${rel}${withTime ? ` ${slot.time}` : ""}、${whose(slot)}の${kindWord(slot.kind)}`;
}

/** 「11/16（月）」。家族への1行で使う */
export function dayLabel(date: string, today: string): string {
  return date === today ? "今日" : date === addDays(today, 1) ? "明日" : shortDate(date);
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
