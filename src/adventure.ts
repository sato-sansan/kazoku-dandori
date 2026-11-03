// 家族の冒険。引受・ありがとうの記録（FamilyEvent）から経験値・称号・今週のファインプレーを出し、
// 日曜20:00のカードを組み立てる。全部純粋関数。順位は作らない（家族は1つのチーム）

import { withButtons, type FlexMessage, type TextMessage } from "./line";
import { ADULTS, type Adult, type FamilyEvent } from "./types";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
// 連続記録でさかのぼる上限。これより前は見ない
const STREAK_LOOKBACK_DAYS = 366;

/** 経験値。ありがとうは押した人 +2、受けた人 +5。取消は 0（引かない） */
const XP: Record<FamilyEvent["kind"], number> = {
  引受: 10,
  急な引受: 20,
  ありがとう: 2,
  提出: 5,
  連絡文: 5,
  取消: 0,
};
const XP_THANKS_RECEIVED = 5;

/** 家族レベル。累計 XP がしきい値に届いたら上がる。5段階 */
const LEVELS = [
  { name: "見習い", xp: 0 },
  { name: "一人前", xp: 80 },
  { name: "名人", xp: 240 },
  { name: "達人", xp: 520 },
  { name: "仙人", xp: 1000 },
] as const;

/** ファインプレーの「大変さ」。note に入っていたら1語1点 */
const HARD_WORDS = ["雨", "雪", "台風", "熱", "病院", "夜", "遅", "早朝", "朝早", "3人", "全員", "ひとりで", "みんな仕事", "残業"];

export interface AdventureStats {
  xp: number;
  level: number;
  levelName: string;
  nextLevelXp: number; // 次のレベルまでの残り。最高位なら 0
  thanks: number; // 今週のありがとうの数
  thanksDelta: number; // 先週との差
  streaks: { name: string; days: number }[];
  titles: { who: Adult; title: string; isNew: boolean }[];
  finePlay: { who: Adult; note: string } | null;
  weekLabel: string; // 「第1週」など
}

/** events 全体と「今週」の範囲（weekStart/weekEnd は epoch ms、weekEnd は含まない）から計算。先週との比較も events から */
export function computeAdventure(
  events: FamilyEvent[],
  weekStart: number,
  weekEnd: number,
  weekIndex: number,
): AdventureStats {
  const until = events.filter((e) => e.at < weekEnd);
  const thisWeek = until.filter((e) => e.at >= weekStart);
  const lastWeek = until.filter((e) => e.at >= weekStart - WEEK_MS && e.at < weekStart);

  const xp = until.reduce((sum, e) => sum + xpOf(e), 0);
  const level = levelOf(xp);
  const next = LEVELS[level]; // level は1始まりなので、これが次の段

  const thanks = thisWeek.filter((e) => e.kind === "ありがとう").length;
  const thanksLast = lastWeek.filter((e) => e.kind === "ありがとう").length;

  const previousTitles = titlesOf(lastWeek);
  const titles = titlesOf(thisWeek).map(({ who, title }) => ({
    who,
    title,
    isNew: !previousTitles.some((p) => p.who === who && p.title === title),
  }));

  return {
    xp,
    level,
    levelName: `段取り${LEVELS[level - 1].name}一家`,
    nextLevelXp: next ? next.xp - xp : 0,
    thanks,
    thanksDelta: thanks - thanksLast,
    // 取消があっても、だれかが引き受けた日なら家族としては段取りできた日。取消で途切れさせない
    streaks: [
      { name: "平日の引受つづき", days: weekdayStreak(until, weekEnd, isTake) },
      { name: "ありがとうつづき", days: weekdayStreak(until, weekEnd, (e) => e.kind === "ありがとう") },
    ],
    titles,
    finePlay: pickFinePlay(thisWeek),
    weekLabel: `第${weekIndex}週`,
  };
}

/** 1件の記録で家族に入る経験値（ありがとうは押した人と受けた人のぶんを合わせる） */
export function xpOf(event: FamilyEvent): number {
  const base = XP[event.kind] ?? 0;
  return event.kind === "ありがとう" && event.to ? base + XP_THANKS_RECEIVED : base;
}

function levelOf(xp: number) {
  let level = 1;
  for (let i = 1; i < LEVELS.length; i++) if (xp >= LEVELS[i].xp) level = i + 1;
  return level;
}

function isTake(e: FamilyEvent) {
  return e.kind === "引受" || e.kind === "急な引受";
}

function hasWord(e: FamilyEvent, word: string) {
  return (e.note ?? "").includes(word);
}

// ── 称号 ──────────────────────────────────────────────
// その人の今週の記録から、当てはまる称号と「最初にそうなった時刻」を返す。回数の多さで比べない

interface TitleRule {
  title: string;
  /** 当てはまる最初の記録の時刻。当てはまらなければ null */
  since: (own: FamilyEvent[]) => number | null;
}

const firstAt = (list: FamilyEvent[]) => (list.length ? Math.min(...list.map((e) => e.at)) : null);
const nthAt = (list: FamilyEvent[], n: number) =>
  list.length >= n ? [...list].sort((a, b) => a.at - b.at)[n - 1].at : null;

const TITLE_RULES: TitleRule[] = [
  { title: "雨の日の救世主", since: (own) => firstAt(own.filter((e) => isTake(e) && hasWord(e, "雨"))) },
  { title: "急な熱の守り神", since: (own) => firstAt(own.filter((e) => e.kind === "急な引受" && hasWord(e, "熱"))) },
  { title: "駆けつけ名人", since: (own) => firstAt(own.filter((e) => e.kind === "急な引受" && !hasWord(e, "熱"))) },
  // 朝の送りを週3回以上。記録に枠の種別がないので note の「送り」「朝」で見る
  { title: "朝の達人", since: (own) => nthAt(own.filter((e) => isTake(e) && (hasWord(e, "送り") || hasWord(e, "朝"))), 3) },
  { title: "ありがとう上手", since: (own) => nthAt(own.filter((e) => e.kind === "ありがとう"), 3) },
  { title: "連絡の達人", since: (own) => nthAt(own.filter((e) => e.kind === "連絡文" || e.kind === "提出"), 2) },
];

function titlesOf(weekEvents: FamilyEvent[]): { who: Adult; title: string; since: number }[] {
  const found: { who: Adult; title: string; since: number }[] = [];
  for (const who of ADULTS) {
    const own = weekEvents.filter((e) => e.who === who);
    for (const rule of TITLE_RULES) {
      const since = rule.since(own);
      if (since !== null) found.push({ who, title: rule.title, since });
    }
  }
  // 並びは「そうなった順」。人ごとの数では並べない
  return found.sort((a, b) => a.since - b.since);
}

// ── 今週のファインプレー ───────────────────────────────
// 回数ではなく、急だった・大変だった場面を1つ。文は note からそのまま使う

function pickFinePlay(weekEvents: FamilyEvent[]): AdventureStats["finePlay"] {
  let best: { e: FamilyEvent; score: number } | null = null;
  for (const e of weekEvents) {
    const note = (e.note ?? "").trim();
    if (!isTake(e) || !note) continue;
    const score = (e.kind === "急な引受" ? 3 : 0) + HARD_WORDS.filter((w) => note.includes(w)).length;
    // 同点なら後の場面（新しいほう）
    if (!best || score >= best.score) best = { e, score };
  }
  return best ? { who: best.e.who, note: best.e.note!.trim() } : null;
}

// ── 連続記録 ─────────────────────────────────────────
// 今週の最終日から平日だけをさかのぼり、「count の記録が1つ以上ある日」が何日続いたか。
// 土日は数えず、途切れもしない（送迎のない日だから）。祝日は見ていない

function weekdayStreak(events: FamilyEvent[], weekEnd: number, count: (e: FamilyEvent) => boolean): number {
  const countDays = new Set(events.filter(count).map((e) => jstDay(e.at)));
  let days = 0;
  for (let i = 0; i < STREAK_LOOKBACK_DAYS; i++) {
    const at = weekEnd - 1 - i * DAY_MS;
    if (isWeekend(at)) continue;
    if (!countDays.has(jstDay(at))) break;
    days++;
  }
  return days;
}

/** 日本時間の日付キー（YYYY-MM-DD）。Workers は UTC なので 9 時間ずらす */
function jstDay(ms: number) {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
}

function isWeekend(ms: number) {
  const dow = new Date(ms + JST_OFFSET_MS).getUTCDay();
  return dow === 0 || dow === 6;
}

function jstMonth(ms: number) {
  return new Date(ms + JST_OFFSET_MS).getUTCMonth() + 1;
}

// ── 週1枚のカード ─────────────────────────────────────

const COLOR = {
  header: "#2F6B4F",
  headerSub: "#D8EFE2",
  gaugeBg: "#E6E6E6",
  gauge: "#F2A93B",
  text: "#333333",
  sub: "#777777",
  accent: "#2F6B4F",
  badge: "#F2A93B",
};

/** 季節の絵文字を1つ。11月は🍁 */
export function seasonEmoji(month: number) {
  if (month >= 3 && month <= 5) return "🌸";
  if (month >= 6 && month <= 8) return "🌻";
  if (month >= 9 && month <= 11) return "🍁";
  return "⛄";
}

function text(value: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  // Flex の text は空だと弾かれる
  return { type: "text", text: value || "　", wrap: true, color: COLOR.text, size: "md", ...extra };
}

function label(value: string) {
  return text(value, { size: "xs", color: COLOR.sub });
}

const separator = () => ({ type: "separator", margin: "lg", color: "#EEEEEE" });

/** 画像を使わないゲージ。外の box の中に、幅を % にした box を置く */
function gauge(percent: number) {
  const width = `${Math.min(100, Math.max(2, Math.round(percent)))}%`;
  return {
    type: "box",
    layout: "vertical",
    backgroundColor: COLOR.gaugeBg,
    height: "10px",
    cornerRadius: "5px",
    margin: "sm",
    contents: [
      { type: "box", layout: "vertical", contents: [], width, height: "10px", backgroundColor: COLOR.gauge, cornerRadius: "5px" },
    ],
  };
}

/** 日曜20:00 のカード。now は季節の絵文字を選ぶためだけ（テストで固定できる） */
export function weeklyCard(stats: AdventureStats, reward?: string, now: number = Date.now()): FlexMessage {
  const emoji = seasonEmoji(jstMonth(now));
  const current = LEVELS[stats.level - 1].xp;
  const next = LEVELS[stats.level];
  const percent = next ? ((stats.xp - current) / (next.xp - current)) * 100 : 100;
  const levelLine = next
    ? `レベル${stats.level}　次まで あと${stats.nextLevelXp}`
    : `レベル${stats.level}　最高位です`;
  const thanksLine =
    stats.thanksDelta > 0
      ? `今週 ${stats.thanks}回（先週より +${stats.thanksDelta}）`
      : `今週 ${stats.thanks}回（先週 ${stats.thanks - stats.thanksDelta}回）`;

  const body: Record<string, unknown>[] = [
    label(`わが家の経験値 ${stats.xp}`),
    text(levelLine, { weight: "bold" }),
    gauge(percent),
    separator(),
    label("今週のファインプレー"),
    stats.finePlay
      ? text(`${stats.finePlay.who} ── ${stats.finePlay.note}`, { weight: "bold", color: COLOR.accent })
      : text("今週はみんなで段取りできました", { weight: "bold", color: COLOR.accent }),
    separator(),
    label("ありがとう"),
    text(thanksLine),
  ];

  // 称号は最大4つ。まず1人1つずつ（そうなった順）、空きがあれば残りを足す。数を比べる見せ方にしない
  const firstOfEach = stats.titles.filter((t, i) => stats.titles.findIndex((u) => u.who === t.who) === i);
  const rest = stats.titles.filter((t) => !firstOfEach.includes(t));
  const titles = [...firstOfEach, ...rest].slice(0, 4);
  if (titles.length) {
    body.push(separator(), label("称号"));
    for (const t of titles) {
      body.push({
        type: "box",
        layout: "horizontal",
        spacing: "sm",
        contents: [
          text(`🏅 ${t.who}　${t.title}`, { flex: 1 }),
          ...(t.isNew ? [text("NEW", { flex: 0, size: "xs", weight: "bold", color: COLOR.badge })] : []),
        ],
      });
    }
  }

  const streaks = stats.streaks.filter((s) => s.days >= 2);
  if (streaks.length) {
    body.push(separator(), label("つづいている記録"));
    for (const s of streaks) body.push(text(`${s.name} ${s.days}日`));
  }

  body.push(separator(), label("次のごほうび"), text(reward?.trim() || "家族で決めてね"));

  const altText = [
    `${emoji} わが家の冒険 ${stats.weekLabel}`,
    stats.levelName,
    stats.finePlay ? `ファインプレー：${stats.finePlay.who} ${stats.finePlay.note}` : "今週はみんなで段取りできました",
    `ありがとう ${stats.thanks}回`,
  ]
    .join("\n")
    .slice(0, 400);

  return {
    type: "flex",
    altText,
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: COLOR.header,
        paddingAll: "16px",
        contents: [
          text(`${emoji} わが家の冒険 ${stats.weekLabel}`, { size: "sm", color: COLOR.headerSub }),
          text(stats.levelName, { size: "xl", weight: "bold", color: "#FFFFFF" }),
        ],
      },
      body: { type: "box", layout: "vertical", spacing: "sm", paddingAll: "16px", contents: body },
    },
  };
}

// ── ありがとう ───────────────────────────────────────

/** 引受の直後に出す［ありがとう］。押した人以外に向けた短い文＋ボタン。
 *  呼ぶのは 引受・急な引受・提出・連絡文 のときだけ（ありがとう・取消には出さない）。
 *  押した人が event.who 本人なら、呼ぶ側で数えない */
export function thanksPrompt(event: FamilyEvent): TextMessage {
  const did: Record<FamilyEvent["kind"], string> = {
    引受: "引き受けてくれました",
    急な引受: "急なお願いを引き受けてくれました",
    提出: "提出してくれました",
    連絡文: "連絡文を送ってくれました",
    ありがとう: "ありがとうを送りました",
    取消: "予定を取り消しました",
  };
  const note = event.note?.trim();
  const line = `${event.who}が${did[event.kind]}${note ? `（${note}）` : ""}。`;
  return withButtons(`${line}\nほかのみんなは［ありがとう］をどうぞ`, [
    { label: "ありがとう", text: `ありがとう #${event.id}` },
  ]);
}

/** 「ありがとう #12」を解く。合わなければ null */
export function parseThanks(text: string): { eventId: number } | null {
  const m = /^ありがとう\s*#\s*(\d+)\s*$/u.exec(text.trim());
  return m ? { eventId: Number(m[1]) } : null;
}

/** 1行の経験値の知らせ（引受の直後に添える）。stats は加算後のもの */
export function xpLine(stats: AdventureStats, gained: number, who: Adult): string {
  const head = `+${gained} ${who} ありがとう！`;
  return stats.level < LEVELS.length
    ? `${head} 家族レベル${stats.level + 1}まで あと${stats.nextLevelXp}`
    : `${head} 家族レベルは最高位の${LEVELS[LEVELS.length - 1].name}`;
}

/* weeklyCard の Flex の例（架空の家族・第1週・ごほうび未設定・2026-11-01 20:00 JST に実行した出力。3,247 バイト）
{
  "type": "flex",
  "altText": "🍁 家族の冒険 第1週\n段取り一人前一家\nファインプレー：じいじ 熱で早お迎え\nありがとう 6回",
  "contents": {
    "type": "bubble",
    "size": "mega",
    "header": {
      "type": "box", "layout": "vertical", "backgroundColor": "#2F6B4F", "paddingAll": "16px",
      "contents": [
        { "type": "text", "text": "🍁 家族の冒険 第1週", "wrap": true, "color": "#D8EFE2", "size": "sm" },
        { "type": "text", "text": "段取り一人前一家", "wrap": true, "color": "#FFFFFF", "size": "xl", "weight": "bold" }
      ]
    },
    "body": {
      "type": "box", "layout": "vertical", "spacing": "sm", "paddingAll": "16px",
      "contents": [
        { "type": "text", "text": "家族の経験値 184", "wrap": true, "color": "#777777", "size": "xs" },
        { "type": "text", "text": "レベル2　次まで あと56", "wrap": true, "color": "#333333", "size": "md", "weight": "bold" },
        {
          "type": "box", "layout": "vertical", "backgroundColor": "#E6E6E6", "height": "10px", "cornerRadius": "5px", "margin": "sm",
          "contents": [
            { "type": "box", "layout": "vertical", "contents": [], "width": "65%", "height": "10px", "backgroundColor": "#F2A93B", "cornerRadius": "5px" }
          ]
        },
        { "type": "separator", "margin": "lg", "color": "#EEEEEE" },
        { "type": "text", "text": "今週のファインプレー", "wrap": true, "color": "#777777", "size": "xs" },
        { "type": "text", "text": "じいじ ── 熱で早お迎え", "wrap": true, "color": "#2F6B4F", "size": "md", "weight": "bold" },
        { "type": "separator", "margin": "lg", "color": "#EEEEEE" },
        { "type": "text", "text": "ありがとう", "wrap": true, "color": "#777777", "size": "xs" },
        { "type": "text", "text": "今週 6回（先週より +5）", "wrap": true, "color": "#333333", "size": "md" },
        { "type": "separator", "margin": "lg", "color": "#EEEEEE" },
        { "type": "text", "text": "称号", "wrap": true, "color": "#777777", "size": "xs" },
        {
          "type": "box", "layout": "horizontal", "spacing": "sm",
          "contents": [
            { "type": "text", "text": "🏅 じいじ　急な熱の守り神", "wrap": true, "color": "#333333", "size": "md", "flex": 1 },
            { "type": "text", "text": "NEW", "wrap": true, "color": "#F2A93B", "size": "xs", "flex": 0, "weight": "bold" }
          ]
        },
        {
          "type": "box", "layout": "horizontal", "spacing": "sm",
          "contents": [
            { "type": "text", "text": "🏅 パパ　朝の達人", "wrap": true, "color": "#333333", "size": "md", "flex": 1 }
          ]
        },
        {
          "type": "box", "layout": "horizontal", "spacing": "sm",
          "contents": [
            { "type": "text", "text": "🏅 ばあば　雨の日の救世主", "wrap": true, "color": "#333333", "size": "md", "flex": 1 },
            { "type": "text", "text": "NEW", "wrap": true, "color": "#F2A93B", "size": "xs", "flex": 0, "weight": "bold" }
          ]
        },
        {
          "type": "box", "layout": "horizontal", "spacing": "sm",
          "contents": [
            { "type": "text", "text": "🏅 ママ　連絡の達人", "wrap": true, "color": "#333333", "size": "md", "flex": 1 },
            { "type": "text", "text": "NEW", "wrap": true, "color": "#F2A93B", "size": "xs", "flex": 0, "weight": "bold" }
          ]
        },
        { "type": "separator", "margin": "lg", "color": "#EEEEEE" },
        { "type": "text", "text": "つづいている記録", "wrap": true, "color": "#777777", "size": "xs" },
        { "type": "text", "text": "平日の引受つづき 9日", "wrap": true, "color": "#333333", "size": "md" },
        { "type": "text", "text": "ありがとうつづき 4日", "wrap": true, "color": "#333333", "size": "md" },
        { "type": "separator", "margin": "lg", "color": "#EEEEEE" },
        { "type": "text", "text": "次のごほうび", "wrap": true, "color": "#777777", "size": "xs" },
        { "type": "text", "text": "家族で決めてね", "wrap": true, "color": "#333333", "size": "md" }
      ]
    }
  }
}
*/
