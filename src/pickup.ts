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
    action: { type: "message", label: name as string, text: `${word}引受 #${slot.id} ${name}` },
  }));
  // 家族以外（ファミサポなど）に頼んだ日も、押すだけで「もう聞かない」にできる（11/5 パパ「その他の項目も作って ファミサポとかもあるらしい」）
  buttons.push({
    type: "button",
    style: "secondary",
    height: "sm",
    action: { type: "message", label: "ファミサポなど", text: `${word}引受 #${slot.id} ほか` },
  });
  // 縦に長いと前のやり取りが隠れる。小さめの1枚に、ボタンは横並び（2つずつ）
  const rows = [buttons.slice(0, 2), buttons.slice(2, 4), buttons.slice(4)].filter((r) => r.length > 0);
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

/** 「お迎え引受 #12 ばあば」のような発言を解く。「ほか」はファミサポなど家族以外。合わなければ null */
export function parseAccept(text: string): { slotId: number; who: Adult | "ほか" } | null {
  const m = /^(?:お迎え|送り)引受\s*#(\d+)\s+(パパ|ママ|じいじ|ばあば|ほか)$/.exec(text.trim());
  if (!m) return null;
  return { slotId: Number(m[1]), who: m[2] as Adult | "ほか" };
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

/**
 * 確定の知らせ＋園の連絡アプリに貼る文を1枚に。コピーは clipboard action、古い端末向けに本文にも同じ文を出す。
 * ありがとうは LINE の長押しのリアクションで（吹き出しを足さない。11/6 佐藤「引き受けたあと2通来てタイムラインが荒れる」）
 */
export function confirmMessages(slot: Slot, who: Adult, when?: string): OutMessage[] {
  const notice = noticeText(slot, who);
  const flex: FlexMessage = {
    type: "flex",
    altText: `${who}に決まりました。${slot.place}への連絡文：${notice}`,
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: `✅ ${who}に決まりました。ありがとう。`, weight: "bold", size: "md", wrap: true },
          ...(when ? [{ type: "text", text: when, size: "sm", color: "#666666", wrap: true }] : []),
          { type: "text", text: `${slot.place}への連絡文`, size: "sm", color: "#888888" },
          { type: "text", text: notice, wrap: true, size: "md" },
          { type: "text", text: "🙏 ありがとうは、この札を長押ししてリアクションで", size: "xs", color: "#888888", wrap: true },
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
  return [flex];
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

/**
 * 前の晩のお知らせ：担当の人に、明日の自分の送り迎えを1通で（送りとお迎えの両方なら1通にまとめる）。
 * 「パパ、明日 11/18（水）は 7:30 保育所3人の送り・17:30 保育所3人のお迎えです。よろしくお願いします。」
 */
export function reminderBundle(who: string, slots: Slot[], today: string): TextMessage {
  const sorted = [...slots].sort((a, b) => a.time.localeCompare(b.time));
  const day = sorted[0].date === addDays(today, 1) ? `明日 ${shortDate(sorted[0].date)}` : sorted[0].date === today ? "今日" : shortDate(sorted[0].date);
  const list = sorted.map((s) => `${s.time} ${whose(s)}の${kindWord(s.kind)}`).join("・");
  return { type: "text", text: `${who}、${day}は ${list}です。よろしくお願いします。` };
}

/** まだ決まっていない枠を、その日の昼に知らせる。だれにも振らない（勝手に決めない） */
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
  // ひらがなは、名前が来る所（文の頭・区切り・「は」「が」「も」のあと）で、すぐあとが助詞か区切りのときだけ（11/5 夜の見直し）
  パパ: "パパ|(?<=^|[\\s　、。:：]|[はがも](?<!わが|すが))ぱぱ(?=さん|ちゃん|が|は|も|に|へ|で|だ|[\\s　、。！!]|$)|お父さん|おとうさん|父|(?<![丈工])夫|旦那",
  ママ: "ママ(?!友)|(?<=^|[\\s　、。:：]|[はがも](?<!わが|すが))まま(?=さん|ちゃん|が|は|も|に|へ|で|だ|[\\s　、。！!]|$)|お母さん|おかあさん|母|妻|嫁",
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

/** 決まった報告ではない言い方（頼み・問いかけ・断り・連絡文の頼み）。発言のどこにあっても報告として読まない。まとめての頼み（parseBulk）も同じものを使う */
export const NOT_A_REPORT = /[?？]|頼んで|たのんで|頼んど|たのんど|頼める|頼みたい|お願いして|お願いしと|お願いでき|(?<!(?:ファミサポ|ファミリーサポート|ファミリー・サポート|シッター|ママ友|お友達|友だち|友達)(?:さん)?)にお願いします|にお願いしたい|聞いと|きいと|依頼して|聞いて|きいて|行ける|いける|行けない|いけない|行けなく|いけなく|行けません|いけません|行かない|いかない|行かれない|行きません|いきません|送りません|迎えません|来られな|来れな|できな|できません|送れな|迎えられな|間に合わ|抜けられ|休めな|だれか|誰か|だれが|誰が|どうする|どうしよう|どうやって|どっち|どちらが|難しい|むずかしい|厳し|無理|むり|ダメ|だめ|都合が悪|連絡文|じゃない|ではない/;

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
  if (kind === "迎え" && h >= 1 && h <= 9 && !/朝|午前/.test(line)) h += 12;
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
  // 頼み・問いかけ・断り・連絡文の頼みは別の道（名前ボタン・聞き直し・休みの連絡）。発言のどこにあっても止める
  // 11/5 の見直しで足した：「行けなくなりました」「ばあばにお願いします」。ファミサポなど家族以外に「お願いします」は頼んだ報告
  if (NOT_A_REPORT.test(t)) {
    return null;
  }
  // 迷い・問い（「かも」「たぶん」「未定」「ですか」「かな」）は、その文だけ止める。
  // 発言全体で止めると「明日のお迎えはパパです。少し遅れるかも」まで消えた（11/5 夜の見直し）
  const unsure = (s: string) =>
    /心配|ですか|ますか|でしょうか|(?<!(?:^|[、\s　])し)かも(?!め)|たぶん|多分|未定|決まってない|決まっていない/.test(s) ||
    /(かな|かしら)[ー〜!！\s　]*$/.test(s);
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
  const allOff = /(全員|みんな|\d人とも|きょうだい)[^。\n]{0,8}(休み|欠席)/;
  const offPart = sentences.find((x) => allOff.test(x));
  if (offPart) {
    if (unsure(offPart)) return null;
    const date = dayOf(offPart, allOff.exec(offPart)?.index ?? offPart.length);
    if (!date) return null;
    return (["送り", "迎え"] as const).map((kind) => ({ date, kind, time: null, who: null, note: "お休み" }));
  }
  const noneRe = /(お迎え|迎え|送り)は?[\s　、]*(なし|無し|いらない|要らない|不要|なくなり|無くなり)/;
  const nonePart = sentences.find((x) => noneRe.test(x));
  if (nonePart) {
    if (unsure(nonePart)) return null;
    const none = noneRe.exec(nonePart)!;
    const date = dayOf(nonePart, none.index);
    if (!date) return null;
    const note = /休み|欠席/.test(t) ? "お休み" : "なし";
    // 「送り迎えなし」は両方
    const kinds: ("送り" | "迎え")[] = /送り迎え|送迎|送りも迎えも/.test(nonePart) ? ["送り", "迎え"] : [/迎え/.test(none[1]) ? "迎え" : "送り"];
    return kinds.map((kind) => ({ date, kind, time: null, who: null, note }));
  }

  // 報告の言い方か（文ごとに見る）。「です」「だよ」は、名前か送り迎えの言葉のすぐあとのときだけ（下の copula）。
  // 文全体のどこかの「です」で報告にすると、「ママは出張です」「パパは残業です」がその人のお迎えになった（11/5 の見直し）
  const SAID = /になりました|になった|になります|に決ま|で決ま|決まりました|入れて|いれて|行きます|いきます|行く|いく|やります|担当|頼みました|頼んだ|たのんだ|お願いしました|お願いした|依頼しました|依頼した|します|行ってくれ|が行|がお迎え|が送り/;
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
    // 名前のあとは区切りか行の終わり（「送りパパが寝坊しないか心配」は報告ではない）。「パパでした」「パパだった」も。
    // 「パパだと思う」「パパだっけ」「パパだったら」は読まない（11/5 夜の見直し）
    const kindThenName = new RegExp(`(迎え|送り)(は|を)?[\\s　、:：]*(${name})(さん|ちゃん)?([\\s　、。！!]|で|です|だった(?!ら|っけ)|$)`).test(line);
    // 「ばあばです」「お迎えです」「お迎えは18:30です」：名前か送り迎えの言葉のすぐあとの「です」
    const copula = new RegExp(
      `(${name}|迎え|むかえ|送り|おくり)(さん|ちゃん)?(は|が)?[\\s　]*(\\d{1,2}(:\\d{2}|時半?|時\\d{1,2}分)?)?[\\s　]*(です|でーす|だよ)`,
    ).test(line);
    // ファミサポなど家族以外の人と送り迎えが同じ文にあれば、頼んだ報告（「ファミサポさんに一度お迎えした後は…」）
    const helperDid = helper !== null && /迎え|むかえ|送り|おくり/.test(line);
    if (!SAID.test(line) && !copula && !endsWithName && !kindThenName && !helperDid) continue;
    if (unsure(line)) continue;

    // 済んだ話（文の終わりが「でした」「行った」）なら、過ぎた日を来月にしない。「ばあばになりました」はこれからの話。
    // 文の途中の「いったん」「予定だった」「行った後」で、これからの報告を前の週にしていた（11/5 夜の見直し）
    const past =
      /(でした|だった|行きました|いきました|行った|いった|行ってくれた|迎えた|送った|送りました|やりました)(よ|ね|よね|わ)?[\s　!！、…〜ー]*$/.test(line) &&
      !/になりました|決まりました/.test(line);
    const at = line.search(/迎え|むかえ|送り|おくり/);
    // 「来週から」「毎週」のように、この文が別の日のことなら、ほかの文や少し前の報告の日を当てはめない
    if (!dayNear(line, at, past) && /再来週|来週|来月|毎週|毎日|いつも|ずっと|今後|これから/.test(line)) continue;
    const date = dayOf(line, at, past);
    if (!date) continue;
    for (const kind of kinds) {
      const key = `${date}|${kind}`;
      const prev = found.get(key);
      // 同じ枠に別の人が出たら決めつけない（「明日のお迎えはばあば。パパがお迎えだと思ってた」：11/5 夜の見直し）
      if (prev && (prev.who !== who || prev.note !== helper)) return null;
      // 「送り迎え」の時刻は迎えのもの。朝の送りの枠は今の時刻のまま（17:30 の送りにしない）
      found.set(key, { date, kind, time: kinds.length > 1 && kind === "送り" ? null : parseTime(line, kind), who, note: helper });
    }
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

// ── まとめての頼み（11/17 佐藤「まとめての依頼をグループで連絡した時に対応できるように」） ──
// 「来週の月水金のお迎えはばあば、火木はパパ」「18日〜22日の送りはパパ」「毎週水曜のお迎えはばあば」
// 「来週のお迎え、行ける人いる？」を、何日ぶんかまとめて読む。1日だけの話は parseAssignment（ここでは読まない）。
// 分からない所が1つでもあれば何も入れない（全部読めたときだけ。読み違いで決めつけない）

/** その週の月曜（today を含む週を 0、来週を 1） */
function mondayOfWeek(today: string, offset: number) {
  return addDays(today, -((weekdayOf(today) + 6) % 7) + 7 * offset);
}

function weekdayOf(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

const WEEK_WORD: Record<string, number> = { 今週: 0, 来週: 1, 再来週: 2 };
const D = "\\d{1,2}[/月]\\d{1,2}日?|\\d{1,2}日";
/** 日付のすぐあとの曜日（「28日土曜」「11/5(木)」）。日付とひとまとまりに読む */
const WDS = "(?:[（(][月火水木金土日][)）]|[月火水木金土日]曜日?)?";
const SEP = "(?:〜|～|~|－|-|から)";
const Q = "(?:(今週|来週|再来週|毎週)の?)?";
/** 「明日」「今日」「毎日」「休日」の「日」を日曜と読まない（「明日水曜のお迎え」が明日と日曜の2日になった：11/17 の見直し） */
const NB = "(?<![\\d今明昨後毎平休祝本翌前])";
const REL = "今日|きょう|明後日|あさって|明日|あした";
const SPEC = new RegExp(
  [
    `(?<range>(?:${D}|\\d{1,2})${WDS}\\s*${SEP}\\s*(?:${D})${WDS}(?:まで)?)`,
    `(?<list>\\d{1,2}日?${WDS}(?:\\s*[・、,，と]\\s*\\d{1,2}日?${WDS})+)`,
    `(?<date>(?:${D})${WDS})`,
    // 「明日と明後日」のように並んだときだけ（「きょうのカレンダーに入れて 16日は…」の「きょう」を日付にしない：11/4 の言い方）
    `(?<rel>(?:${REL})(?:\\s*[と・、,，]\\s*(?:${REL}))+)`,
    `(?<wdrange>${Q}${NB}[月火水木金土日]曜?日?\\s*${SEP}\\s*[月火水木金土日]曜?日?(?:まで)?)`,
    `(?<wdset>${Q}${NB}(?:[月火水木金土日](?:曜日?)?\\s*[・、,，と]?\\s*){2,})`,
    `(?<wd>${Q}${NB}[月火水木金土日]曜日?)`,
    `(?<week>今週|来週|再来週)`,
  ].join("|"),
  "g",
);

interface DaySpec {
  index: number;
  end: number;
  /** 日付で決まるもの（range・list・date・rel） */
  dates?: string[];
  /** 曜日で決まるもの。週は自分の言葉（「来週の月水金」）か、前の言葉から */
  weekdays?: number[];
  qualifier?: string;
  /** 「来週」だけ（あとに曜日が無ければ、その週の月〜金） */
  week?: string;
}

/** 曜日の番号（日=0）を日付に。毎週なら4週ぶん。週の言葉が無ければ、今日から数えて次のその曜日（今日を含む） */
function datesOfWeekdays(weekdays: number[], qualifier: string | undefined, today: string): string[] {
  const out: string[] = [];
  for (const w of weekdays) {
    if (qualifier === "毎週") {
      const first = addDays(today, (w - weekdayOf(today) + 7) % 7);
      for (let k = 0; k < 4; k++) out.push(addDays(first, 7 * k));
    } else if (qualifier && qualifier in WEEK_WORD) {
      out.push(addDays(mondayOfWeek(today, WEEK_WORD[qualifier]), (w + 6) % 7));
    } else {
      out.push(addDays(today, (w - weekdayOf(today) + 7) % 7));
    }
  }
  return out;
}

/** その週の平日（今週なら今日から） */
function weekdaysOfWeek(word: string, today: string): string[] {
  const monday = mondayOfWeek(today, WEEK_WORD[word]);
  return [0, 1, 2, 3, 4].map((n) => addDays(monday, n)).filter((d) => d >= today);
}

function scanDays(line: string, today: string): DaySpec[] | null {
  const specs: DaySpec[] = [];
  for (const m of line.matchAll(SPEC)) {
    const g = m.groups ?? {};
    const index = m.index ?? 0;
    const end = index + m[0].length;
    if (g.range) {
      const [a, b] = g.range.split(new RegExp(SEP));
      const month = /(\d{1,2})[/月]/.exec(a)?.[1];
      const start = parseDay(/日|[/月]/.test(a) ? a : `${a}日`, today);
      const endWord = /[/月]/.test(b) || !month ? b : `${month}/${/(\d{1,2})日/.exec(b)?.[1] ?? b}`;
      const last = parseDay(endWord, today);
      if (!start || !last || last < start) return null;
      const dates: string[] = [];
      // 範囲の日付は平日だけ（「18日〜22日のお迎え」に土日の保育所の枠を作らない）。長すぎる範囲は読まない
      for (let d = start; d <= last && dates.length < 31; d = addDays(d, 1)) if (weekdayOf(d) !== 0 && weekdayOf(d) !== 6) dates.push(d);
      specs.push({ index, end, dates });
    } else if (g.list) {
      if (!g.list.includes("日")) continue;
      const month = /(\d{1,2})[/月]/.exec(line.slice(Math.max(0, index - 3), index))?.[1];
      const nums = [...g.list.matchAll(/(\d{1,2})日?/g)].map((x) => x[1]);
      const dates = nums.map((n) => parseDay(month ? `${month}/${n}` : `${n}日`, today)).filter((d): d is string => d !== null);
      specs.push({ index, end, dates });
    } else if (g.date) {
      const d = parseDay(g.date.replace(/[（(][月火水木金土日][)）]|[月火水木金土日]曜日?$/, ""), today);
      if (d) specs.push({ index, end, dates: [d] });
    } else if (g.rel) {
      const dates = g.rel.split(/\s*[と・、,，]\s*/).map((w) => parseDay(w, today)).filter((d): d is string => d !== null);
      specs.push({ index, end, dates });
    } else if (g.wdrange || g.wdset || g.wd) {
      const raw = g.wdrange ?? g.wdset ?? g.wd;
      const qualifier = /^(今週|来週|再来週|毎週)/.exec(raw)?.[1];
      // 「曜日」の「日」を日曜と読まない
      const chars = [...raw.replace(/^(今週|来週|再来週|毎週)の?/, "").replace(/曜日?/g, "").matchAll(/[月火水木金土日]/g)].map((x) => WEEKDAY.indexOf(x[0]));
      let weekdays = [...new Set(chars)];
      if (g.wdrange) {
        // 「月〜金」：月曜はじまりで並べて、その間を全部
        const [a, b] = [chars[0], chars[chars.length - 1]].map((w) => (w + 6) % 7);
        weekdays = [];
        for (let w = a; w <= b; w++) weekdays.push((w + 1) % 7);
      }
      if (weekdays.length > 0) specs.push({ index, end, weekdays, qualifier });
    } else if (g.week) {
      specs.push({ index, end, week: g.week });
    }
  }
  // 「18日から来週の金曜まで」のような、日付と曜日をまたぐ範囲は読まない（2日だけになる）
  for (let i = 1; i < specs.length; i++) {
    if (new RegExp(`^\\s*${SEP}`).test(line.slice(specs[i - 1].end, specs[i].index))) return null;
  }
  return specs;
}

/** 打ち消された人（「ばあばじゃなくてパパ」「ばあば以外」）は担当と読まない */
const NOT_THIS = new RegExp(
  `(${Object.values(ROLE_WORDS).join("|")}|${HELPER.source})(さん|ちゃん)?((では|じゃ)なく(て)?|の(代わり|かわり)に?|以外(で|に|の|は)?)`,
  "g",
);
/** 報告の言い方（parseAssignment の SAID と同じ） */
const REPORT_WORDS = /になりました|になった|になります|に決ま|で決ま|決まりました|入れて|いれて|行きます|いきます|行く|いく|やります|担当|頼みました|頼んだ|たのんだ|お願いしました|お願いした|依頼しました|依頼した|します|行ってくれ|が行|がお迎え|が送り/;

/**
 * その区切りの担当（家族の呼び名・家族以外（ファミサポ）・なし）。担当として言い切っているときだけ：
 * 名前のあとが「です」「お願い」「が」「は」か区切り・行の終わり、または報告の言い方がある。
 * 「パパは出張です」「ばあばは来られない」は担当にしない。2人以上なら決めつけない
 */
function personIn(text: string): { who: Adult | null; note: string | null } | null {
  const t = text.replace(NOT_THIS, "");
  // 送り迎えのすぐあとの「なし」、全員のすぐあとの「休み」だけ（「冬休みなので」「給食なし」を、送り迎えなしと読まない）
  if (/(全員|みんな|\d人とも|きょうだい)[^。\n]{0,8}(休み|欠席)/.test(t)) return { who: null, note: "お休み" };
  if (/(お迎え|迎え|送り|送迎|送り迎え)は?[\s　、]*(なし|無し|いらない|要らない|不要)/.test(t)) return { who: null, note: "なし" };
  const helper = HELPER.exec(t)?.[0] ?? null;
  const withoutGrand = t.replace(/祖父|祖母|義父|義母/g, "");
  const roles = ADULTS.filter((a) => new RegExp(ROLE_WORDS[a]).test(a === "パパ" || a === "ママ" ? withoutGrand : t));
  if ((helper ? 1 : 0) + roles.length !== 1) return null;
  const name = helper ?? ROLE_WORDS[roles[0]];
  const stated = new RegExp(
    `(${name})(さん|ちゃん)?(です|でーす|だよ|でお願いします|でお願い|お願いします|お願い|になりました|になります|に決まりました|が|は|で|に)?[\\s　、。！!]*$`,
  ).test(t.trim());
  if (!stated && !REPORT_WORDS.test(t)) return null;
  return helper ? { who: null, note: helper } : { who: roles[0], note: null };
}

function kindsIn(text: string): ("送り" | "迎え")[] | null {
  if (/送り迎え|送迎|送りも(お)?迎えも|(お)?迎えも送りも/.test(text)) return ["送り", "迎え"];
  if (/迎え|むかえ/.test(text)) return ["迎え"];
  if (/送り|おくり/.test(text) && !/おくりもの|贈り/.test(text)) return ["送り"];
  return null;
}

/** 日付の順、同じ日なら送り → 迎え */
function byDayKind(a: { date: string; kind: string }, b: { date: string; kind: string }) {
  return a.date.localeCompare(b.date) || (a.kind === b.kind ? 0 : a.kind === "送り" ? -1 : 1);
}

export type BulkRequest =
  | { mode: "assign"; list: Assignment[]; weekly: boolean }
  | { mode: "ask"; items: { date: string; kind: "送り" | "迎え"; time: string | null }[] };

/**
 * まとめての頼み。2日以上の話のときだけ読む（1日だけなら null → ふだんの読み方へ）。
 *  担当を言い切っている → mode "assign"（「月水金はばあば、火木はパパ」「ばあばが月水金、パパが火木」）
 *  「だれか」「行ける人」「行ける？」→ mode "ask"（担当は決めない）
 * 頼み・問い・断り・迷いがあれば担当を決めない。分からない区切りが1つでもあれば何も入れない。過ぎた日は入れない
 */
export function parseBulk(text: string, today: string): BulkRequest | null {
  const t = toHalfWidth(text).trim();
  if (/無理|むり|行けない|いけない|行けなく|行けません|できない|難しい|むずかし|厳し|ダメ|だめ|取り消|キャンセル/.test(t)) return null;
  // 済んだ話・お礼（「先週は月水金ばあばが行ってくれて助かった」）は、これからの担当にしない（11/17 の見直し）
  if (/先週|先月|昨日|きのう|一昨日|おととい|でした|だった|くれた|くれて|てくれ|助かっ|ありがと|お疲れ|おつかれ/.test(t)) return null;
  // 「ばあばに頼んで」は、その人に聞く話（名指し）。まとめては読まない
  if (/(に|へ)[\s　]*(頼んで|たのんで|頼んどいて|お願いして|お願いしといて|お願いします|お願いしたい|聞いて|きいて|依頼して|任せ|まかせ)/.test(t)) return null;
  // 「行ける人？」と聞いているときだけ札を出す（「何時だっけ？」のような問いは聞き取りにしない）
  const asking = /だれか|誰か|どなたか|行ける|いける|行けます|頼める|頼みたい|お願いできる|行ってくれる|いる[?？]|いますか|どう[?？]/.test(t);
  const blocked = asking || /[?？]/.test(t) || NOT_A_REPORT.test(t) || /かも|たぶん|多分|未定|かな[ー〜!！\s　]*$|出張|残業|仕事|用事|遅番|不在|いない/.test(t);

  const assigns = new Map<string, Assignment>();
  const asks = new Map<string, { date: string; kind: "送り" | "迎え"; time: string | null }>();
  let weekly = false;
  // 行をまたいで引き継ぐ：送り／迎え と、週の言葉（「来週のお迎え\n月水金はばあば\n火木はパパ」）
  let kinds: ("送り" | "迎え")[] | null = null;
  let carried: string | undefined;
  let anyDays = false;
  for (const line of t.split(/[\n。]/).map((l) => l.trim()).filter(Boolean)) {
    const specs = scanDays(line, today);
    if (specs === null) return null;
    kinds = kindsIn(line) ?? kinds;
    const dayed = specs.filter((s) => !s.week);
    const weekWords = specs.filter((s) => s.week && (dayed.length === 0 || s.index < dayed[0].index)).map((s) => s.week!);
    if (weekWords.length > 0) carried = weekWords[weekWords.length - 1];
    let parts: { spec: DaySpec | null; dates: string[] }[] = dayed.map((s) => {
      const qualifier = s.qualifier ?? carried;
      if (s.qualifier && s.qualifier !== "毎週") carried = s.qualifier;
      if (qualifier === "毎週") weekly = true;
      return { spec: s, dates: s.dates ?? datesOfWeekdays(s.weekdays ?? [], qualifier, today) };
    });
    const linePerson = personIn(line.replace(/(今週|来週|再来週)の?/g, ""));
    if (parts.length === 0) {
      // 「来週のお迎えはずっとばあば」「今週と来週の送り だれか」：週の言葉だけ → その週の平日。担当も問いも無ければ見出し（次の行へ引き継ぐ）
      if (weekWords.length === 0 || (!linePerson && !asking)) continue;
      parts = [{ spec: null, dates: weekWords.flatMap((w) => weekdaysOfWeek(w, today)) }];
    }
    anyDays = true;
    // 担当が日の前か後か：「ばあばが月水金、パパが火木」（前）／「月水金はばあば、火木はパパ」（後）
    const before = dayed.length > 0 ? personIn(line.slice(0, dayed[0].index)) : null;
    let pending: string[] = [];
    for (const [i, p] of parts.entries()) {
      const next = parts[i + 1]?.spec?.index ?? line.length;
      const after = p.spec ? line.slice(p.spec.end, next) : line;
      const prevEnd = i === 0 ? 0 : (parts[i - 1].spec?.end ?? 0);
      const lead = p.spec ? line.slice(prevEnd, p.spec.index) : "";
      const person = before && dayed.length > 1 ? personIn(lead) : (personIn(after) ?? (parts.length === 1 ? linePerson : null));
      const k = kindsIn(after) ?? kindsIn(lead) ?? kinds;
      const dates = [...pending, ...p.dates].filter((d) => d >= today);
      if (!k) return null;
      if (!person) {
        // 「18日、19日はばあば」：担当の無い日は、次に出てくる担当と同じ。最後まで担当が無ければ「行ける人？」の候補
        pending = dates;
        if (i === parts.length - 1) for (const date of dates) for (const kind of k) asks.set(`${date}|${kind}`, { date, kind, time: parseTime(after, kind) });
        continue;
      }
      pending = [];
      for (const date of dates) {
        for (const kind of k) {
          assigns.set(`${date}|${kind}`, { date, kind, time: k.length > 1 && kind === "送り" ? null : parseTime(after, kind), who: person.who, note: person.note });
        }
      }
    }
  }
  if (!anyDays) return null;
  const distinct = (keys: Iterable<string>) => new Set([...keys].map((key) => key.split("|")[0])).size;
  if (!blocked && assigns.size > 0 && asks.size === 0 && distinct(assigns.keys()) >= 2) {
    return { mode: "assign", list: [...assigns.values()].sort(byDayKind).slice(0, 20), weekly };
  }
  if (asking) {
    // 問いの文は、担当の名前が出ていても決めない（「ばあば行ける？」「ばあば以外で行ける人いる？」）。全部の日を聞く
    const all = new Map(asks);
    for (const [key, a] of assigns) all.set(key, { date: a.date, kind: a.kind, time: a.time });
    if (distinct(all.keys()) >= 2) return { mode: "ask", items: [...all.values()].sort(byDayKind).slice(0, 12) };
  }
  return null;
}
