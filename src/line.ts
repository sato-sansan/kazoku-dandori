// LINE Messaging API の薄い窓口。メッセージの中身はログに出さない

const API = "https://api.line.me/v2/bot/message";
const DATA_API = "https://api-data.line.me/v2/bot/message";
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

export type ImageType = (typeof IMAGE_TYPES)[number];

export interface LineEvent {
  type: string;
  webhookEventId: string;
  replyToken?: string;
  source: { type: "user" | "group" | "room"; userId?: string; groupId?: string; roomId?: string };
  message?: { id: string; type: string; text?: string };
  unsend?: { messageId: string };
}

export interface OutMessage {
  type: "text";
  text: string;
  quickReply?: { items: QuickReplyItem[] };
}

interface QuickReplyItem {
  type: "action";
  action: { type: "message"; label: string; text: string };
}

export function withButtons(text: string, buttons: { label: string; text: string }[]): OutMessage {
  return {
    type: "text",
    text,
    quickReply: {
      items: buttons.map((b) => ({ type: "action", action: { type: "message", ...b } })),
    },
  };
}

/** 生の本文とヘッダの署名を照合する。crypto.subtle.verify は比較の時間で漏らさない */
export async function verifySignature(body: string, signature: string | null, secret: string) {
  if (!signature) return false;
  let expected: Uint8Array;
  try {
    expected = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, expected, encoder.encode(body));
}

async function post(path: string, token: string, payload: unknown) {
  return fetch(`${API}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

/** 返信（無料）。返信トークンが切れていたら false を返す */
export async function reply(token: string, replyToken: string, messages: OutMessage[]) {
  const res = await post("reply", token, { replyToken, messages });
  if (!res.ok) console.error("line reply failed", res.status);
  return res.ok;
}

/** プッシュ（通数を使う）。返信できなかったときと定時のお知らせだけ */
export async function push(token: string, to: string, messages: OutMessage[]) {
  const res = await post("push", token, { to, messages });
  if (!res.ok) throw new Error(`line push failed: ${res.status}`);
}

/** 画像を保存せずメモリにだけ取り出す。送信取消などで取れないときは null */
export async function fetchImage(token: string, messageId: string) {
  const res = await fetch(`${DATA_API}/${messageId}/content`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw new Error(`line content failed: ${res.status}`);
  const mediaType = (res.headers.get("Content-Type") ?? "").split(";")[0] as ImageType;
  if (!IMAGE_TYPES.includes(mediaType)) throw new Error(`unsupported image: ${mediaType}`);
  return { mediaType, data: toBase64(new Uint8Array(await res.arrayBuffer())) };
}

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
