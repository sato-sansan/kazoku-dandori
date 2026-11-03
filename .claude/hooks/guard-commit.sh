#!/usr/bin/env bash
# Claude Code の PreToolUse フック（matcher: Bash）
# Claude が `git commit` / `git push` を打とうとした瞬間に、scripts/check-commit.sh で中身を見張る。
# 止めるときは終了コード 2（Claude に理由が返り、コマンドは実行されない）。
#
# 入力：標準入力に JSON（tool_input.command にこれから実行するコマンド）
# JSON は解釈せず全文から探す。余分に見張ることはあっても、道具がなくて素通しになることはない

set -u
input=$(cat)

git_verb() {
  printf '%s' "$input" | grep -qE "(^|[;&|\"[:space:]]|\\\\n)git([[:space:]]+-[^[:space:]]+([[:space:]]+[^-[:space:]][^[:space:]]*)?)*[[:space:]]+$1([[:space:]\"]|\$)"
}

# git commit / git push 以外は素通し
git_verb commit || git_verb push || exit 0

root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0

# push のときは、ステージではなく「まだ push していないコミット」を見る
if git_verb push; then
  upstream=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)
  # 最初の push は全部のコミットを見る
  base="${upstream:-$(git hash-object -t tree /dev/null)}"
  if git diff --unified=0 --no-color "$base" HEAD | grep -E '^\+' | grep -vE '^\+\+\+' | cut -c2- \
     | grep -qE 'sk-ant-[A-Za-z0-9_-]{20,}|[A-Za-z0-9+/]{120,}={0,2}|-----BEGIN [A-Z ]*PRIVATE KEY-----'; then
    echo "止めました: push しようとしているコミットにキーやトークンの形があります。コミットを直してから。" >&2
    exit 2
  fi
fi

# commit：ステージ済みの差分を点検
if git_verb commit && ! bash "$root/scripts/check-commit.sh"; then
  echo "（Claude Code フック guard-commit.sh が止めました）" >&2
  exit 2
fi
exit 0
