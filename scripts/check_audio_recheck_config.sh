#!/bin/bash
# 预检数字声学复核的本机依赖；不发起网络请求，也不显示 API Key。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/lib/load_api_key.sh"

for command in ffmpeg ffprobe python3 curl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "❌ 数字声学复核缺少依赖：$command" >&2
    exit 1
  fi
done

echo "✅ 数字声学复核配置可用：火山引擎 Key 已找到；ffmpeg / ffprobe / python3 / curl 可用"
