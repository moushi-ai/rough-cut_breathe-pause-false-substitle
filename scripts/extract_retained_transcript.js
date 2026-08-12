#!/usr/bin/env node
/**
 * 从审核页最终导出日志中提取“成片实际保留”的台词。
 *
 * 这个脚本只处理最终审核选择，不改写原始逐字时间轴：字幕校对、术语替换
 * 和断行都应在它的输出层进行，避免破坏审核页/FCPXML 使用的原始 idx 与时间戳。
 *
 * 用法:
 *   node extract_retained_transcript.js <3_审核目录> [4_字幕输出目录]
 *
 * 输入:
 *   <3_审核>/data.json        审核页原始逐字时间轴
 *   <3_审核>/review_log.json  用户导出时记录的 finalSelected
 *
 * 输出:
 *   <4_字幕>/retained_raw.txt       每个原始语音段一行、仅含成片保留台词
 *   <4_字幕>/retained_transcript.json  文字与原始 idx/时间的可追溯映射
 */

'use strict';

const fs = require('fs');
const path = require('path');

function fail(message) {
  throw new Error(message);
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`无法读取 ${label}：${file} (${error.message})`);
  }
}

function validateFinalSelection(words, finalSelected) {
  if (!Array.isArray(finalSelected)) {
    fail('review_log.json 缺少 finalSelected；请先在审核页点击“导出 FCPXML”生成完整审核日志。');
  }
  const selected = new Set();
  for (const index of finalSelected) {
    if (!Number.isInteger(index) || index < 0 || index >= words.length) {
      fail(`review_log.json 的 finalSelected 包含无效 idx：${index}`);
    }
    selected.add(index);
  }
  return selected;
}

function extractRetainedTranscript({ words, finalSelected }) {
  if (!Array.isArray(words)) fail('data.json 的 words 必须是数组');
  const selected = validateFinalSelection(words, finalSelected);
  const lines = [];
  const retainedWords = [];
  let current = [];

  function flush() {
    if (current.length === 0) return;
    lines.push({
      line: lines.length + 1,
      text: current.map(word => word.text).join(''),
      sourceWordIndices: current.map(word => word.sourceIndex),
      sourceStart: current[0].start,
      sourceEnd: current[current.length - 1].end,
    });
    current = [];
  }

  words.forEach((word, sourceIndex) => {
    if (!word || typeof word !== 'object') fail(`data.json 的 words[${sourceIndex}] 格式不正确`);
    if (word.isGap) {
      // 原始语音段的边界是“句子一行”的可靠来源。被选中的静音不会删除台词。
      flush();
      return;
    }
    if (selected.has(sourceIndex)) return;

    const text = String(word.text || '');
    if (!text) return;
    const retained = {
      sourceIndex,
      text,
      start: Number.isFinite(word.start) ? word.start : null,
      end: Number.isFinite(word.end) ? word.end : null,
    };
    current.push(retained);
    retainedWords.push(retained);
  });
  flush();

  const selectedWordIndices = [...selected].filter(index => words[index] && !words[index].isGap);
  const selectedGapIndices = [...selected].filter(index => words[index] && words[index].isGap);
  return {
    schemaVersion: 1,
    sourceWordCount: words.filter(word => word && !word.isGap).length,
    retainedWordCount: retainedWords.length,
    deletedWordCount: selectedWordIndices.length,
    selectedGapCount: selectedGapIndices.length,
    lines,
    retainedWords,
  };
}

function writeRetainedTranscript({ reviewDir, outputDir }) {
  const resolvedReviewDir = path.resolve(reviewDir);
  const resolvedOutputDir = path.resolve(outputDir || path.join(path.dirname(resolvedReviewDir), '4_字幕'));
  const dataFile = path.join(resolvedReviewDir, 'data.json');
  const reviewLogFile = path.join(resolvedReviewDir, 'review_log.json');
  if (!fs.existsSync(dataFile)) fail(`找不到审核数据：${dataFile}`);
  if (!fs.existsSync(reviewLogFile)) fail(`找不到审核导出日志：${reviewLogFile}`);

  const data = readJson(dataFile, 'data.json');
  const reviewLog = readJson(reviewLogFile, 'review_log.json');
  const transcript = extractRetainedTranscript({
    words: data.words,
    finalSelected: reviewLog.finalSelected,
  });
  const artifact = {
    ...transcript,
    generatedAt: new Date().toISOString(),
    source: {
      reviewDir: resolvedReviewDir,
      reviewLogExportedAt: reviewLog.exportedAt || null,
      reviewLogVideo: reviewLog.video || null,
    },
    correctionPolicy: '保留原始逐字时间轴；后续只在字幕文本层校对。专有名词或人名不确定时保留原 ASR，并写入 uncertain.md。',
  };

  fs.mkdirSync(resolvedOutputDir, { recursive: true });
  const rawFile = path.join(resolvedOutputDir, 'retained_raw.txt');
  const mappingFile = path.join(resolvedOutputDir, 'retained_transcript.json');
  fs.writeFileSync(rawFile, `${artifact.lines.map(line => line.text).join('\n')}\n`);
  fs.writeFileSync(mappingFile, `${JSON.stringify(artifact, null, 2)}\n`);
  return { outputDir: resolvedOutputDir, rawFile, mappingFile, transcript: artifact };
}

function main() {
  const [, , reviewDir, outputDir] = process.argv;
  if (!reviewDir || (outputDir && process.argv.length !== 4)) {
    console.error('用法: node extract_retained_transcript.js <3_审核目录> [4_字幕输出目录]');
    process.exit(1);
  }
  try {
    const result = writeRetainedTranscript({ reviewDir, outputDir });
    console.log(`✅ 已提取成片保留台词：${result.rawFile}`);
    console.log(`   保留 ${result.transcript.retainedWordCount} / ${result.transcript.sourceWordCount} 字，${result.transcript.lines.length} 行`);
    console.log(`   可追溯映射：${result.mappingFile}`);
  } catch (error) {
    console.error(`❌ 提取成片保留台词失败：${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  extractRetainedTranscript,
  writeRetainedTranscript,
};
