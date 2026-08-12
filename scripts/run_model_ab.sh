#!/bin/bash
#
# 准备完整的“1.0 Flash vs 录音文件识别 2.0”半自动 A/B。
#
# 本脚本只自动完成：共享音频 → 双 ASR → 字幕规范化 → 分句/静音候选/重说待审线索 → 冻结合同。
# 它刻意停在语义口误分析之前，防止把空 auto_selected.json 当成完整审核结果。
#
# 用法:
#   bash run_model_ab.sh <video.mp4> <ab_output_dir>
#
# 后续由同一位 Agent 对 A/B 使用同一份合同完成 speech_errors.json，
# 再运行 complete_model_ab.sh 生成两个盲审页。

set -euo pipefail

if [ "${1:-}" = "--help" ]; then
  echo "用法: $0 <video.mp4> <ab_output_dir> [--rules-dir <用户习惯目录>]"
  exit 0
fi
if [ "$#" -lt 2 ]; then
  echo "用法: $0 <video.mp4> <ab_output_dir> [--rules-dir <用户习惯目录>]"
  exit 1
fi

VIDEO_PATH="$1"
AB_DIR="$2"
shift 2

if [ ! -f "$VIDEO_PATH" ]; then
  echo "❌ 视频不存在: $VIDEO_PATH"
  exit 1
fi

if [ -e "$AB_DIR" ] && [ -n "$(find "$AB_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
  echo "❌ A/B 输出目录非空，拒绝覆盖: $AB_DIR"
  echo "   请换一个新目录，或先人工确认并清理旧实验。"
  exit 1
fi

for cmd in ffmpeg node python3 curl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "❌ 缺少依赖: $cmd"
    exit 1
  fi
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RULES_DIR="$SKILL_DIR/用户习惯"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --rules-dir)
      [ "$#" -ge 2 ] || { echo "❌ --rules-dir 缺少目录参数"; exit 1; }
      RULES_DIR="$2"
      shift 2
      ;;
    *)
      echo "❌ 未知参数: $1"
      exit 1
      ;;
  esac
done
if [ ! -f "$RULES_DIR/规则.md" ] || [ ! -f "$RULES_DIR/经验规则.md" ]; then
  echo "❌ 规则目录必须包含 规则.md 与 经验规则.md: $RULES_DIR"
  exit 1
fi
AB_DIR="$(mkdir -p "$AB_DIR" && cd "$AB_DIR" && pwd)"
SHARED_DIR="$AB_DIR/shared"
SHARED_AUDIO="$SHARED_DIR/audio.mp3"

mkdir -p "$SHARED_DIR"
echo "📦 抽取一次共享音频（A、B 使用同一字节文件）..."
ffmpeg -i "file:$VIDEO_PATH" -vn -acodec libmp3lame -y "$SHARED_AUDIO" 2>/dev/null

node "$SCRIPT_DIR/create_model_ab_manifest.js" init "$AB_DIR" "$VIDEO_PATH" "$SHARED_AUDIO" "$SKILL_DIR" "$RULES_DIR"

prepare_variant() {
  local variant="$1"
  local adapter="$2"
  local transcribe_dir="$AB_DIR/$variant/1_转录"
  local analysis_dir="$AB_DIR/$variant/2_分析"

  mkdir -p "$transcribe_dir" "$analysis_dir"
  cp "$SHARED_AUDIO" "$transcribe_dir/audio.mp3"
  echo "🚀 变体 ${variant}：转录中..."
  bash "$adapter" "$transcribe_dir/audio.mp3" "$transcribe_dir"
  node "$SCRIPT_DIR/generate_subtitles.js" \
    "$transcribe_dir/volcengine_v3_result.json" \
    "" \
    "$transcribe_dir"
  node "$SCRIPT_DIR/gen_analysis.js" \
    "$transcribe_dir/subtitles_words.json" \
    "$analysis_dir"
  node "$SCRIPT_DIR/create_model_ab_manifest.js" analysis-context "$AB_DIR" "$variant"
}

# A/B 映射只写入 manifest；审核页仅显示 A/B，不显示模型名。
prepare_variant "A" "$SCRIPT_DIR/volcengine_flash_transcribe.sh"
prepare_variant "B" "$SCRIPT_DIR/volcengine_seedasr2_transcribe.sh"

echo ""
echo "✅ A/B 转录与分析输入已完成: $AB_DIR"
echo "   冻结的个人规则来源: $RULES_DIR"
echo ""
echo "下一步（必须完成，不能跳过）："
echo "  1. 对 A 与 B 分别读取 2_分析/analysis.txt、restart_candidates.json 和 contract/ 中冻结的规则。"
echo "  2. 回听确认重说候选；只有确认成立的候选才写入各自的 2_分析/speech_errors.json。"
echo "  3. 分别运行："
echo "     node \"$SCRIPT_DIR/mark_model_ab_analysis_complete.js\" \"$AB_DIR/A/2_分析\" coding-agent"
echo "     node \"$SCRIPT_DIR/mark_model_ab_analysis_complete.js\" \"$AB_DIR/B/2_分析\" coding-agent"
echo "  4. 再运行："
echo "     bash \"$SCRIPT_DIR/complete_model_ab.sh\" \"$VIDEO_PATH\" \"$AB_DIR\""
