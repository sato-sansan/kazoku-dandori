#!/usr/bin/env bash
# 開発を始める前に1回：git のコミット前フックを有効にする
set -eu
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath .githooks
chmod +x .githooks/pre-commit scripts/check-commit.sh .claude/hooks/guard-commit.sh
mkdir -p .claude/private
[ -f .claude/private/blocklist.txt ] || cp .claude/blocklist.example.txt .claude/private/blocklist.txt
echo "OK: コミット前の見張りを有効にしました。止め語は .claude/private/blocklist.txt に1行1語で。"
