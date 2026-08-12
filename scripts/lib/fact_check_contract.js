#!/usr/bin/env node
/*
 * 字幕事实核验的可追溯合同。
 *
 * 模型只能提出候选，下面的纯本地逻辑负责：
 * 1. 校验候选确实落在当前校对文本的指定位置；
 * 2. 生成可人工批准的不可变快照；
 * 3. 只把已批准且未冲突的候选应用到字幕显示层。
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// v2：NUMBER 裸数字候选可携带首遍/二遍 ASR 与固定切片规则的声学复核证据。
const SCHEMA_VERSION = 2;
const ENTITY_TYPES = new Set(['PERSON', 'ORGANIZATION', 'COMPANY', 'PRODUCT', 'PLACE', 'AWARD', 'DATE', 'NUMBER', 'TERM', 'OTHER']);

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function now() {
  return new Date().toISOString();
}

function readJson(file, label = 'JSON') {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`无法读取 ${label}：${file} (${error.message})`);
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function nonEmptyLines(text) {
  const lines = String(text).split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function ensureCaptionInput(captionDir) {
  const correctedFile = path.join(captionDir, 'corrected.txt');
  const transcriptFile = path.join(captionDir, 'retained_transcript.json');
  if (!fs.existsSync(correctedFile)) fail(`找不到基础纠错字幕：${correctedFile}`);
  if (!fs.existsSync(transcriptFile)) fail(`找不到成片保留台词映射：${transcriptFile}`);
  const correctedText = fs.readFileSync(correctedFile, 'utf8');
  const correctedLines = nonEmptyLines(correctedText);
  const transcript = readJson(transcriptFile, 'retained_transcript.json');
  if (!Array.isArray(transcript.lines)) fail('retained_transcript.json 缺少 lines 数组');
  if (correctedLines.length !== transcript.lines.length) {
    fail(`corrected.txt 行数 (${correctedLines.length}) 与 retained_transcript.json 行数 (${transcript.lines.length}) 不一致；先修复基础纠错的 1:1 行对应关系`);
  }
  const lines = correctedLines.map((text, index) => ({
    line: index + 1,
    text,
    sourceText: String(transcript.lines[index].text || ''),
    sourceStart: transcript.lines[index].sourceStart,
    sourceEnd: transcript.lines[index].sourceEnd,
    sourceWordIndices: Array.isArray(transcript.lines[index].sourceWordIndices)
      ? transcript.lines[index].sourceWordIndices.slice()
      : [],
  }));
  return {
    captionDir: path.resolve(captionDir),
    correctedFile,
    correctedText,
    correctedLines,
    documentSha256: sha256(correctedText),
    lines,
    transcript,
  };
}

function compactContext(text, center, radius = 20) {
  const left = Math.max(0, center - radius);
  const right = Math.min(text.length, center + radius);
  return text.slice(left, right);
}

function buildSourceCharacters(document, sourceLine) {
  const retainedWords = Array.isArray(document.transcript.retainedWords) ? document.transcript.retainedWords : [];
  const wordBySourceIndex = new Map(retainedWords.map(word => [word.sourceIndex, word]));
  const characters = [];
  for (const sourceIndex of sourceLine.sourceWordIndices) {
    const word = wordBySourceIndex.get(sourceIndex);
    if (!word || typeof word.text !== 'string') return null;
    for (const character of word.text) characters.push({ character, sourceIndex, start: word.start, end: word.end });
  }
  if (characters.map(item => item.character).join('') !== sourceLine.sourceText) return null;
  return characters;
}

// 将基础纠错后的字符对齐回审核后保留的原始词。它只用于记录可追溯范围；
// 应用事实纠错仍以当前 corrected.txt 的精确字符范围为准。
function alignTargetToSource(sourceCharacters, targetText) {
  const source = sourceCharacters.map(item => item.character);
  const target = [...targetText];
  const rows = source.length + 1;
  const columns = target.length + 1;
  const costs = Array.from({ length: rows }, () => new Uint16Array(columns));
  for (let row = 0; row < rows; row++) costs[row][0] = row;
  for (let column = 0; column < columns; column++) costs[0][column] = column;
  for (let row = 1; row < rows; row++) {
    for (let column = 1; column < columns; column++) {
      const diagonal = costs[row - 1][column - 1] + (source[row - 1] === target[column - 1] ? 0 : 1);
      const removeSource = costs[row - 1][column] + 1;
      const addTarget = costs[row][column - 1] + 1;
      costs[row][column] = Math.min(diagonal, removeSource, addTarget);
    }
  }
  const mapping = Array(target.length).fill(null);
  let row = source.length;
  let column = target.length;
  while (row > 0 || column > 0) {
    const current = costs[row][column];
    const canDiagonal = row > 0 && column > 0
      && costs[row - 1][column - 1] + (source[row - 1] === target[column - 1] ? 0 : 1) === current;
    if (canDiagonal) {
      mapping[column - 1] = row - 1;
      row--;
      column--;
      continue;
    }
    if (row > 0 && costs[row - 1][column] + 1 === current) {
      row--;
      continue;
    }
    if (column > 0) {
      column--;
      continue;
    }
  }
  return mapping;
}

function codePointOffset(text, utf16Offset) {
  // locateOccurrence 使用 String#indexOf，返回的是 UTF-16 偏移；
  // 对齐表则按 Unicode code point 建立。把两者明确转换，避免 emoji 等
  // 代理对前后的位置记录错位。字幕真正应用时仍使用原始 UTF-16 偏移。
  return Array.from(String(text).slice(0, utf16Offset)).length;
}

function sourceReferenceForTargetSpan(document, sourceLine, targetText, charStart, charEnd) {
  const sourceCharacters = buildSourceCharacters(document, sourceLine);
  if (!sourceCharacters) {
    return {
      sourceStart: sourceLine.sourceStart,
      sourceEnd: sourceLine.sourceEnd,
      sourceWordIndices: sourceLine.sourceWordIndices,
      sourceMapping: 'line_fallback',
    };
  }
  const mapping = alignTargetToSource(sourceCharacters, targetText);
  const indexes = new Set();
  const targetStart = codePointOffset(targetText, charStart);
  const targetEnd = codePointOffset(targetText, charEnd);
  for (let index = targetStart; index < targetEnd; index++) {
    const sourceCharacterIndex = mapping[index];
    if (sourceCharacterIndex !== null && sourceCharacters[sourceCharacterIndex]) {
      indexes.add(sourceCharacters[sourceCharacterIndex].sourceIndex);
    }
  }
  // 纠错可能让某个字成为插入字；这时使用左右最近的原始字作为时间锚点。
  if (indexes.size === 0) {
    for (let index = targetStart - 1; index >= 0; index--) {
      if (mapping[index] !== null && sourceCharacters[mapping[index]]) {
        indexes.add(sourceCharacters[mapping[index]].sourceIndex);
        break;
      }
    }
    for (let index = targetEnd; index < mapping.length; index++) {
      if (mapping[index] !== null && sourceCharacters[mapping[index]]) {
        indexes.add(sourceCharacters[mapping[index]].sourceIndex);
        break;
      }
    }
  }
  const sourceWordIndices = [...indexes].sort((a, b) => a - b);
  const selectedCharacters = sourceCharacters.filter(item => sourceWordIndices.includes(item.sourceIndex));
  return {
    sourceStart: selectedCharacters.length > 0 ? selectedCharacters[0].start : sourceLine.sourceStart,
    sourceEnd: selectedCharacters.length > 0 ? selectedCharacters[selectedCharacters.length - 1].end : sourceLine.sourceEnd,
    sourceWordIndices: sourceWordIndices.length > 0 ? sourceWordIndices : sourceLine.sourceWordIndices,
    sourceMapping: sourceWordIndices.length > 0 ? 'aligned' : 'line_fallback',
  };
}

function findAll(text, needle) {
  const result = [];
  if (!needle) return result;
  let start = 0;
  while (start <= text.length - needle.length) {
    const index = text.indexOf(needle, start);
    if (index === -1) break;
    result.push(index);
    start = index + Math.max(needle.length, 1);
  }
  return result;
}

function locateOccurrence(lineText, rawOccurrence) {
  const mention = String(rawOccurrence && (rawOccurrence.mention || rawOccurrence.text) || '').trim();
  if (!mention) return { error: '候选 occurrence 缺少 mention' };
  const indexes = findAll(lineText, mention);
  if (indexes.length === 0) return { error: `文本中找不到“${mention}”` };

  const before = String(rawOccurrence.before || rawOccurrence.leftContext || '');
  const after = String(rawOccurrence.after || rawOccurrence.rightContext || '');
  const candidates = indexes.filter(index => {
    const hasBefore = !before || lineText.slice(Math.max(0, index - before.length), index).endsWith(before);
    const hasAfter = !after || lineText.slice(index + mention.length, index + mention.length + after.length).startsWith(after);
    return hasBefore && hasAfter;
  });
  const matched = candidates.length > 0 ? candidates : indexes;
  if (matched.length !== 1) {
    return { error: `“${mention}”在本行出现 ${matched.length} 次，缺少足够上下文，不能安全定位` };
  }
  const charStart = matched[0];
  return {
    mention,
    charStart,
    charEnd: charStart + mention.length,
    context: compactContext(lineText, charStart),
  };
}

function normalizeOccurrence(rawOccurrence, document) {
  const lineNumber = Number(rawOccurrence && rawOccurrence.line);
  if (!Number.isInteger(lineNumber) || lineNumber < 1 || lineNumber > document.lines.length) {
    return { error: `候选 occurrence 行号无效：${rawOccurrence && rawOccurrence.line}` };
  }
  const sourceLine = document.lines[lineNumber - 1];
  const located = locateOccurrence(sourceLine.text, rawOccurrence);
  if (located.error) return { error: `第 ${lineNumber} 行：${located.error}` };
  const sourceReference = sourceReferenceForTargetSpan(
    document,
    sourceLine,
    sourceLine.text,
    located.charStart,
    located.charEnd
  );
  return {
    line: lineNumber,
    mention: located.mention,
    charStart: located.charStart,
    charEnd: located.charEnd,
    context: located.context,
    ...sourceReference,
  };
}

function normalizeFactMap(rawMap, document) {
  if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) {
    fail('事实地图必须是 JSON 对象');
  }
  const rawCandidates = Array.isArray(rawMap.candidates) ? rawMap.candidates : [];
  const candidates = [];
  const issues = [];
  rawCandidates.forEach((rawCandidate, index) => {
    const name = String(rawCandidate && (rawCandidate.name || rawCandidate.entity || rawCandidate.canonicalCandidate) || '').trim();
    const rawVariants = Array.isArray(rawCandidate && rawCandidate.variants) ? rawCandidate.variants : [];
    const variants = [...new Set([name, ...rawVariants].map(value => String(value || '').trim()).filter(Boolean))];
    const rawOccurrences = Array.isArray(rawCandidate && rawCandidate.occurrences) ? rawCandidate.occurrences : [];
    if (!name || variants.length === 0 || rawOccurrences.length === 0) {
      issues.push({ index: index + 1, reason: '缺少名称、变体或出现位置，已跳过' });
      return;
    }
    const occurrences = [];
    for (const rawOccurrence of rawOccurrences) {
      const occurrence = normalizeOccurrence(rawOccurrence, document);
      if (occurrence.error) {
        issues.push({ index: index + 1, name, reason: occurrence.error });
      } else if (!variants.includes(occurrence.mention)) {
        issues.push({ index: index + 1, name, reason: `出现文本“${occurrence.mention}”不在候选变体中，已跳过` });
      } else {
        occurrences.push(occurrence);
      }
    }
    if (occurrences.length === 0) {
      issues.push({ index: index + 1, name, reason: '没有可安全定位的出现位置，已跳过' });
      return;
    }
    candidates.push({
      id: `FC-${String(candidates.length + 1).padStart(3, '0')}`,
      type: ENTITY_TYPES.has(String(rawCandidate && rawCandidate.type || '').toUpperCase())
        ? String(rawCandidate.type).toUpperCase()
        : 'OTHER',
      name,
      variants,
      risk: ['high', 'medium', 'low'].includes(String(rawCandidate && rawCandidate.risk || '').toLowerCase())
        ? String(rawCandidate.risk).toLowerCase()
        : 'high',
      factToVerify: String(rawCandidate && (rawCandidate.factToVerify || rawCandidate.reason) || '').trim(),
      queryHints: Array.isArray(rawCandidate && rawCandidate.queryHints)
        ? rawCandidate.queryHints.map(value => String(value || '').trim()).filter(Boolean)
        : [],
      occurrences,
    });
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    documentBrief: String(rawMap.documentBrief || rawMap.brief || '').trim(),
    topicKeywords: Array.isArray(rawMap.topicKeywords)
      ? rawMap.topicKeywords.map(value => String(value || '').trim()).filter(Boolean)
      : [],
    timeScope: String(rawMap.timeScope || '').trim(),
    candidates,
    normalizationIssues: issues,
  };
}

function normalizeSources(sources) {
  const seen = new Set();
  const normalized = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    const url = String(source && source.url || '').trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    normalized.push({
      url,
      title: String(source.title || '').trim(),
      snippet: String(source.snippet || source.evidence || '').trim().slice(0, 1000),
    });
  }
  return normalized;
}

function normalizeVerification(rawVerification, fallbackSources) {
  const raw = rawVerification && typeof rawVerification === 'object' ? rawVerification : {};
  const status = String(raw.status || raw.verificationStatus || '').toLowerCase();
  const answerFrom = String(raw.answerFrom || raw.sourceText || '').trim();
  const replacement = String(raw.replacement || raw.proposedText || raw.canonicalName || '').trim();
  const confidence = Number(raw.confidence);
  const sources = normalizeSources([...(Array.isArray(raw.sources) ? raw.sources : []), ...(fallbackSources || [])]);
  const validProposal = status === 'proposed'
    && replacement.length > 0
    && Number.isFinite(confidence)
    && confidence >= 0
    && confidence <= 1
    && sources.length > 0;
  const validNoChange = status === 'verified_no_change'
    && Number.isFinite(confidence)
    && confidence >= 0
    && confidence <= 1
    && sources.length > 0;
  return {
    status: validProposal ? 'proposed' : (validNoChange ? 'verified_no_change' : 'unresolved'),
    replacement: validProposal ? replacement : '',
    // answerFrom / answerTo 是机器协议字段；reason 只用于人工审阅，不能决定是否应用。
    answerFrom,
    answerTo: validProposal ? replacement : '',
    confidence: Number.isFinite(confidence) ? confidence : null,
    rationale: String(raw.rationale || raw.reason || '').trim(),
    query: String(raw.query || raw.searchQuery || '').trim(),
    sources,
    reason: (validProposal || validNoChange) ? '' : (String(raw.reason || raw.rationale || '').trim() || '未获得可核验的联网证据'),
  };
}

function candidatesSha256(candidates) {
  return sha256(JSON.stringify(candidates));
}

function buildApprovalTemplate(document, candidates) {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now(),
    documentSha256: document.documentSha256,
    candidatesSha256: candidatesSha256(candidates),
    decisions: candidates.map(candidate => ({
      candidateId: candidate.id,
      decision: 'pending',
      proposedText: candidate.verification.replacement || '',
      note: '',
    })),
  };
}

function applyDecisions(template, candidates, options) {
  const decisionsById = new Map(template.decisions.map(decision => [decision.candidateId, { ...decision }]));
  const candidateIds = new Set(candidates.map(candidate => candidate.id));
  const approve = new Set(options.approve || []);
  const reject = new Set(options.reject || []);
  for (const id of [...approve, ...reject]) {
    if (!candidateIds.has(id)) fail(`不存在事实核验候选：${id}`);
  }
  for (const id of approve) {
    const candidate = candidates.find(item => item.id === id);
    if (!candidate || candidate.verification.status !== 'proposed') {
      fail(`候选 ${id} 没有可批准的、带证据的直接答案`);
    }
    decisionsById.set(id, {
      candidateId: id,
      decision: 'approved',
      proposedText: candidate.verification.replacement,
      note: options.note || '',
      decidedAt: now(),
      decidedBy: options.by || 'manual',
    });
  }
  for (const id of reject) {
    decisionsById.set(id, {
      candidateId: id,
      decision: 'rejected',
      proposedText: '',
      note: options.note || '',
      decidedAt: now(),
      decidedBy: options.by || 'manual',
    });
  }
  return {
    ...template,
    updatedAt: now(),
    decisions: candidates.map(candidate => decisionsById.get(candidate.id) || {
      candidateId: candidate.id,
      decision: 'pending',
      proposedText: candidate.verification.replacement || '',
      note: '',
    }),
  };
}

function verifyApprovalSnapshot(document, candidates, approval) {
  if (!approval || typeof approval !== 'object') fail('批准文件格式错误');
  if (approval.documentSha256 !== document.documentSha256) {
    fail('基础纠错字幕已经变化；旧的批准决定不可应用，请重新运行事实核验');
  }
  if (approval.candidatesSha256 !== candidatesSha256(candidates)) {
    fail('事实候选已经变化；旧的批准决定不可应用，请重新审核');
  }
  if (!Array.isArray(approval.decisions)) fail('批准文件缺少 decisions 数组');
}

function approvedOperations(document, candidates, approval) {
  verifyApprovalSnapshot(document, candidates, approval);
  const decisions = new Map(approval.decisions.map(decision => [decision.candidateId, decision]));
  const operations = [];
  for (const candidate of candidates) {
    const decision = decisions.get(candidate.id);
    if (!decision || decision.decision !== 'approved') continue;
    if (candidate.verification.status !== 'proposed') fail(`候选 ${candidate.id} 不具备可应用的证据提案`);
    for (const occurrence of candidate.occurrences) {
      const lineText = document.lines[occurrence.line - 1].text;
      if (lineText.slice(occurrence.charStart, occurrence.charEnd) !== occurrence.mention) {
        fail(`候选 ${candidate.id} 的第 ${occurrence.line} 行已变化，拒绝应用过期修改`);
      }
      operations.push({
        candidateId: candidate.id,
        line: occurrence.line,
        charStart: occurrence.charStart,
        charEnd: occurrence.charEnd,
        expected: occurrence.mention,
        replacement: candidate.verification.replacement,
        sourceStart: occurrence.sourceStart,
        sourceEnd: occurrence.sourceEnd,
        sourceWordIndices: occurrence.sourceWordIndices,
      });
    }
  }
  operations.sort((a, b) => a.line - b.line || a.charStart - b.charStart || a.charEnd - b.charEnd);
  for (let index = 1; index < operations.length; index++) {
    const previous = operations[index - 1];
    const current = operations[index];
    if (previous.line === current.line && current.charStart < previous.charEnd) {
      fail(`已批准候选在第 ${current.line} 行发生重叠：${previous.candidateId} 与 ${current.candidateId}`);
    }
  }
  return operations;
}

function applyApprovedCorrections(document, candidates, approval) {
  const operations = approvedOperations(document, candidates, approval);
  const perLine = new Map();
  for (const operation of operations) {
    if (!perLine.has(operation.line)) perLine.set(operation.line, []);
    perLine.get(operation.line).push(operation);
  }
  const outputLines = document.correctedLines.slice();
  for (const [line, lineOperations] of perLine.entries()) {
    let text = outputLines[line - 1];
    for (const operation of lineOperations.slice().sort((a, b) => b.charStart - a.charStart)) {
      if (text.slice(operation.charStart, operation.charEnd) !== operation.expected) {
        fail(`应用时第 ${line} 行与批准快照不一致，拒绝写入`);
      }
      text = `${text.slice(0, operation.charStart)}${operation.replacement}${text.slice(operation.charEnd)}`;
    }
    outputLines[line - 1] = text;
  }
  const outputText = `${outputLines.join('\n')}\n`;
  return {
    outputLines,
    outputText,
    outputSha256: sha256(outputText),
    operations,
  };
}

module.exports = {
  SCHEMA_VERSION,
  applyApprovedCorrections,
  applyDecisions,
  buildApprovalTemplate,
  candidatesSha256,
  ensureCaptionInput,
  normalizeFactMap,
  normalizeSources,
  normalizeVerification,
  readJson,
  sha256,
  writeJson,
};
