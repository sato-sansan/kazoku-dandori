#!/usr/bin/env bash
# 手元の Worker（wrangler dev）に、署名つきの偽の LINE イベントを送って受け取りを確かめる。
# LINE にも Claude にもつながらない。キーも要らない。
#   使い方: bash scripts/smoke-webhook.sh [http://localhost:8787]
set -eu
base="${1:-http://localhost:8787}"
secret="${LINE_CHANNEL_SECRET:-local-test-secret}"

sign() { printf '%s' "$1" | openssl dgst -sha256 -hmac "$secret" -binary | base64; }

body='{"destination":"U0","events":[{"type":"message","webhookEventId":"evt-smoke-1","replyToken":"rt-smoke","source":{"type":"group","groupId":"Csmoke","userId":"Usmoke"},"message":{"id":"m1","type":"text","text":"テスト"}}]}'

echo "1) 署名なし → 401 のはず"
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$base/line/webhook" -H 'Content-Type: application/json' --data "$body"

echo "2) 正しい署名 → 200 のはず"
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$base/line/webhook" \
  -H 'Content-Type: application/json' -H "x-line-signature: $(sign "$body")" --data "$body"

echo "3) 同じイベントをもう一度 → 200（二重処理はしない）"
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$base/line/webhook" \
  -H 'Content-Type: application/json' -H "x-line-signature: $(sign "$body")" --data "$body"

echo "4) GET / → 200"
curl -s -o /dev/null -w '%{http_code}\n' "$base/"
