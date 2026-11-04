// 家族の箱（Durable Object）が持つデータの形。画面・お知らせ・代行は全部これを読む

import type { Card } from "./card";

export type Adult = "パパ" | "ママ" | "じいじ" | "ばあば";
export const ADULTS: Adult[] = ["パパ", "ママ", "じいじ", "ばあば"];

/** 送迎の枠。1日の「送り」「迎え」が1つずつ */
export interface Slot {
  id: number;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  kind: "送り" | "迎え";
  place: string; // 保育所・小学校・習い事の名前（園名・学校名は書かない）
  children: string[]; // 呼び名
  who: Adult | null; // 担当。null は未定
  /** 不要＝家族は行かない（ファミサポに頼んだ・全員お休み）。聞き取りも念押しもしない */
  status: "未定" | "お願い中" | "決定" | "取消" | "不要";
  requestedBy?: "1対1" | "グループ" | "自動"; // だれがきっかけか。1対1なら名前は出さない
  /** 不要のわけ・家族以外の担当（「ファミサポ」「お休み」）。本名は入れない */
  note?: string;
}

/** 家族の動きの記録。経験値・称号・MVP・ありがとうは全部ここから計算する */
export interface FamilyEvent {
  id: number;
  at: number; // epoch ms
  kind: "引受" | "急な引受" | "ありがとう" | "提出" | "連絡文" | "取消";
  who: Adult; // 動いた人
  to?: Adult; // ありがとうの相手
  slotId?: number;
  note?: string; // 「雨の中、3人お迎え」のような短い場面。本名は入れない
}

export interface Weather {
  rain: boolean;
}

export type { Card };
