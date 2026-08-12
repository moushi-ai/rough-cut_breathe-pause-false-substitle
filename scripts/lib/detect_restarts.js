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
  // ASR 可能在完整重说前插入人名、引导词或一两个错词；保留足够窗口给语义层复核。
  maxRestartPrefixSkip: 24,
  maxInlineSentenceTokens: 320,
});

const NON_LEXICAL = new Set(['啊', '呀', '呢', '吧', '嘛', '哦', '噢', '哎', '诶', '欸', '嗯', '呃', '额']);
const PRONOUN_EQUIVALENTS = new Set(['他', '她', '它']);

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

function makeSentence(words, sentence, sentenceIndex) {
  const tokens = [];
  for (let idx = sentence.startIdx; idx <= sentence.endIdx; idx++) {
    const word = words[idx];
    if (!word || word.isGap) continue;
    const text = String(word.text || '');
    const normalized = normalizeToken(text);
    if (!normalized) continue;
    tokens.push({ idx, text, normalized, matchKey: matchKey(normalized) });
  }
  return {
    sentenceIndex,
    tokens,
    // 语气词可保留在原文和建议范围中，但不应把同一表达式的长重说拆断。
    matchTokens: tokens.filter(isContent),
    text: joinTokens(tokens),
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

function findBestNearbySentenceRestart(source, restart, options) {
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
        kind: 'nearby-sentence-restart',
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
  }

  candidates.sort((a, b) => (
    a.suggestedDelete.startIdx - b.suggestedDelete.startIdx ||
    a.restartAnchor.startIdx - b.restartAnchor.startIdx
  ));
  return {
    schemaVersion: 1,
    generatedBy: 'detect_restarts.js',
    strategy: 'suffix-prefix-and-inline-repeat-v1',
    candidates: candidates.map(stripPrivateFields),
  };
}

module.exports = {
  DEFAULT_OPTIONS,
  detectRestartCandidates,
};
