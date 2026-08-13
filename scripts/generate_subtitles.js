#!/usr/bin/env node
/**
 * 从火山引擎结果生成字级别字幕。
 *
 * 用法: node generate_subtitles.js <volcengine_v3_result.json> [delete_segments.json] [output_dir]
 * 输出: subtitles_words.json
 */

'use strict';

const fs = require('fs');
const path = require('path');

// 录制口令需要在词级时间轴中成为独立原子，才能做到“只删口令，不吞正文”。
// `321但问题是…` / `三二一好了…` 这类 ASR 黏连词会在此拆成 [口令, 正文]。
const CUE_UNITS = new Set(['年', '月', '日', '天', '个', '次', '位', '人', '元', '块', '万', '亿', '吨', '米', '秒', '分', '小', '%', '％']);

function isAsciiDigit(char) {
  return /^[0-9]$/.test(char || '');
}

function isAsciiAlphaNumeric(char) {
  return /^[0-9A-Za-z]$/.test(char || '');
}

function isArabicNumber(text) {
  return /^\d+$/.test(String(text || ''));
}

function cueRanges(text) {
  const chars = Array.from(String(text || ''));
  const ranges = [];

  for (let index = 0; index < chars.length;) {
    const asciiCue = chars.slice(index, index + 3).join('') === '321';
    const chineseCue = chars.slice(index, index + 3).join('') === '三二一';
    if (!asciiCue && !chineseCue) {
      index += 1;
      continue;
    }

    const before = chars[index - 1];
    const after = chars[index + 3];
    // 避免把 1321 / 3210 或 321年这类可能的事实数值误当录制口令。
    // 英文型号（A321 / 321B）和事实数值同样不能被误当口令。
    if ((asciiCue && (isAsciiAlphaNumeric(before) || isAsciiAlphaNumeric(after))) || CUE_UNITS.has(after)) {
      index += 1;
      continue;
    }

    ranges.push({ start: index, end: index + 3 });
    index += 3;
  }
  return { chars, ranges };
}

function splitRecordingCueWord({ text, start, end }) {
  const sourceText = String(text || '');
  const { chars, ranges } = cueRanges(sourceText);
  if (ranges.length === 0) return [{ text: sourceText, start, end, isRecordingCue: false }];

  const parts = [];
  let cursor = 0;
  for (const range of ranges) {
    if (cursor < range.start) parts.push({ text: chars.slice(cursor, range.start).join(''), isRecordingCue: false });
    parts.push({ text: chars.slice(range.start, range.end).join(''), isRecordingCue: true });
    cursor = range.end;
  }
  if (cursor < chars.length) parts.push({ text: chars.slice(cursor).join(''), isRecordingCue: false });

  const charLength = chars.length || 1;
  const duration = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
  let consumed = 0;
  return parts.map((part, index) => {
    const width = Array.from(part.text).length;
    const partStart = Number.isFinite(start) ? start + duration * (consumed / charLength) : start;
    consumed += width;
    const partEnd = Number.isFinite(end)
      ? (index === parts.length - 1 ? end : start + duration * (consumed / charLength))
      : end;
    return { ...part, start: partStart, end: partEnd };
  });
}

function hasFactNumberContext(words, start, width) {
  const before = words[start - 1]?.text;
  const after = words[start + width]?.text;
  return isArabicNumber(before) || isArabicNumber(after) || CUE_UNITS.has(after);
}

function markSeparatedRecordingCues(words) {
  for (let index = 0; index < words.length; index++) {
    const chineseCue =
      words[index]?.text === '三' &&
      words[index + 1]?.text === '二' &&
      words[index + 2]?.text === '一';
    const asciiCue =
      words[index]?.text === '3' &&
      words[index + 1]?.text === '2' &&
      words[index + 2]?.text === '1';
    if ((!chineseCue && !asciiCue) || hasFactNumberContext(words, index, 3)) continue;

    // ASR 有时把倒数拆成三个词；仍然只给这三个词打标，绝不吞掉后续正文。
    words[index].isRecordingCue = true;
    words[index + 1].isRecordingCue = true;
    words[index + 2].isRecordingCue = true;
    index += 2;
  }
  return words;
}

function collectWords(result) {
  // 兼容 v1（顶层 utterances）和 v3（result.utterances）两种格式
  const utterances = result.result ? result.result.utterances : result.utterances;
  if (!utterances || utterances.length === 0) {
    throw new Error('未找到 utterances，响应格式可能不符合预期');
  }

  // 注意：火山 flash 引擎会在中英文边界塞入 text=' ' 且 start_time/end_time=-1 的“分隔符词”，
  // 必须过滤掉，否则 lastEnd 会被污染成负数，导致 gap 计算出几十秒的假静音段。
  const allWords = [];
  for (const utterance of utterances) {
    if (!utterance.words) continue;
    for (const word of utterance.words) {
      if (word.start_time < 0 || word.end_time < 0) continue;
      if (!word.text || !word.text.trim()) continue;
      const start = word.start_time / 1000;
      const end = word.end_time / 1000;
      for (const part of splitRecordingCueWord({ text: word.text, start, end })) {
        allWords.push({
          text: part.text,
          start: part.start,
          end: part.end,
          isRecordingCue: part.isRecordingCue || undefined,
        });
      }
    }
  }
  return markSeparatedRecordingCues(allWords);
}

function applyDeletedSegments(allWords, deleteSegments) {
  if (!Array.isArray(deleteSegments) || deleteSegments.length === 0) return allWords;

  function getDeletedTimeBefore(time) {
    let deleted = 0;
    for (const seg of deleteSegments) {
      if (seg.end <= time) {
        deleted += seg.end - seg.start;
      } else if (seg.start < time) {
        deleted += time - seg.start;
      }
    }
    return deleted;
  }

  function isDeleted(start, end) {
    for (const seg of deleteSegments) {
      if (start < seg.end && end > seg.start) return true;
    }
    return false;
  }

  return allWords.flatMap(word => {
    if (isDeleted(word.start, word.end)) return [];
    const deletedBefore = getDeletedTimeBefore(word.start);
    return [{
      ...word,
      start: Math.round((word.start - deletedBefore) * 100) / 100,
      end: Math.round((word.end - deletedBefore) * 100) / 100,
    }];
  });
}

function withGaps(outputWords) {
  // 添加空白标记（≥0.2秒才生成，与 gen_analysis.js 阈值一致）
  const wordsWithGaps = [];
  let lastEnd = 0;
  for (const word of outputWords) {
    const gapDuration = word.start - lastEnd;
    if (gapDuration >= 0.2) {
      wordsWithGaps.push({
        text: '',
        start: Math.round(lastEnd * 100) / 100,
        end: Math.round(word.start * 100) / 100,
        isGap: true,
      });
    }
    wordsWithGaps.push({ ...word, isGap: false });
    lastEnd = word.end;
  }
  return wordsWithGaps;
}

function generateSubtitles({ resultFile, deleteFile, outDir = '.' }) {
  if (!fs.existsSync(resultFile)) throw new Error(`找不到文件: ${resultFile}`);
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  const allWords = collectWords(result);
  const deleteSegments = deleteFile && fs.existsSync(deleteFile)
    ? JSON.parse(fs.readFileSync(deleteFile, 'utf8'))
    : null;
  const outputWords = applyDeletedSegments(allWords, deleteSegments);
  const wordsWithGaps = withGaps(outputWords);
  const outputFile = path.join(outDir, 'subtitles_words.json');
  fs.writeFileSync(outputFile, JSON.stringify(wordsWithGaps, null, 2));
  return {
    outputFile,
    rawWordCount: allWords.length,
    outputWordCount: outputWords.length,
    gapCount: wordsWithGaps.filter(word => word.isGap).length,
    deletedSegmentCount: deleteSegments ? deleteSegments.length : 0,
  };
}

function main() {
  const [, , resultFile = 'volcengine_v3_result.json', deleteFile, outDir = '.'] = process.argv;
  try {
    const outcome = generateSubtitles({ resultFile, deleteFile, outDir });
    console.log('原始字数:', outcome.rawWordCount);
    if (outcome.deletedSegmentCount) console.log('删除片段数:', outcome.deletedSegmentCount);
    if (outcome.deletedSegmentCount) console.log('映射后字数:', outcome.outputWordCount);
    console.log('总元素数:', outcome.outputWordCount + outcome.gapCount);
    console.log('空白段数:', outcome.gapCount);
    console.log(`✅ 已保存 ${outcome.outputFile}`);
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  applyDeletedSegments,
  collectWords,
  cueRanges,
  generateSubtitles,
  markSeparatedRecordingCues,
  splitRecordingCueWord,
  withGaps,
};
