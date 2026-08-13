'use strict';

/**
 * 找出“先说草稿、随后更完整重说”的待审核线索。
 *
 * 这是一个高召回、非破坏性的预检测器：它绝不写 delete_idx，也不修改
 * auto_selected.json。它输出的范围只供语义分析阶段核听和判断，避免把
 * 词面重复、列举或固定说法直接误剪掉。
 */

const DEFAULT_OPTIONS = Object.freeze({
  minOverlapTokens: 5,
  minOverlapCharacters: 8,
  minLaterExtensionTokens: 3,
  maxSourceTrailingContentTokens: 1,
  maxFollowingSentences: 3,
  // 倒数口令是强重录分隔符。只扩大“待审核线索”的搜索范围，不会直接删除任何内容。
  maxCueSeparatedSentences: 12,
  // ASR 可能在完整重说前插入人名、引导词或一两个错词；保留足够窗口给语义层复核。
  maxRestartPrefixSkip: 24,
  maxInlineSentenceTokens: 320,
});

const NON_LEXICAL = new Set(['啊', '呀', '呢', '吧', '嘛', '哦', '噢', '哎', '诶', '欸', '嗯', '呃', '额']);
const PRONOUN_EQUIVALENTS = new Set(['他', '她', '它']);
const CUE_UNITS = new Set(['年', '月', '日', '天', '个', '次', '位', '人', '元', '块', '万', '亿', '吨', '米', '秒', '分', '小', '%', '％']);

function normalizeToken(text) {
  return String(text || '')
    .trim()
    .toLocaleLowerCase()
    .replace(/[，。！？、；：,.!?;:]/g, '');
}

function matchKey(normalized) {
  return PRONOUN_EQUIVALENTS.has(normalized) ? 'pronoun' : normalized;
}

function isContent(token) {
  return Boolean(token?.normalized) && !NON_LEXICAL.has(token.normalized);
}

function countContent(tokens) {
  return tokens.reduce((count, token) => count + (isContent(token) ? 1 : 0), 0);
}

function joinTokens(tokens) {
  return tokens.map(token => token.text).join('');
}

function isArabicNumber(text) {
  return /^\d+$/.test(String(text || ''));
}

function isAsciiLetter(text) {
  return /^[A-Za-z]+$/.test(String(text || ''));
}

function hasFactNumberContext(tokens, start, width) {
  const before = tokens[start - 1]?.text;
  const after = tokens[start + width]?.text;
  return isArabicNumber(before) || isArabicNumber(after) || isAsciiLetter(before) || isAsciiLetter(after) || CUE_UNITS.has(after);
}

function recordingCueTokenPositions(tokens) {
  const positions = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.isRecordingCue) {
      positions.push(index);
      continue;
    }
    if ((token.text === '321' || token.text === '三二一') && !hasFactNumberContext(tokens, index, 1)) {
      positions.push(index);
      continue;
    }
    const chineseCue = token.text === '三' && tokens[index + 1]?.text === '二' && tokens[index + 2]?.text === '一';
    const asciiCue = token.text === '3' && tokens[index + 1]?.text === '2' && tokens[index + 2]?.text === '1';
    if ((chineseCue || asciiCue) && !hasFactNumberContext(tokens, index, 3)) {
      positions.push(index, index + 1, index + 2);
      index += 2;
    }
  }
  return positions;
}

function makeSentence(words, sentence, sentenceIndex) {
  const tokens = [];
  for (let idx = sentence.startIdx; idx <= sentence.endIdx; idx++) {
    const word = words[idx];
    if (!word || word.isGap) continue;
    const text = String(word.text || '');
    const normalized = normalizeToken(text);
    if (!normalized) continue;
    tokens.push({ idx, text, normalized, matchKey: matchKey(normalized), isRecordingCue: word.isRecordingCue === true });
  }
  const cuePositions = recordingCueTokenPositions(tokens);
  const cuePositionSet = new Set(cuePositions);
  return {
    sentenceIndex,
    tokens,
    // 语气词可保留在原文和建议范围中，但不应把同一表达式的长重说拆断。
    matchTokens: tokens.filter((token, position) => isContent(token) && !cuePositionSet.has(position)),
    text: joinTokens(tokens),
    recordingCues: cuePositions.map(position => ({ idx: tokens[position].idx, text: tokens[position].text })),
  };
}

function consecutiveRun(left, leftStart, right, rightStart) {
  const matched = [];
  while (
    leftStart + matched.length < left.length &&
    rightStart + matched.length < right.length &&
    left[leftStart + matched.length].matchKey === right[rightStart + matched.length].matchKey
  ) {
    matched.push(left[leftStart + matched.length]);
  }
  return matched;
}

function isQualifiedOverlap(matched, options) {
  return matched.length >= options.minOverlapTokens &&
    joinTokens(matched).length >= options.minOverlapCharacters;
}

function candidateConfidence(matched, laterExtension) {
  return matched.length >= 10 && countContent(laterExtension) >= 4 ? 'high' : 'medium';
}

function candidateScore(candidate) {
  return candidate.overlapCharacters * 100 + candidate.laterExtensionTokens * 10 - candidate.restartAnchor.startIdx / 1000000;
}

function buildCandidate({ kind, source, restart, sourceStartToken, suggestedEndToken, restartStartToken, restartEndToken, matched, laterExtension }) {
  const overlapText = joinTokens(matched);
  const candidate = {
    kind,
    sourceSentence: source.sentenceIndex,
    restartSentence: restart.sentenceIndex,
    suggestedDelete: {
      startIdx: sourceStartToken.idx,
      endIdx: suggestedEndToken.idx,
    },
    sourceSentenceRange: {
      startIdx: source.tokens[0].idx,
      endIdx: source.tokens[source.tokens.length - 1].idx,
    },
    sourceAnchor: {
      startIdx: sourceStartToken.idx,
      endIdx: matched[matched.length - 1].idx,
    },
    restartAnchor: {
      startIdx: restartStartToken.idx,
      endIdx: restartEndToken.idx,
    },
    overlapText,
    overlapTokenCount: matched.length,
    overlapCharacters: overlapText.length,
    laterExtensionTokens: countContent(laterExtension),
    sourceText: source.text,
    restartText: restart.text,
    confidence: candidateConfidence(matched, laterExtension),
    reviewInstruction: '仅作待审核线索：suggestedDelete 是重复锚点的初始范围，先结合 sourceSentenceRange 回听确认草稿的完整起止；前段确为草稿/残句、后段更完整时才写 delete_idx。普通重复、列举、固定说法或语义不确定时不打删除标。',
  };
  candidate._score = candidateScore(candidate);
  return candidate;
}

function findBestNearbySentenceRestart(source, restart, options, kind = 'nearby-sentence-restart') {
  let best = null;
  const sourceTokens = source.matchTokens;
  const restartTokens = restart.matchTokens;
  const maxRestartStart = Math.min(options.maxRestartPrefixSkip, restartTokens.length - options.minOverlapTokens);
  for (let sourceStart = 0; sourceStart <= sourceTokens.length - options.minOverlapTokens; sourceStart++) {
    for (let restartStart = 0; restartStart <= maxRestartStart; restartStart++) {
      const matched = consecutiveRun(sourceTokens, sourceStart, restartTokens, restartStart);
      if (!isQualifiedOverlap(matched, options)) continue;

      const sourceTail = sourceTokens.slice(sourceStart + matched.length);
      const laterExtension = restartTokens.slice(restartStart + matched.length);
      if (countContent(sourceTail) > options.maxSourceTrailingContentTokens) continue;
      if (countContent(laterExtension) < options.minLaterExtensionTokens) continue;

      const candidate = buildCandidate({
        kind,
        source,
        restart,
        sourceStartToken: sourceTokens[sourceStart],
        suggestedEndToken: source.tokens[source.tokens.length - 1],
        restartStartToken: restartTokens[restartStart],
        restartEndToken: restartTokens[restartStart + matched.length - 1],
        matched,
        laterExtension,
      });
      if (!best || candidate._score > best._score) best = candidate;
    }
  }
  return best;
}

function cuesBetween(source, restart, recordingCues) {
  const sourceEndIdx = source.tokens[source.tokens.length - 1]?.idx;
  const restartEndIdx = restart.tokens[restart.tokens.length - 1]?.idx;
  if (!Number.isInteger(sourceEndIdx) || !Number.isInteger(restartEndIdx)) return [];
  // 允许口令位于后一版的开头（如“321但问题是……”），此时它仍是两版之间的分隔符。
  return recordingCues.filter(cue => cue.idx > sourceEndIdx && cue.idx <= restartEndIdx);
}

function applyCueSignal(candidate, cues) {
  if (!candidate) return null;
  candidate.recordingCue = {
    strength: 'strong',
    indices: cues.map(cue => cue.idx),
    text: cues.map(cue => cue.text).join(''),
  };
  candidate.reviewInstruction = '倒数口令是强重录分隔信号：仅作待审核线索。先确认后一版更完整、前一版没有独有信息，才把前段写入 delete_idx；即使候选跨多句，也不得跳过语义确认。';
  return candidate;
}

function findBestInlineRestart(sentence, options) {
  const tokens = sentence.matchTokens;
  if (tokens.length > options.maxInlineSentenceTokens) return null;

  let best = null;
  for (let sourceStart = 0; sourceStart <= tokens.length - options.minOverlapTokens; sourceStart++) {
    for (let restartStart = sourceStart + options.minOverlapTokens; restartStart <= tokens.length - options.minOverlapTokens; restartStart++) {
      const matched = consecutiveRun(tokens, sourceStart, tokens, restartStart);
      if (!isQualifiedOverlap(matched, options)) continue;
      // 两段必须不重叠；否则只是“我们我们”式的自身滑动匹配。
      if (restartStart < sourceStart + matched.length) continue;

      const laterExtension = tokens.slice(restartStart + matched.length);
      if (countContent(laterExtension) < options.minLaterExtensionTokens) continue;

      const candidate = buildCandidate({
        kind: 'inline-restart',
        source: sentence,
        restart: sentence,
        sourceStartToken: tokens[sourceStart],
        suggestedEndToken: tokens[sourceStart + matched.length - 1],
        restartStartToken: tokens[restartStart],
        restartEndToken: tokens[restartStart + matched.length - 1],
        matched,
        laterExtension,
      });
      if (!best || candidate._score > best._score) best = candidate;
    }
  }
  return best;
}

function stripPrivateFields(candidate) {
  const { _score, ...publicCandidate } = candidate;
  return publicCandidate;
}

function detectRestartCandidates({ words, sentenceMap, options = {} }) {
  if (!Array.isArray(words)) throw new TypeError('words 必须是数组');
  if (!Array.isArray(sentenceMap)) throw new TypeError('sentenceMap 必须是数组');
  const config = { ...DEFAULT_OPTIONS, ...options };
  const sentences = sentenceMap.map((sentence, index) => makeSentence(words, sentence, index));
  const recordingCues = sentences.flatMap(sentence => sentence.recordingCues);
  const candidates = [];

  for (let index = 0; index < sentences.length; index++) {
    const source = sentences[index];
    const inline = findBestInlineRestart(source, config);
    if (inline) candidates.push(inline);

    let bestNearby = null;
    for (let restartIndex = index + 1; restartIndex <= Math.min(sentences.length - 1, index + config.maxFollowingSentences); restartIndex++) {
      const candidate = findBestNearbySentenceRestart(source, sentences[restartIndex], config);
      if (!candidate) continue;
      if (!bestNearby || candidate._score > bestNearby._score) bestNearby = candidate;
    }
    if (bestNearby) candidates.push(bestNearby);

    let bestCueSeparated = null;
    const maxCueRestartIndex = Math.min(sentences.length - 1, index + config.maxCueSeparatedSentences);
    for (let restartIndex = index + 1; restartIndex <= maxCueRestartIndex; restartIndex++) {
      const restart = sentences[restartIndex];
      const cues = cuesBetween(source, restart, recordingCues);
      if (cues.length === 0) continue;
      const candidate = findBestNearbySentenceRestart(source, restart, config, 'cue-separated-restart');
      if (!candidate) continue;
      applyCueSignal(candidate, cues);
      if (!bestCueSeparated || candidate._score > bestCueSeparated._score) bestCueSeparated = candidate;
    }
    if (bestCueSeparated) candidates.push(bestCueSeparated);
  }

  // 同一对锚点既可能是普通邻句重说，也可能被倒数口令分隔。保留信号更强的后者，减少审核噪音。
  const deduplicated = new Map();
  for (const candidate of candidates) {
    const key = [
      candidate.sourceSentence,
      candidate.restartSentence,
      candidate.suggestedDelete.startIdx,
      candidate.suggestedDelete.endIdx,
      candidate.restartAnchor.startIdx,
      candidate.restartAnchor.endIdx,
    ].join(':');
    const existing = deduplicated.get(key);
    if (!existing || (candidate.kind === 'cue-separated-restart' && existing.kind !== 'cue-separated-restart')) {
      deduplicated.set(key, candidate);
    }
  }
  const uniqueCandidates = [...deduplicated.values()];
  uniqueCandidates.sort((a, b) => (
    a.suggestedDelete.startIdx - b.suggestedDelete.startIdx ||
    a.restartAnchor.startIdx - b.restartAnchor.startIdx
  ));
  return {
    schemaVersion: 1,
    generatedBy: 'detect_restarts.js',
    strategy: 'suffix-prefix-and-inline-repeat-with-recording-cue-v2',
    candidates: uniqueCandidates.map(stripPrivateFields),
  };
}

module.exports = {
  DEFAULT_OPTIONS,
  detectRestartCandidates,
};
