// 家族の情報。ここにあるのは架空の家族だけ。本物の呼び名は secret の FAMILY_PROFILE に入れる

export interface FamilyProfile {
  adults: string[];
  children: { name: string; grade: string; attends: string }[];
  /** 通い先の電話。休みの連絡を電話で伝える家のため。by は「何時までに」（例 "9:00"）。本物の番号は secret にだけ入れる */
  contacts?: Partial<Record<"保育所" | "小学校", { phone: string; by?: string }>>;
}

const SAMPLE_FAMILY: FamilyProfile = {
  adults: ["パパ", "ママ", "じいじ", "ばあば"],
  children: [
    { name: "はると", grade: "小学2年", attends: "小学校" },
    { name: "ゆい", grade: "5歳", attends: "保育所" },
    { name: "そうた", grade: "4歳", attends: "保育所" },
    { name: "めい", grade: "2歳", attends: "保育所" },
  ],
  // つながらない架空の番号。撮影でも本物の園には掛からない
  contacts: { 保育所: { phone: "00-0000-0000", by: "9:00" } },
};

export function loadProfile(raw?: string): FamilyProfile {
  return raw ? (JSON.parse(raw) as FamilyProfile) : SAMPLE_FAMILY;
}
