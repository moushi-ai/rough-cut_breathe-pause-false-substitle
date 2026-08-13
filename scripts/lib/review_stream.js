'use strict';

/**
 * 长口播的增量审核合同。
 *
 * 转录仍然一次性完成，但语义口误分析可以按「完整句子 + 上下文」分批交付。
 * 这个模块是分段规划、每批选择校验、审核状态增量合并的单一来源，供 CLI、
 * 审核服务和测试共同使用，避免前后端各自猜测批次边界。
 */

const fs = require('fs');
const path = require('path');

const STREAM_SCHEMA_VERSION = 1;
const DEFAULT_CHUNK_OPTIONS = Object.freeze({
  targetSeconds: 120,
  minSeconds: 90,
  maxSeconds: 150,
  preferredGapSeconds: 0.4,
  contextSeconds: 12,
  streamThresholdSeconds: 120,
});

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function assertArray(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} 必须是数组`);
}

function getTimelineDuration(words) {
  assertArray(words, 'words');
  return words.reduce((max, word) => Math.max(max, finiteNumber(word?.end, 0)), 0);
}

function sentenceText(words, sentence) {
  let text = '';
  for (let idx = sentence.startIdx; idx <= sentence.endIdx; idx++) {
    const word = words[idx];
    if (word && !word.isGap) text += String(word.text || '');
  }
  return text;
}

function getSentenceInfos(words, sentenceMap) {
  assertArray(words, 'words');
  assertArray(sentenceMap, 'sentenceMap');

  return sentenceMap.map((sentence, index) => {
    const startIdx = Number(sentence?.startIdx);
    const endIdx = Number(sentence?.endIdx);
    if (!Number.isInteger(startIdx) || !Number.isInteger(endIdx) || startIdx < 0 || endIdx < startIdx || endIdx >= words.length) {
      throw new RangeError(`句${index} 的 idx 范围无效`);
    }
    const startWord = words[startIdx];
    const endWord = words[endIdx];
    const start = finiteNumber(startWord?.start);
    const end = finiteNumber(endWord?.end);
    if (start === null || end === null || end < start) {
      throw new RangeError(`句${index} 的时间范围无效`);
    }
    return {
      sentence: index,
      startIdx,
      endIdx,
      start,
      end,
      text: sentenceText(words, sentence),
    };
  });
}

function boundaryGapSeconds(left, right) {
  return Math.max(0, right.start - left.end);
}

function isHardRestartSignal(text) {
  const normalized = String(text || '').replace(/[\s，。！？、；：,.!?;:]/g, '');
  return /(?:321|三二一)/.test(normalized) || normalized === '停';
}

function buildBlockedBoundaries(sentenceInfos, restartCandidates) {
  const blocked = new Set();
  const lastBoundary = sentenceInfos.length - 2;
  const candidates = Array.isArray(restartCandidates?.candidates) ? restartCandidates.candidates : [];

  // 候选重录的草稿与最终重说跨越某个句界时，不把该句界当作批次边界。
  for (const candidate of candidates) {
    const source = Number(candidate?.sourceSentence);
    const restart = Number(candidate?.restartSentence);
    if (!Number.isInteger(source) || !Number.isInteger(restart)) continue;
    const first = Math.min(source, restart);
    const last = Math.max(source, restart);
    for (let boundary = first; boundary < last; boundary++) {
      if (boundary >= 0 && boundary <= lastBoundary) blocked.add(boundary);
    }
  }

  // 321 / 三二一 / 停是强重录信号：信号本身以及紧邻句界都不要作为交接处。
  for (const info of sentenceInfos) {
    if (!isHardRestartSignal(info.text)) continue;
    for (let boundary = Math.max(0, info.sentence - 1); boundary <= Math.min(lastBoundary, info.sentence + 1); boundary++) {
      blocked.add(boundary);
    }
  }

  return blocked;
}

function chooseNearest(candidates, targetSeconds) {
  if (candidates.length === 0) return null;
  return candidates.slice().sort((left, right) => (
    Math.abs(left.duration - targetSeconds) - Math.abs(right.duration - targetSeconds) ||
    right.gapSeconds - left.gapSeconds ||
    left.boundarySentence - right.boundarySentence
  ))[0];
}

function makeRange(infos, startSentence, endSentence) {
  const first = infos[startSentence];
  const last = infos[endSentence];
  return {
    startSentence,
    endSentence,
    startIdx: first.startIdx,
    endIdx: last.endIdx,
    startTime: first.start,
    endTime: last.end,
  };
}

function makeContextRange(infos, core, contextSeconds) {
  let startSentence = core.startSentence;
  let endSentence = core.endSentence;
  const startLimit = core.startTime - contextSeconds;
  const endLimit = core.endTime + contextSeconds;

  while (startSentence > 0 && infos[startSentence - 1].end >= startLimit) startSentence--;
  while (endSentence < infos.length - 1 && infos[endSentence + 1].start <= endLimit) endSentence++;
  return makeRange(infos, startSentence, endSentence);
}

/**
 * 按完整句子规划审核批次。一个 chunk 的 core 不重叠；context 只供语义判断，
 * 不能写入邻居 chunk 的选择。
 */
function planReviewChunks({ words, sentenceMap, restartCandidates, options = {} }) {
  const config = { ...DEFAULT_CHUNK_OPTIONS, ...options };
  const infos = getSentenceInfos(words, sentenceMap);
  const durationSeconds = getTimelineDuration(words);
  const mode = durationSeconds >= config.streamThresholdSeconds ? 'streaming' : 'single';

  if (infos.length === 0) {
    return {
      schemaVersion: STREAM_SCHEMA_VERSION,
      generatedBy: 'plan_review_chunks.js',
      mode,
      durationSeconds,
      config,
      chunks: [],
    };
  }

  const blocked = buildBlockedBoundaries(infos, restartCandidates);
  const chunks = [];
  let startSentence = 0;
  const finalSentence = infos.length - 1;

  while (startSentence <= finalSentence) {
    const startInfo = infos[startSentence];
    const totalRemaining = infos[finalSentence].end - startInfo.start;
    let endSentence = finalSentence;
    let boundary = null;

    // 短视频与最后一个不超过最大长度的尾段保持一个完整批次。
    if (mode === 'streaming' && totalRemaining > config.maxSeconds && startSentence < finalSentence) {
      const candidates = [];
      for (let candidateSentence = startSentence; candidateSentence < finalSentence; candidateSentence++) {
        const left = infos[candidateSentence];
        const right = infos[candidateSentence + 1];
        candidates.push({
          boundarySentence: candidateSentence,
          duration: left.end - startInfo.start,
          gapSeconds: boundaryGapSeconds(left, right),
          blocked: blocked.has(candidateSentence),
        });
      }

      const inWindow = candidates.filter(candidate => (
        candidate.duration >= config.minSeconds && candidate.duration <= config.maxSeconds
      ));
      const safeWindow = inWindow.filter(candidate => !candidate.blocked);
      const preferred = safeWindow.filter(candidate => candidate.gapSeconds >= config.preferredGapSeconds);
      boundary = chooseNearest(preferred, config.targetSeconds) ||
        chooseNearest(safeWindow, config.targetSeconds);

      // 极端 ASR（长句、连续口令）找不到窗口时，宁可略微超出目标，也不从句子中间切。
      if (!boundary) {
        const safeOverflow = candidates.filter(candidate => !candidate.blocked && candidate.duration >= config.minSeconds);
        boundary = chooseNearest(safeOverflow, config.targetSeconds);
      }
      if (!boundary) {
        const fallbackWindow = inWindow;
        boundary = chooseNearest(fallbackWindow, config.targetSeconds) ||
          chooseNearest(candidates.filter(candidate => candidate.duration >= config.minSeconds), config.targetSeconds) ||
          candidates[candidates.length - 1];
      }

      if (boundary) endSentence = boundary.boundarySentence;
    }

    const core = makeRange(infos, startSentence, endSentence);
    const context = makeContextRange(infos, core, config.contextSeconds);
    const isFinal = endSentence === finalSentence;
    const boundaryMeta = isFinal ? {
      kind: 'end-of-video',
      gapSeconds: 0,
      safe: true,
    } : {
      kind: boundary.blocked ? 'complete-sentence-fallback' :
        (boundary.gapSeconds >= config.preferredGapSeconds ? 'natural-pause' : 'complete-sentence'),
      afterSentence: endSentence,
      beforeSentence: endSentence + 1,
      gapSeconds: +boundary.gapSeconds.toFixed(3),
      safe: !boundary.blocked,
    };

    chunks.push({
      id: `chunk-${String(chunks.length + 1).padStart(3, '0')}`,
      order: chunks.length + 1,
      core,
      context,
      boundary: boundaryMeta,
    });

    if (isFinal) break;
    startSentence = endSentence + 1;
  }

  return {
    schemaVersion: STREAM_SCHEMA_VERSION,
    generatedBy: 'plan_review_chunks.js',
    mode,
    durationSeconds: +durationSeconds.toFixed(3),
    config,
    chunks,
  };
}

function normalizeErrors(rawErrors) {
  const isLegacy = Array.isArray(rawErrors);
  return {
    deleteSentences: isLegacy ? rawErrors : (Array.isArray(rawErrors?.delete_sentences) ? rawErrors.delete_sentences : []),
    deleteIdx: isLegacy ? [] : (Array.isArray(rawErrors?.delete_idx) ? rawErrors.delete_idx : []),
  };
}

function expandErrorSelection(sentenceMap, rawErrors, { strict = false } = {}) {
  assertArray(sentenceMap, 'sentenceMap');
  const { deleteSentences, deleteIdx } = normalizeErrors(rawErrors);
  const selected = new Set();
  const invalidSentences = [];
  const invalidIdx = [];

  for (const sentenceNumber of deleteSentences) {
    if (!Number.isInteger(sentenceNumber) || sentenceNumber < 0 || sentenceNumber >= sentenceMap.length) {
      invalidSentences.push(sentenceNumber);
      continue;
    }
    const sentence = sentenceMap[sentenceNumber];
    for (let idx = sentence.startIdx; idx <= sentence.endIdx; idx++) selected.add(idx);
  }
  for (const idx of deleteIdx) {
    if (!Number.isInteger(idx) || idx < 0) {
      invalidIdx.push(idx);
      continue;
    }
    selected.add(idx);
  }

  if (strict && (invalidSentences.length || invalidIdx.length)) {
    throw new RangeError(`删除清单含无效值：句号 ${invalidSentences.join(',') || '无'}；idx ${invalidIdx.join(',') || '无'}`);
  }
  return {
    selected: [...selected].sort((a, b) => a - b),
    deleteSentences,
    deleteIdx,
    invalidSentences,
    invalidIdx,
  };
}

function findChunk(review, chunkId) {
  const chunk = review?.chunks?.find(item => item.id === chunkId);
  if (!chunk) throw new Error(`审核状态中找不到批次：${chunkId}`);
  return chunk;
}

function validateChunkSelection({ words, sentenceMap, chunk, rawErrors }) {
  const { deleteSentences, deleteIdx } = normalizeErrors(rawErrors);
  const core = chunk?.core;
  if (!core) throw new Error(`批次 ${chunk?.id || '未知'} 缺少 core 范围`);

  for (const sentenceNumber of deleteSentences) {
    if (!Number.isInteger(sentenceNumber) || sentenceNumber < core.startSentence || sentenceNumber > core.endSentence) {
      throw new RangeError(`批次 ${chunk.id} 只能提交 core 句${core.startSentence}–${core.endSentence}，不能写句${sentenceNumber}`);
    }
  }
  for (const idx of deleteIdx) {
    if (!Number.isInteger(idx) || idx < core.startIdx || idx > core.endIdx) {
      throw new RangeError(`批次 ${chunk.id} 只能提交 core idx ${core.startIdx}–${core.endIdx}，不能写 idx ${idx}`);
    }
  }

  const expanded = expandErrorSelection(sentenceMap, rawErrors, { strict: true });
  for (const idx of expanded.selected) {
    if (idx < core.startIdx || idx > core.endIdx || !words[idx] || words[idx].isGap) {
      throw new RangeError(`批次 ${chunk.id} 的选择 idx ${idx} 不属于可删除的 core 台词`);
    }
  }
  return expanded.selected;
}

function createStreamingReviewState(manifest) {
  if (!manifest || manifest.mode !== 'streaming') {
    throw new Error('只有 streaming 分段清单可以创建流式审核状态');
  }
  const chunks = Array.isArray(manifest.chunks) ? manifest.chunks : [];
  return {
    schemaVersion: STREAM_SCHEMA_VERSION,
    mode: 'streaming',
    revision: 0,
    status: chunks.length === 0 ? 'complete' : 'analyzing',
    updatedAt: new Date().toISOString(),
    completedAt: chunks.length === 0 ? new Date().toISOString() : null,
    targetSeconds: manifest.config?.targetSeconds || DEFAULT_CHUNK_OPTIONS.targetSeconds,
    chunks: chunks.map((chunk, index) => ({
      ...chunk,
      status: index === 0 ? 'analyzing' : 'pending',
      selected: [],
      selectedCount: 0,
      completedAt: null,
    })),
  };
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function publishChunkSelection(data, { chunkId, selected, replace = false, publishedAt = new Date().toISOString() }) {
  if (!data?.review || data.review.mode !== 'streaming') {
    throw new Error('审核 data.json 不是流式模式，不能增量发布批次');
  }
  if (!Array.isArray(selected)) throw new TypeError('selected 必须是数组');

  const next = JSON.parse(JSON.stringify(data));
  const review = next.review;
  const chunk = findChunk(review, chunkId);
  const normalizedSelected = [...new Set(selected)].sort((a, b) => a - b);

  if (chunk.status === 'ready' && !replace) {
    if (arraysEqual(chunk.selected || [], normalizedSelected)) return { data: next, changed: false, chunk };
    throw new Error(`批次 ${chunkId} 已发布；若需更正请显式使用 --replace`);
  }

  chunk.status = 'ready';
  chunk.selected = normalizedSelected;
  chunk.selectedCount = normalizedSelected.length;
  chunk.completedAt = publishedAt;

  // 顺序分析时，上一批完成立即把下一批标成「分析中」，让审核页如实显示进度。
  if (!review.chunks.some(item => item.status === 'analyzing')) {
    const nextPending = review.chunks.find(item => item.status === 'pending');
    if (nextPending) nextPending.status = 'analyzing';
  }

  const allReady = review.chunks.every(item => item.status === 'ready');
  review.status = allReady ? 'complete' : 'analyzing';
  review.revision = Math.max(0, Number(review.revision) || 0) + 1;
  review.updatedAt = publishedAt;
  review.completedAt = allReady ? publishedAt : null;

  const base = Array.isArray(next.baseAutoSelected) ? next.baseAutoSelected : [];
  const aggregate = new Set(base);
  for (const item of review.chunks) {
    for (const idx of item.selected || []) aggregate.add(idx);
  }
  next.autoSelected = [...aggregate].sort((a, b) => a - b);
  next.generatedAt = publishedAt;

  return { data: next, changed: true, chunk };
}

function getPublicReviewState(data) {
  const review = data?.review;
  if (!review || review.mode !== 'streaming') {
    return { schemaVersion: STREAM_SCHEMA_VERSION, mode: 'single', revision: 0, status: 'complete', chunks: [] };
  }
  return {
    schemaVersion: STREAM_SCHEMA_VERSION,
    mode: 'streaming',
    revision: Number(review.revision) || 0,
    status: review.status === 'complete' ? 'complete' : 'analyzing',
    updatedAt: review.updatedAt || null,
    completedAt: review.completedAt || null,
    targetSeconds: review.targetSeconds || DEFAULT_CHUNK_OPTIONS.targetSeconds,
    chunks: (review.chunks || []).map(chunk => ({
      id: chunk.id,
      order: chunk.order,
      status: chunk.status,
      selectedCount: Number(chunk.selectedCount) || 0,
      core: chunk.core,
      boundary: chunk.boundary,
      completedAt: chunk.completedAt || null,
    })),
  };
}

function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  const text = JSON.stringify(value, null, 2) + '\n';
  try {
    fs.writeFileSync(tempPath, text);
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch (_) { /* no-op */ }
    throw error;
  }
}

module.exports = {
  DEFAULT_CHUNK_OPTIONS,
  STREAM_SCHEMA_VERSION,
  createStreamingReviewState,
  expandErrorSelection,
  getPublicReviewState,
  getSentenceInfos,
  getTimelineDuration,
  isHardRestartSignal,
  normalizeErrors,
  planReviewChunks,
  publishChunkSelection,
  validateChunkSelection,
  writeJsonAtomic,
};
