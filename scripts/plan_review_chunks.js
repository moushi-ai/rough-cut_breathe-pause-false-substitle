#!/usr/bin/env node
/**
 * 从一次完整转录中规划流式审核批次。
 *
 * 用法:
 *   node plan_review_chunks.js <subtitles_words.json> <sentence_map.json> <restart_candidates.json> <review_chunks.json> [选项]
 *
 * 选项:
 *   --target-seconds 120
 *   --min-seconds 90
 *   --max-seconds 150
 *   --context-seconds 12
 *
 * 只规划、不做语义删除。输出的 core 区间不重叠，context 只用于 AI 判断跨边界重录。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { DEFAULT_CHUNK_OPTIONS, planReviewChunks, writeJsonAtomic } = require('./lib/review_stream');

const args = process.argv.slice(2);
const positional = [];
const options = {};

for (let index = 0; index < args.length; index++) {
  const value = args[index];
  if (!value.startsWith('--')) {
    positional.push(value);
    continue;
  }
  const optionName = value.slice(2);
  const rawNumber = args[++index];
  const parsed = Number(rawNumber);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`❌ ${value} 需要一个正数，收到: ${rawNumber || '(缺失)'}`);
    process.exit(1);
  }
  const optionMap = {
    'target-seconds': 'targetSeconds',
    'min-seconds': 'minSeconds',
    'max-seconds': 'maxSeconds',
    'context-seconds': 'contextSeconds',
  };
  if (!optionMap[optionName]) {
    console.error(`❌ 未知选项: ${value}`);
    process.exit(1);
  }
  options[optionMap[optionName]] = parsed;
}

const [wordsFile, sentenceMapFile, restartCandidatesFile, outputFile] = positional;
if (!wordsFile || !sentenceMapFile || !restartCandidatesFile || !outputFile) {
  console.error('用法: node plan_review_chunks.js <subtitles_words.json> <sentence_map.json> <restart_candidates.json> <review_chunks.json> [选项]');
  process.exit(1);
}

if (options.minSeconds && options.maxSeconds && options.minSeconds > options.maxSeconds) {
  console.error('❌ --min-seconds 不能大于 --max-seconds');
  process.exit(1);
}

function readJson(file, label) {
  if (!fs.existsSync(file)) {
    console.error(`❌ 找不到${label}: ${file}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const words = readJson(wordsFile, '逐字时间轴');
const sentenceMap = readJson(sentenceMapFile, '分句映射');
const restartCandidates = readJson(restartCandidatesFile, '重录候选');
const config = { ...DEFAULT_CHUNK_OPTIONS, ...options };

let manifest;
try {
  manifest = planReviewChunks({ words, sentenceMap, restartCandidates, options: config });
} catch (error) {
  console.error('❌ 无法规划审核批次: ' + error.message);
  process.exit(1);
}

fs.mkdirSync(path.dirname(outputFile), { recursive: true });
writeJsonAtomic(outputFile, manifest);

console.log(`🧩 审核模式: ${manifest.mode === 'streaming' ? '流式分段' : '单段（< 2 分钟）'}`);
console.log(`⏱️  时间轴: ${manifest.durationSeconds.toFixed(1)}s，目标批次 ${manifest.config.targetSeconds}s`);
for (const chunk of manifest.chunks) {
  const duration = chunk.core.endTime - chunk.core.startTime;
  console.log(
    `   ${chunk.id}: ${chunk.core.startTime.toFixed(1)}–${chunk.core.endTime.toFixed(1)}s ` +
    `(${duration.toFixed(1)}s，句${chunk.core.startSentence}–${chunk.core.endSentence}，${chunk.boundary.kind})`,
  );
}
console.log(`✅ 已写入: ${outputFile}`);
