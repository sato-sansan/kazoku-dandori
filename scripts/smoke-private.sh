#!/usr/bin/env bash
# 手元の Worker に、署名つきの偽のイベントを送って「あとから入った人の @名指し」と「1対1の入口」を通す。
# smoke-flows.sh のあとに回す（名簿ができている前提）。LINE への返事は偽トークンなので 401 が出るのは想定どおり。
#   使い方: bash scripts/smoke-private.sh [http://localhost:8787]
set -eu
base="${1:-http://localhost:8787}"
secret="${LINE_CHANNEL_SECRET:-local-test-secret}"
n=100

post() { # $1=label $2=body
  n=$((n+1))
  local sig
  sig=$(printf '%s' "$2" | openssl dgst -sha256 -hmac "$secret" -binary | base64)
  printf '%-32s -> ' "$1"
  curl -s -o /dev/null -w '%{http_code}\n' -X POST "$base/line/webhook" \
    -H 'Content-Type: application/json' -H "x-line-signature: $sig" --data "$2"
  sleep "${3:-2}"
}

joined() { # $1=userId
  post "memberJoined $1" "$(printf '{"destination":"U0","events":[{"type":"memberJoined","webhookEventId":"evt-join-%s","replyToken":"rt-j%s","source":{"type":"group","groupId":"Cflow"},"joined":{"members":[{"type":"user","userId":"%s"}]}}]}' "$RANDOM" "$n" "$1")"
}

private() { # $1=userId $2=text
  post "1対1 $1: $2" "$(printf '{"destination":"U0","events":[{"type":"message","webhookEventId":"evt-pv-%s","replyToken":"rt-p%s","source":{"type":"user","userId":"%s"},"message":{"id":"pm%s","type":"text","text":"%s"}}]}' "$RANDOM" "$n" "$1" "$n" "$2")" "${3:-2}"
}

joined Ujiiji
private Unobody "お迎えを頼む"           # 名簿にいない → 「グループで名乗って」
private Upapa   "メニュー"
private Upapa   "お迎えを頼む"
private Upapa   "明日"
private Upapa   "17:00" 3                # → グループへ流す（push は 401）
private Upapa   "予定 見せて"
private Upapa   "お便りを送る"
private Upapa   "明後日17時のお迎え頼んでおいて" 3
private Upapa   "リッチメニュー 作り直し" 3
private Upapa   "こんにちは" 8           # 読み取り → 雑談 → 入口を出す
echo "done. 記録で handle failed / job failed が無いことを確認する"
