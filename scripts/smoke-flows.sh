#!/usr/bin/env bash
# 手元の Worker（wrangler dev）に、署名つきの偽の LINE イベントを順に送って、送迎・三通・冒険の流れを通す。
# LINE への返事は偽トークンなので失敗する（記録に「line reply failed 401」と出るのは想定どおり）。
# 見るのは「handle failed」「job failed」が出ないこと。
#   使い方: bash scripts/smoke-flows.sh [http://localhost:8787]
set -eu
base="${1:-http://localhost:8787}"
secret="${LINE_CHANNEL_SECRET:-local-test-secret}"
n=0

send() { # $1=userId $2=text（グループ）
  n=$((n+1))
  local body
  body=$(printf '{"destination":"U0","events":[{"type":"message","webhookEventId":"evt-flow-%s-%s","replyToken":"rt-%s","source":{"type":"group","groupId":"Cflow","userId":"%s"},"message":{"id":"m%s","type":"text","text":"%s"}}]}' "$n" "$RANDOM" "$n" "$1" "$n" "$2")
  local sig
  sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$secret" -binary | base64)
  printf '%-28s -> ' "$2"
  curl -s -o /dev/null -w '%{http_code}\n' -X POST "$base/line/webhook" \
    -H 'Content-Type: application/json' -H "x-line-signature: $sig" --data "$body"
  sleep "${3:-2}"
}

send Upapa  "わたしは パパ"
send Ubaaba "わたしは ばあば"
send Upapa  "段取り 明日" 4
send Ubaaba "お迎え引受 #1 ばあば" 3
send Upapa  "お迎え引受 #1 パパ" 2
send Upapa  "ありがとう #1" 2
send Ubaaba "今日は無理" 3
send Upapa  "段取り 冒険" 3
send Umama  "そうた 熱37.8 休み" 12
echo "done. 記録で handle failed / job failed が無いことを確認する"
