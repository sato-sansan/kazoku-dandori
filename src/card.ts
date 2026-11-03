// 予定カード。画面・お知らせ・代行は全部これを読む

export type CardSource = "写真" | "メール" | "転送" | "ひとこと";

export interface Card {
  child: string;
  kind: "行事" | "提出" | "持ち物" | "集金" | "連絡" | "通院" | "習い事" | "欠席" | "送迎";
  title: string;
  date: string | null;
  time: string | null;
  place: string | null;
  deadline: string | null;
  items: string[];
  money: number | null;
  who_acts: "未定" | "パパ" | "ママ" | "ジージ" | "バーバ";
  confidence: "高" | "低";
  ask: string | null;
}

export interface ReadResult {
  is_notice: boolean;
  cards: Card[];
  summary: string[];
}

const nullableString = { type: ["string", "null"] };

/** Claude の出力をこの形に縛る（source はコード側で付ける） */
export const READ_RESULT_SCHEMA = {
  type: "object",
  properties: {
    is_notice: {
      type: "boolean",
      description: "予定や連絡、聞き返しへの答えなら true。家族の雑談など関係ない発言なら false",
    },
    cards: {
      type: "array",
      items: {
        type: "object",
        properties: {
          child: { type: "string", description: "家族が決めた呼び名。全員に関わるなら「全員」" },
          kind: {
            type: "string",
            enum: ["行事", "提出", "持ち物", "集金", "連絡", "通院", "習い事", "欠席", "送迎"],
          },
          title: { type: "string" },
          date: { ...nullableString, description: "YYYY-MM-DD。読めなければ null" },
          time: { ...nullableString, description: "HH:MM。読めなければ null" },
          place: { ...nullableString, description: "学校名・園名は書かず「小学校」「保育所」と書く" },
          deadline: { ...nullableString, description: "YYYY-MM-DD。書いていなければ null" },
          items: { type: "array", items: { type: "string" } },
          money: { type: ["integer", "null"], description: "円。書いていなければ null" },
          who_acts: { type: "string", enum: ["未定", "パパ", "ママ", "ジージ", "バーバ"] },
          confidence: { type: "string", enum: ["高", "低"] },
          ask: { ...nullableString, description: "分からないことを1つだけ。なければ null" },
        },
        required: [
          "child",
          "kind",
          "title",
          "date",
          "time",
          "place",
          "deadline",
          "items",
          "money",
          "who_acts",
          "confidence",
          "ask",
        ],
        additionalProperties: false,
      },
    },
    summary: {
      type: "array",
      items: { type: "string" },
      description: "家族に返す要約。子ども1人につき1行。期限が近いものを先に",
    },
  },
  required: ["is_notice", "cards", "summary"],
  additionalProperties: false,
};

/** 1回に聞くのは1つだけ。最初に見つかった聞き返しを返す */
export function firstQuestion(cards: Card[]) {
  return cards.find((card) => card.ask)?.ask ?? null;
}
