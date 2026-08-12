#!/bin/bash
#
# 完成半自动模型 A/B 的后半段：验证语义分析（含重说候选核对）已完成 → 词级口癖预筛 → 合并选择
# → 生成两个隔离、盲标的审核目录。
#
# 用法:
#   bash complete_model_ab.sh <video.mp4> <ab_output_dir>

set -euo pipefail

if [ "${1:-}" = "--help" ]; then
  echo "用法: $0 <video.mp4> <ab_output_dir>"
  exit 0
fi
if [ "$#" -ne 2 ]; then
  echo "用法: $0 <video.mp4> <ab_output_dir>"
  exit 1
fi

VIDEO_PATH="$1"
AB_DIR="$2"

if [ ! -f "$VIDEO_PATH" ]; then
  echo "❌ 视频不存在: $VIDEO_PATH"
  exit 1
fi
if [ ! -f "$AB_DIR/manifest.json" ]; then
  echo "❌ 找不到 A/B manifest: $AB_DIR/manifest.json"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

complete_variant() {
  local variant="$1"
  local variant_dir="$AB_DIR/$variant"
  local transcribe_dir="$variant_dir/1_转录"
  local analysis_dir="$variant_dir/2_分析"
  local review_dir="$variant_dir/3_审核"

  echo "🧠 校验变体 $variant 的语义口误分析..."
  node "$SCRIPT_DIR/mark_model_ab_analysis_complete.js" --check "$analysis_dir"
  node "$SCRIPT_DIR/auto_filler.js" \
    "$analysis_dir/sentence_map.json" \
    "$transcribe_dir/subtitles_words.json" \
    "$analysis_dir/speech_errors.json"
  node "$SCRIPT_DIR/merge_selections.js" \
    "$analysis_dir/sentence_map.json" \
    "$analysis_dir/speech_errors.json" \
    "$analysis_dir/auto_selected.json"
  node "$SCRIPT_DIR/generate_review.js" \
    "$transcribe_dir/subtitles_words.json" \
    "$analysis_dir/auto_selected.json" \
    "$transcribe_dir/audio.mp3" \
    "$review_dir"
  node "$SCRIPT_DIR/create_model_ab_manifest.js" review-meta "$AB_DIR" "$variant"
}

complete_variant "A"
complete_variant "B"

echo ""
echo "✅ 两个盲审页工件已生成: $AB_DIR"
echo ""
echo "请分别用独立终端启动（审核页只显示 A/B，不显示模型名）："
echo "  bash \"$SCRIPT_DIR/serve_review.sh\" \"$AB_DIR/A/3_审核\" \"$VIDEO_PATH\" \"$SCRIPT_DIR/review_server.js\" auto"
echo "  bash \"$SCRIPT_DIR/serve_review.sh\" \"$AB_DIR/B/3_审核\" \"$VIDEO_PATH\" \"$SCRIPT_DIR/review_server.js\" auto"
echo ""
echo "两个页面都完成审核并点击“导出 FCPXML”后，运行："
echo "  node \"$SCRIPT_DIR/compare_model_ab.js\" \"$AB_DIR\""
