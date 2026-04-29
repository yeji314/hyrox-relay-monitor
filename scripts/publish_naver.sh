#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_FILE="$ROOT_DIR/.naver-blog.env"

if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi

if [[ -z "${NAVER_BLOG_ID:-}" ]]; then
  echo "NAVER_BLOG_ID is required."
  echo "Set it in $CONFIG_FILE or export it in your shell."
  exit 1
fi

node "$ROOT_DIR/scripts/naver_publish.js" "${1:-}"
