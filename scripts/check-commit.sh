#!/usr/bin/env bash
# コミット前の見張り：キー・トークン・子どもの本名・実物の写真が混ざっていたら止める
#
# 使われ方
#   1. git の pre-commit フック（.githooks/pre-commit → core.hooksPath で有効化）
#   2. Claude Code の PreToolUse フック（.claude/hooks/guard-commit.sh が呼ぶ）
#
# 見るもの：ステージ済みの差分（git diff --cached）
# 止め語：.claude/private/blocklist.txt（1行1語。子どもの本名・園名・学校名。公開しない＝gitignore）
#
# 終了コード：0 = 通す / 1 = 止める

set -u
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

fail=0
say() { printf '%s\n' "$*" >&2; }

staged_files=$(git diff --cached --name-only --diff-filter=ACMR)
[ -z "$staged_files" ] && exit 0

# ── 1. 入れてはいけないファイル ─────────────────────────────
while IFS= read -r f; do
  case "$f" in
    .dev.vars|.dev.vars.*|.env|.env.*)
      say "止めました: 秘密のファイル '$f' はコミットしない（.gitignore に入っているはず）"; fail=1 ;;
    eval/private/*)
      [ "$f" = "eval/private/.gitkeep" ] || { say "止めました: 実物の評価素材 '$f' は公開しない"; fail=1; } ;;
    .claude/private/*)
      say "止めました: 止め語リスト '$f' は公開しない"; fail=1 ;;
  esac
  # 画像は docs/assets/（架空の見本・図）以外に置かない
  case "$f" in
    *.jpg|*.jpeg|*.png|*.heic|*.heif|*.webp|*.gif)
      case "$f" in
        docs/assets/*|eval/public/*) ;;
        *) say "止めました: 画像 '$f' は docs/assets/ か eval/public/ 以外に置かない（実物の写真が混ざる事故を防ぐ）"; fail=1 ;;
      esac ;;
  esac
done <<< "$staged_files"

# ── 2. 追加行の中身を見る ─────────────────────────────────
added=$(git diff --cached --unified=0 --no-color -- . ':(exclude)package-lock.json' ':(exclude)*.lock' \
        | grep -E '^\+' | grep -vE '^\+\+\+' | cut -c2-)

if [ -n "$added" ]; then
  # 2a. キー・トークンの形
  declare -a patterns=(
    'sk-ant-[A-Za-z0-9_-]{20,}'                                      # Claude API キー
    '(CHANNEL_SECRET|CHANNEL_ACCESS_TOKEN|API_KEY|SECRET|TOKEN)[A-Z_]*\s*[=:]\s*["'"'"']?[A-Za-z0-9+/_-]{24,}'  # 代入の形
    '[A-Za-z0-9+/]{120,}={0,2}'                                       # LINE の長期アクセストークンのような長い base64
    'Bearer\s+[A-Za-z0-9+/_-]{30,}'                                   # Authorization ヘッダに直書き
    '-----BEGIN [A-Z ]*PRIVATE KEY-----'                              # 秘密鍵
  )
  for p in "${patterns[@]}"; do
    hit=$(printf '%s\n' "$added" | grep -nE -e "$p" | head -3 || true)
    if [ -n "$hit" ]; then
      say "止めました: キーやトークンの形が見つかりました（パターン: $p）"
      printf '%s\n' "$hit" | sed 's/^/    /' | cut -c1-120 >&2
      fail=1
    fi
  done

  # 2b. 子どもの本名・園名・学校名（止め語リスト）
  blocklist=".claude/private/blocklist.txt"
  if [ -f "$blocklist" ]; then
    n=0
    while IFS= read -r word; do
      n=$((n+1))
      word="${word%%#*}"; word="$(printf '%s' "$word" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
      [ -z "$word" ] && continue
      hit=$(printf '%s\n' "$added" | grep -nF -- "$word" | head -3 || true)
      if [ -n "$hit" ]; then
        say "止めました: 止め語（本名・園名・学校名）が見つかりました: $blocklist の ${n} 行目の語"
        fail=1
      fi
    done < "$blocklist"
  else
    say "注意: $blocklist がありません。子どもの本名・園名・学校名を1行1語で置くと、コミット前に止められます"
  fi
fi

if [ "$fail" -ne 0 ]; then
  say ""
  say "→ 該当する行・ファイルを外してから、もう一度コミットしてください。"
  exit 1
fi
exit 0
