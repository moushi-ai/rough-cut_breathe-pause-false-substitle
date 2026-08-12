#!/usr/bin/env node
/*
 * 为半自动 A/B 的语义分析阶段落一个可验证的完成标记。
 * Agent 必须先写好 speech_errors.json，再运行本脚本；complete_model_ab.sh
 * 只接受带此标记的变体，避免再次把“只有静音候选”的半成品送进审核页。
 *
 * 用法:
 *   node mark_model_ab_analysis_complete.js <variant/2_分析> [analyst]
 *   node mark_model_ab_analysis_complete.js --check <variant/2_分析>
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const checkOnly = args[0] === '--check';
const analysisDirInput = checkOnly ? args[1] : args[0];
const analysisDir = analysisDirInput ? path.resolve(analysisDirInput) : null;
const analyst = checkOnly ? null : (args[1] || 'coding-agent');

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`无法读取 ${file}：${error.message}`);
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function isInt(value) {
  return Number.isInteger(value);
}

function validate() {
  if (!analysisDir || !fs.existsSync(analysisDir)) fail('请提供存在的 2_分析 目录');
  const mapFile = path.join(analysisDir, 'sentence_map.json');
  const errorsFile = path.join(analysisDir, 'speech_errors.json');
  const wordsFile = path.join(path.dirname(analysisDir), '1_转录', 'subtitles_words.json');
  for (const file of [mapFile, errorsFile, wordsFile]) {
    if (!fs.existsSync(file)) fail(`缺少必需文件：${file}`);
  }

  const sentenceMap = readJson(mapFile);
  const errors = readJson(errorsFile);
  const words = readJson(wordsFile);
  if (!Array.isArray(sentenceMap) || !Array.isArray(words)) fail('sentence_map.json 或 subtitles_words.json 格式不正确');
  if (!errors || Array.isArray(errors) || typeof errors !== 'object') fail('speech_errors.json 必须是对象格式');
  const deleteSentences = errors.delete_sentences;
  const deleteIdx = errors.delete_idx;
  if (!Array.isArray(deleteSentences) || !Array.isArray(deleteIdx)) {
    fail('speech_errors.json 必须同时包含 delete_sentences 和 delete_idx 数组');
  }
  const duplicateSentence = new Set();
  for (const idx of deleteSentences) {
    if (!isInt(idx) || idx < 0 || idx >= sentenceMap.length) fail(`无效 delete_sentences 句号：${idx}`);
    if (duplicateSentence.has(idx)) fail(`delete_sentences 有重复句号：${idx}`);
    duplicateSentence.add(idx);
  }
  const duplicateWord = new Set();
  for (const idx of deleteIdx) {
    if (!isInt(idx) || idx < 0 || idx >= words.length) fail(`无效 delete_idx：${idx}`);
    if (words[idx].isGap) fail(`delete_idx 不能指向静音元素：${idx}`);
    if (duplicateWord.has(idx)) fail(`delete_idx 有重复索引：${idx}`);
    duplicateWord.add(idx);
  }
  return { errorsFile, sentenceMap, words, deleteSentences, deleteIdx };
}

if (checkOnly) {
  if (args.length !== 2) fail('用法：--check <variant/2_分析>');
  const markerFile = path.join(analysisDir, 'analysis_completion.json');
  if (!fs.existsSync(markerFile)) fail('缺少 analysis_completion.json；说明语义分析尚未被显式确认');
  const marker = readJson(markerFile);
  if (marker.analysisCompleted !== true) fail('analysis_completion.json 未声明 analysisCompleted=true');
  validate();
  console.log('✅ 语义分析完成标记与 speech_errors.json 均有效');
  process.exit(0);
}

if (args.length < 1 || args.length > 2) fail('用法：<variant/2_分析> [analyst]');
const result = validate();
const marker = {
  schemaVersion: 1,
  analysisCompleted: true,
  completedAt: new Date().toISOString(),
  analyst,
  semanticErrorsSha256: sha256(result.errorsFile),
  deleteSentences: result.deleteSentences.length,
  deleteIdxBeforeAutoFiller: result.deleteIdx.length,
  sentenceCount: result.sentenceMap.length,
  wordCount: result.words.filter(word => !word.isGap).length,
};
const markerFile = path.join(analysisDir, 'analysis_completion.json');
fs.writeFileSync(markerFile, `${JSON.stringify(marker, null, 2)}\n`);
console.log(`✅ 已记录语义分析完成：${markerFile}`);
