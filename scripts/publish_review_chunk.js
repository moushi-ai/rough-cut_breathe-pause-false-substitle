#!/usr/bin/env node
/**
 * 发布一个已完成语义分析的流式审核批次。
 *
 * 用法:
 *   node publish_review_chunk.js <2_分析目录> <3_审核目录> <chunk-id> <speech_errors.json> [--replace] [--skip-auto-filler]
 *
 * 此命令会：
 *   1. 对当前 core 句号范围运行安全口癖预筛；
 *   2. 验证删除标不越过 chunk 的 core；
 *   3. 原子更新 3_审核/data.json；
 *   4. 推进下一批状态，供已打开的审核页增量读取。
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  publishChunkSelection,
  validateChunkSelection,
  writeJsonAtomic,
} = require('./lib/review_stream');

const args = process.argv.slice(2);
const positional = [];
let replace = false;
let skipAutoFiller = false;
for (const arg of args) {
  if (arg === '--replace') replace = true;
  else if (arg === '--skip-auto-filler') skipAutoFiller = true;
  else positional.push(arg);
}

const [analysisDir, reviewDir, chunkId, errorsFile] = positional;
if (!analysisDir || !reviewDir || !chunkId || !errorsFile) {
  console.error('用法: node publish_review_chunk.js <2_分析目录> <3_审核目录> <chunk-id> <speech_errors.json> [--replace] [--skip-auto-filler]');
  process.exit(1);
}

function readJson(file, label) {
  if (!fs.existsSync(file)) throw new Error(`找不到${label}: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

try {
  const wordsFile = path.join(analysisDir, '..', '1_转录', 'subtitles_words.json');
  const sentenceMapFile = path.join(analysisDir, 'sentence_map.json');
  const manifestFile = path.join(analysisDir, 'review_chunks.json');
  const dataFile = path.join(reviewDir, 'data.json');
  const manifest = readJson(manifestFile, '流式分段清单');
  const data = readJson(dataFile, '审核数据');
  if (manifest.mode !== 'streaming') throw new Error('当前视频未进入流式模式（短于 2 分钟应沿用原单段流程）');
  if (!data.review || data.review.mode !== 'streaming') throw new Error('审核页没有以流式模式初始化');

  const plannedChunk = (manifest.chunks || []).find(chunk => chunk.id === chunkId);
  const reviewChunk = (data.review.chunks || []).find(chunk => chunk.id === chunkId);
  if (!plannedChunk || !reviewChunk) throw new Error(`找不到批次: ${chunkId}`);
  if (
    plannedChunk.core.startIdx !== reviewChunk.core.startIdx ||
    plannedChunk.core.endIdx !== reviewChunk.core.endIdx ||
    plannedChunk.core.startSentence !== reviewChunk.core.startSentence ||
    plannedChunk.core.endSentence !== reviewChunk.core.endSentence
  ) {
    throw new Error(`批次 ${chunkId} 的审核状态与分段合同不一致，拒绝发布`);
  }
  if (!fs.existsSync(errorsFile)) throw new Error(`找不到本批 speech_errors.json: ${errorsFile}`);

  if (!skipAutoFiller) {
    const autoFiller = path.join(__dirname, 'auto_filler.js');
    execFileSync(process.execPath, [
      autoFiller,
      sentenceMapFile,
      wordsFile,
      errorsFile,
      '--sentence-range', String(reviewChunk.core.startSentence), String(reviewChunk.core.endSentence),
    ], { stdio: 'inherit' });
  }

  const words = readJson(wordsFile, '逐字时间轴');
  const sentenceMap = readJson(sentenceMapFile, '分句映射');
  const errors = readJson(errorsFile, '本批删除清单');
  const selected = validateChunkSelection({ words, sentenceMap, chunk: reviewChunk, rawErrors: errors });
  const result = publishChunkSelection(data, { chunkId, selected, replace });
  if (result.changed) writeJsonAtomic(dataFile, result.data);

  const readyCount = result.data.review.chunks.filter(chunk => chunk.status === 'ready').length;
  const total = result.data.review.chunks.length;
  console.log(`✅ 已发布 ${chunkId}: ${selected.length} 个台词 idx；审核进度 ${readyCount}/${total}`);
  if (result.data.review.status === 'complete') console.log('🎬 全部批次已就绪，审核页已解锁 FCPXML 导出');
} catch (error) {
  console.error('❌ 发布审核批次失败: ' + error.message);
  process.exit(1);
}
