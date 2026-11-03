// 家族の情報。ここにあるのは架空の家族だけ。本物の呼び名は secret の FAMILY_PROFILE に入れる

export interface FamilyProfile {
  adults: string[];
  children: { name: string; grade: string; attends: string }[];
}

const SAMPLE_FAMILY: FamilyProfile = {
  adults: ["パパ", "ママ", "ジージ", "バーバ"],
  children: [
    { name: "はると", grade: "小学2年", attends: "小学校" },
    { name: "ゆい", grade: "5歳", attends: "保育所" },
    { name: "そうた", grade: "4歳", attends: "保育所" },
    { name: "めい", grade: "2歳", attends: "保育所" },
  ],
};

export function loadProfile(raw?: string): FamilyProfile {
  return raw ? (JSON.parse(raw) as FamilyProfile) : SAMPLE_FAMILY;
}
