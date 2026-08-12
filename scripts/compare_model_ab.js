#!/usr/bin/env node
/*
 * 汇总完整模型 A/B 的盲审结果。
 *
 * 用法:
 *   node compare_model_ab.js <ab_output_dir>
 *
 * 评分使用同一源视频的绝对时间区间，而不是两套 ASR 各自的 word idx：
 * 两个模型的分词、分句不同，直接比较 idx 没有意义。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { computeFinalKeeps } = require('./lib/compute_keeps');

function fail(message) {
  throw new Error(message);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`无法读取 ${file}：${error.message}`);
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeIntervals(raw) {
  const intervals = (Array.isArray(raw) ? raw : [])
    .map(item => ({ start: number(item && item.start), end: number(item && item.end) }))
    .filter(item => item.start !== null && item.end !== null && item.end > item.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const item of intervals) {
    const previous = merged[merged.length - 1];
    if (previous && item.start <= previous.end + 1e-6) {
      previous.end = Math.max(previous.end, item.end);
    } else {
      merged.push({ ...item });
    }
  }
  return merged;
}

function intervalsFromSelectedIndices(rawIndices, words) {
  const indexes = [...new Set((Array.isArray(rawIndices) ? rawIndices : [])
    .filter(Number.isInteger)
    .filter(index => words[index] && !words[index].isGap))]
    .sort((a, b) => a - b);

  const groups = [];
  let current = null;
  for (const index of indexes) {
    const word = words[index];
    if (!current) {
      current = { start: word.start, end: word.end, firstIndex: index, lastIndex: index, wordCount: 1 };
      continue;
    }
    // 同一删除意图允许跨一个 gap 元素；两个以上的索引断开即另起区间。
    if (index <= current.lastIndex + 2) {
      current.end = Math.max(current.end, word.end);
      current.lastIndex = index;
      current.wordCount += 1;
    } else {
      groups.push(current);
      current = { start: word.start, end: word.end, firstIndex: index, lastIndex: index, wordCount: 1 };
    }
  }
  if (current) groups.push(current);
  return groups;
}

function duration(intervals) {
  return intervals.reduce((sum, item) => sum + Math.max(0, item.end - item.start), 0);
}

function intersectionDuration(left, right) {
  let i = 0;
  let j = 0;
  let total = 0;
  while (i < left.length && j < right.length) {
    const start = Math.max(left[i].start, right[j].start);
    const end = Math.min(left[i].end, right[j].end);
    if (end > start) total += end - start;
    if (left[i].end <= right[j].end) i += 1;
    else j += 1;
  }
  return total;
}

function percentage(numerator, denominator) {
  if (!denominator) return null;
  return +(100 * numerator / denominator).toFixed(2);
}

function findDuration(words, peaks) {
  const peakDuration = number(peaks && peaks.duration);
  if (peakDuration !== null && peakDuration > 0) return peakDuration;
  return words.reduce((max, word) => Math.max(max, number(word.end) || 0), 0);
}

function validateCutSafety(log, words, silencePeriods, durationSeconds) {
  const deleteList = normalizeIntervals(log.deleteList);
  const opts = log.opts || undefined;
  const keeps = computeFinalKeeps(deleteList, silencePeriods, durationSeconds, opts, words);
  const finalSelected = new Set((Array.isArray(log.finalSelected) ? log.finalSelected : [])
    .filter(Number.isInteger));
  const violations = [];
  let overlaps = 0;
  for (let i = 1; i < keeps.length; i++) {
    if (keeps[i].start < keeps[i - 1].end - 1e-9) overlaps += 1;
  }
  for (let keepIndex = 0; keepIndex < keeps.length; keepIndex++) {
    const keep = keeps[keepIndex];
    words.forEach((word, wordIndex) => {
      if (!word || word.isGap || finalSelected.has(wordIndex)) return;
      if (word.start < keep.start && keep.start < word.end) {
        violations.push({ type: 'start-in-kept-word', keepIndex, wordIndex, text: word.text, time: keep.start });
      }
      if (word.start < keep.end && keep.end < word.end) {
        violations.push({ type: 'end-in-kept-word', keepIndex, wordIndex, text: word.text, time: keep.end });
      }
    });
  }
  return {
    finalKeeps: keeps.length,
    keptWordBoundaryViolations: violations.length,
    keptWordBoundaryExamples: violations.slice(0, 5),
    sourceClipOverlaps: overlaps,
  };
}

function scoreVariant(abDir, variant, manifest) {
  const reviewDir = path.join(abDir, variant, '3_审核');
  const dataFile = path.join(reviewDir, 'data.json');
  const logFile = path.join(reviewDir, 'review_log.json');
  const silenceFile = path.join(reviewDir, 'silence_periods.json');
  const peaksFile = path.join(reviewDir, 'peaks.json');
  for (const file of [dataFile, logFile, silenceFile, peaksFile]) {
    if (!fs.existsSync(file)) fail(`${variant} 缺少完成 A/B 所需文件：${file}`);
  }
  const data = readJson(dataFile);
  const log = readJson(logFile);
  if (!Array.isArray(data.words)) fail(`${variant} data.json 缺少 words 数组`);
  if (!Array.isArray(log.aiSelected) || !Array.isArray(log.finalSelected)) {
    fail(`${variant} review_log.json 缺少 aiSelected 或 finalSelected`);
  }
  if (!Array.isArray(log.deleteList)) {
    fail(`${variant} review_log.json 缺少 deleteList；请使用本次 A/B 更新后的审核页重新导出`);
  }
  if (log.ab && log.ab.variant && log.ab.variant !== variant) {
    fail(`${variant} 的 review_log.json 盲审标签不匹配：${log.ab.variant}`);
  }

  const words = data.words;
  const aiWordIntervals = normalizeIntervals(intervalsFromSelectedIndices(log.aiSelected, words));
  const finalWordIntervals = normalizeIntervals(intervalsFromSelectedIndices(log.finalSelected, words));
  const finalDeleteIntervals = normalizeIntervals(log.deleteList);
  const matchedSeconds = intersectionDuration(aiWordIntervals, finalWordIntervals);
  const candidateSeconds = duration(aiWordIntervals);
  const finalWordSeconds = duration(finalWordIntervals);
  const silencePeriods = normalizeIntervals(readJson(silenceFile));
  const peaks = readJson(peaksFile);
  const durationSeconds = findDuration(words, peaks);
  const cutSafety = validateCutSafety(log, words, silencePeriods, durationSeconds);
  const finalWordSet = new Set(log.finalSelected.filter(index => words[index] && !words[index].isGap));
  const aiWordSet = new Set(log.aiSelected.filter(index => words[index] && !words[index].isGap));
  const aiOnlyWords = [...aiWordSet].filter(index => !finalWordSet.has(index)).length;
  const userOnlyWords = [...finalWordSet].filter(index => !aiWordSet.has(index)).length;

  return {
    variant,
    asr: manifest.variants[variant].asr,
    transcript: {
      totalElements: words.length,
      spokenWords: words.filter(word => !word.isGap).length,
      gaps: words.filter(word => word.isGap).length,
    },
    semanticSelection: {
      aiSelectedWords: aiWordSet.size,
      finalSelectedWords: finalWordSet.size,
      aiOnlyWords,
      userOnlyWords,
      candidateIntervals: aiWordIntervals,
      finalWordIntervals,
      candidateSeconds: +candidateSeconds.toFixed(3),
      finalWordSeconds: +finalWordSeconds.toFixed(3),
      matchedSeconds: +matchedSeconds.toFixed(3),
      precisionPercent: percentage(matchedSeconds, candidateSeconds),
      recallPercent: percentage(matchedSeconds, finalWordSeconds),
    },
    finalDelete: {
      intervals: finalDeleteIntervals,
      seconds: +duration(finalDeleteIntervals).toFixed(3),
      segments: finalDeleteIntervals.length,
    },
    reviewSession: log.reviewSession || null,
    cutSafety,
  };
}

function fmt(value, suffix = '') {
  return value === null || value === undefined ? '—' : `${value}${suffix}`;
}

function reportMarkdown(manifest, variants) {
  const [a, b] = variants;
  const rows = [
    ['ASR', `${a.asr.engine} (${a.asr.resourceId})`, `${b.asr.engine} (${b.asr.resourceId})`],
    ['转录发音单元', a.transcript.spokenWords, b.transcript.spokenWords],
    ['AI 预选口误词', a.semanticSelection.aiSelectedWords, b.semanticSelection.aiSelectedWords],
    ['最终删除口误词', a.semanticSelection.finalSelectedWords, b.semanticSelection.finalSelectedWords],
    ['人工撤销（AI 多选）', a.semanticSelection.aiOnlyWords, b.semanticSelection.aiOnlyWords],
    ['人工补删（AI 漏选）', a.semanticSelection.userOnlyWords, b.semanticSelection.userOnlyWords],
    ['候选精确率（源时间轴）', fmt(a.semanticSelection.precisionPercent, '%'), fmt(b.semanticSelection.precisionPercent, '%')],
    ['候选召回率（源时间轴）', fmt(a.semanticSelection.recallPercent, '%'), fmt(b.semanticSelection.recallPercent, '%')],
    ['最终删除时长', fmt(a.finalDelete.seconds, 's'), fmt(b.finalDelete.seconds, 's')],
    ['审核时长', fmt(a.reviewSession && a.reviewSession.durationSeconds, 's'), fmt(b.reviewSession && b.reviewSession.durationSeconds, 's')],
    ['审核编辑次数', fmt(a.reviewSession && a.reviewSession.editCount), fmt(b.reviewSession && b.reviewSession.editCount)],
    ['保留语音被切断', a.cutSafety.keptWordBoundaryViolations, b.cutSafety.keptWordBoundaryViolations],
    ['保留片段重叠', a.cutSafety.sourceClipOverlaps, b.cutSafety.sourceClipOverlaps],
  ];
  return [
    '# 完整模型 A/B 对比结果',
    '',
    `- Run：${manifest.runId}`,
    `- 共享音频 SHA-256：\`${manifest.source.sharedAudioSha256}\``,
    `- 合同：规则、经验规则和 skill 已在本次运行开始时冻结快照。`,
    '',
    '| 指标 | A | B |',
    '| --- | ---: | ---: |',
    ...rows.map(([name, av, bv]) => `| ${name} | ${av} | ${bv} |`),
    '',
    '## 解读边界',
    '',
    '- 候选精确率 / 召回率以同一位审核者最终选择的源时间区间为参照，不按 ASR 的词索引比较。',
    '- 数值用于辅助判断，不自动宣布赢家；须同时检查关键重说案例、专有名词和实际听感。',
    '- 任一“保留语音被切断”或“保留片段重叠”非零时，本次结果不得作为默认模型切换依据。',
    '',
  ].join('\n');
}

function main() {
  const [abDirInput] = process.argv.slice(2);
  if (!abDirInput || abDirInput === '--help') {
    console.log('用法: node compare_model_ab.js <ab_output_dir>');
    return abDirInput === '--help' ? 0 : 1;
  }
  const abDir = path.resolve(abDirInput);
  const manifestFile = path.join(abDir, 'manifest.json');
  if (!fs.existsSync(manifestFile)) fail(`找不到 manifest.json：${manifestFile}`);
  const manifest = readJson(manifestFile);
  if (!manifest.variants || !manifest.variants.A || !manifest.variants.B) fail('manifest.json 缺少 A/B 变体定义');
  const variants = ['A', 'B'].map(variant => scoreVariant(abDir, variant, manifest));
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runId: manifest.runId,
    source: manifest.source,
    contract: manifest.contract,
    variants,
  };
  const outDir = path.join(abDir, 'comparison');
  writeJson(path.join(outDir, 'model_ab_comparison.json'), result);
  fs.writeFileSync(path.join(outDir, 'model_ab_comparison.md'), `${reportMarkdown(manifest, variants)}\n`);
  console.log(`✅ A/B 对比已写入 ${outDir}`);
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`❌ A/B 对比失败：${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  duration,
  intersectionDuration,
  intervalsFromSelectedIndices,
  normalizeIntervals,
  scoreVariant,
  validateCutSafety,
};
