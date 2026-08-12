#!/bin/bash
#
# 火山引擎 大模型录音文件极速版（auc_turbo / flash 接口）
#
# 用法:
#   ./volcengine_flash_transcribe.sh <local_file>  [output_dir] [--verbatim]   ← 推荐，base64 直传
#   ./volcengine_flash_transcribe.sh <https://...>  [output_dir] [--verbatim]  ← URL 模式
#
# --verbatim 只供事实核验的短片声学复听：显式关闭 ITN，使“百分之七十二”
# 这类口头表达保留为文本，不被服务端转换为 72%。完整视频首次转录不传该参数，
# 保持现有 enable_itn=true 行为。
#
# 输出: <output_dir>/volcengine_v3_result.json （与标准版同名，下游脚本无需区分引擎）
#
# 特点（与标准版对比）:
#   - 一次请求直出，无需 submit/query 轮询
#   - 单 X-Api-Key 认证（新版控制台），与标准版共用同一个 VOLCENGINE_API_KEY
#   - base64 直传是官方文档化方案，不依赖外部图床
#   - 限制: 音频 ≤ 2h、≤ 100MB
#   - 极速版 API: https://www.volcengine.com/docs/6561/1631584
#
# 请求体构建 / 状态头解析 / 字数统计与标准版共用 lib/volc_common.sh + lib/build_request.py。

set -e

AUDIO_INPUT=""
OUT_DIR="."
VERBATIM=0
POSITIONAL=0
for arg in "$@"; do
  case "$arg" in
    --verbatim) VERBATIM=1 ;;
    --*)
      echo "❌ 未知参数: $arg"
      echo "用法: $0 <local_file_or_url> [output_dir] [--verbatim]"
      exit 1
      ;;
    *)
      if [ "$POSITIONAL" -eq 0 ]; then
        AUDIO_INPUT="$arg"
      elif [ "$POSITIONAL" -eq 1 ]; then
        OUT_DIR="$arg"
      else
        echo "❌ 参数过多"
        echo "用法: $0 <local_file_or_url> [output_dir] [--verbatim]"
        exit 1
      fi
      POSITIONAL=$((POSITIONAL + 1))
      ;;
  esac
done

if [ -z "$AUDIO_INPUT" ]; then
  echo "❌ 用法: $0 <local_file_or_url> [output_dir]"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/lib/load_api_key.sh"
. "$SCRIPT_DIR/lib/volc_common.sh"

# 本地文件：校验存在 + 大小（极速版上限 100MB）
if [[ ! "$AUDIO_INPUT" =~ ^https?:// ]]; then
  if [ ! -f "$AUDIO_INPUT" ]; then
    echo "❌ 音频文件不存在: $AUDIO_INPUT"
    exit 1
  fi
  BYTES=$(stat -f%z "$AUDIO_INPUT" 2>/dev/null || stat -c%s "$AUDIO_INPUT" 2>/dev/null)
  if [ -n "$BYTES" ] && [ "$BYTES" -gt 104857600 ]; then
    echo "❌ 音频超过 100MB（极速版上限），请改用标准版或先压缩"
    exit 1
  fi
fi

mkdir -p "$OUT_DIR"
REQ=$(mktemp /tmp/flash_req_XXXXX.json)
HDR=$(mktemp /tmp/flash_hdr_XXXXX.txt)
trap 'rm -f "$REQ" "$HDR"' EXIT

echo "🎤 火山引擎 极速版 转录..."
echo "   输入: $AUDIO_INPUT"
REQUEST_ARGS=()
if [ "$VERBATIM" -eq 1 ]; then
  REQUEST_ARGS=(--enable-itn false)
  echo "   模式: 原样复听（enable_itn=false，保留口头数字表达）"
fi
volc_build_request "$AUDIO_INPUT" "$REQ" "${REQUEST_ARGS[@]}"

HTTP_CODE=$(curl -s -o "$OUT_DIR/volcengine_v3_result.json" -D "$HDR" -w "%{http_code}" \
  -X POST "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash" \
  -H "X-Api-Key: $API_KEY" \
  -H "X-Api-Resource-Id: volc.bigasr.auc_turbo" \
  -H "X-Api-Request-Id: $(volc_gen_request_id)" \
  -H "X-Api-Sequence: -1" \
  -H "Content-Type: application/json" \
  --data-binary "@$REQ")

STATUS=$(volc_status "$HDR")

if [ "$STATUS" = "20000000" ]; then
  echo "✅ 转录完成: $OUT_DIR/volcengine_v3_result.json"
  echo "📝 识别结果: $(volc_word_count "$OUT_DIR/volcengine_v3_result.json")"
  exit 0
fi

# ── 错误诊断 ─────────────────────────────────────────────
echo ""
echo "❌ 转录失败"
echo "   HTTP: $HTTP_CODE"
echo "   状态码: ${STATUS:-未返回}"
echo "   消息: $(volc_header "$HDR" x-api-message)"
case "$STATUS" in
  45000010) echo "   提示: API Key 无效，检查 VOLCENGINE_API_KEY 是否来自新版控制台" ;;
  45000151) echo "   提示: 资源未授权，去控制台开通「录音文件识别极速版」" ;;
  45000003) echo "   提示: 请求参数错误（可能是音频格式 / 大小不支持）" ;;
  55000031) echo "   提示: 服务端处理失败，建议稍后重试" ;;
esac
echo ""
echo "完整响应:"
cat "$OUT_DIR/volcengine_v3_result.json"
echo ""
exit 1
