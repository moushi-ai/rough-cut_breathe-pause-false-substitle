#!/bin/bash
#
# 火山引擎录音文件识别 2.0（SeedASR，异步 submit → query 轮询）
#
# 用法:
#   ./volcengine_seedasr2_transcribe.sh <local_file.mp3> [output_dir]
#   ./volcengine_seedasr2_transcribe.sh <audio_url>      [output_dir]
#
# 输出: <output_dir>/volcengine_v3_result.json
#
# 下游刻意沿用现有结果文件名：generate_subtitles.js、口误分析、审核页和 FCPXML
# 都只依赖统一的 utterances[].words[] 协议，不需要知道 ASR 的具体型号。
# API Key 仅由 lib/load_api_key.sh 读取，绝不写入输出或日志。

AUDIO_INPUT="$1"
OUT_DIR="${2:-.}"

if [ -z "$AUDIO_INPUT" ]; then
  echo "❌ 用法: $0 <local_file_or_url> [output_dir]"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/lib/load_api_key.sh"
. "$SCRIPT_DIR/lib/volc_common.sh"

if [[ ! "$AUDIO_INPUT" =~ ^https?:// ]] && [ ! -f "$AUDIO_INPUT" ]; then
  echo "❌ 文件不存在: $AUDIO_INPUT"
  exit 1
fi

mkdir -p "$OUT_DIR"

REQ=$(mktemp /tmp/seedasr2_req_XXXXX.json)
SUB_HDR=$(mktemp /tmp/seedasr2_subhdr_XXXXX.txt)
SUB_BODY=$(mktemp /tmp/seedasr2_subbody_XXXXX.json)
Q_HDR=$(mktemp /tmp/seedasr2_qhdr_XXXXX.txt)
Q_BODY=$(mktemp /tmp/seedasr2_qbody_XXXXX.json)
trap 'rm -f "$REQ" "$SUB_HDR" "$SUB_BODY" "$Q_HDR" "$Q_BODY"' EXIT

RESOURCE_ID="volc.seedasr.auc"
REQUEST_ID=$(volc_gen_request_id)

echo "🎤 提交火山引擎 录音文件识别 2.0 转录任务..."
echo "   输入: $AUDIO_INPUT"
volc_build_request "$AUDIO_INPUT" "$REQ"

HTTP_CODE=$(curl -s -L -D "$SUB_HDR" -o "$SUB_BODY" -w "%{http_code}" \
  -X POST "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit" \
  -H "X-Api-Key: $API_KEY" \
  -H "X-Api-Resource-Id: $RESOURCE_ID" \
  -H "X-Api-Request-Id: $REQUEST_ID" \
  -H "X-Api-Sequence: -1" \
  -H "Content-Type: application/json" \
  --data-binary "@$REQ")

SUBMIT_STATUS=$(volc_status "$SUB_HDR")
LOG_ID=$(volc_header "$SUB_HDR" x-tt-logid)
echo "提交状态: ${SUBMIT_STATUS:-未返回} $(volc_header "$SUB_HDR" x-api-message)"

if [ "$SUBMIT_STATUS" != "20000000" ]; then
  echo "❌ 提交失败 (HTTP $HTTP_CODE, 状态码 ${SUBMIT_STATUS:-未返回})"
  cat "$SUB_BODY"
  echo ""
  exit 1
fi

echo "✅ 任务已提交"
echo "⏳ 等待识别完成..."

QUERY_LOGID=()
[ -n "$LOG_ID" ] && QUERY_LOGID=(-H "X-Tt-Logid: $LOG_ID")

MAX_ATTEMPTS=120
ATTEMPT=0

while [ "$ATTEMPT" -lt "$MAX_ATTEMPTS" ]; do
  sleep 3
  ATTEMPT=$((ATTEMPT + 1))

  curl -s -L -D "$Q_HDR" -o "$Q_BODY" \
    -X POST "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query" \
    -H "X-Api-Key: $API_KEY" \
    -H "X-Api-Resource-Id: $RESOURCE_ID" \
    -H "X-Api-Request-Id: $REQUEST_ID" \
    "${QUERY_LOGID[@]}" \
    -H "Content-Type: application/json" \
    -d "{}"

  STATUS=$(volc_status "$Q_HDR")
  case "$STATUS" in
    20000000)
      cp "$Q_BODY" "$OUT_DIR/volcengine_v3_result.json"
      echo ""
      echo "✅ 录音文件识别 2.0 完成，已保存 $OUT_DIR/volcengine_v3_result.json"
      echo "📝 识别结果: $(volc_word_count "$OUT_DIR/volcengine_v3_result.json")"
      exit 0
      ;;
    20000001|20000002)
      echo -n "."
      ;;
    20000003)
      echo ""
      echo "⚠️  音频为静音，无法识别"
      exit 1
      ;;
    "")
      echo -n "."
      ;;
    *)
      echo ""
      echo "❌ 录音文件识别 2.0 失败（状态码: $STATUS）"
      echo "   消息: $(volc_header "$Q_HDR" x-api-message)"
      cat "$Q_BODY"
      echo ""
      exit 1
      ;;
  esac
done

echo ""
echo "❌ 超时，录音文件识别 2.0 任务未完成"
exit 1
