/*
 * 事实核验模型的固定文本协议。
 *
 * 让模型填受限的标签文本，而不是让它生成 JSON；本文件是唯一把模型文本
 * 翻译成内部 JSON 合同的位置。协议不完整时立即报错，调用方不会据此改字幕。
 */

'use strict';

function fail(message) {
  throw new Error(`事实核验文本协议错误：${message}`);
}

function protocolLines(text) {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    // 模型偶尔会包一层 Markdown code fence；它不承载数据，可安全忽略。
    .filter(line => !/^```(?:text)?$/i.test(line));
}

function firstNonEmpty(lines) {
  return lines.find(line => line.length > 0) || '';
}

function parseField(line, allowed, context) {
  const match = line.match(/^([A-Z_]+):\s*(.*)$/);
  if (!match || !allowed.has(match[1])) {
    fail(`${context} 中不接受的行：${line || '（空行）'}`);
  }
  return { key: match[1], value: match[2].trim() };
}

function splitList(value) {
  return String(value || '').split('|').map(item => item.trim()).filter(Boolean);
}

function parseFactMapText(text) {
  const lines = protocolLines(text);
  if (firstNonEmpty(lines) !== '[FACT_MAP]') fail('首个非空行必须是 [FACT_MAP]');
  let state = 'map';
  let ended = false;
  const map = { documentBrief: '', topicKeywords: [], timeScope: '', candidates: [] };
  let candidate = null;
  let occurrence = null;
  const mapFields = new Set(['BRIEF', 'TOPICS']);
  const candidateFields = new Set(['TYPE', 'VARIANT', 'RISK']);
  const occurrenceFields = new Set(['LINE', 'MENTION', 'BEFORE', 'AFTER']);
  const seenMapFields = new Set();

  for (const line of lines.slice(lines.indexOf('[FACT_MAP]') + 1)) {
    if (!line) continue;
    if (state === 'map') {
      if (line === '[CANDIDATE]') {
        candidate = { name: '', type: '', variants: [], risk: '', factToVerify: '', queryHints: [], occurrences: [] };
        state = 'candidate';
        continue;
      }
      if (line === '[/FACT_MAP]') {
        if (!seenMapFields.has('BRIEF') || !map.documentBrief) fail('FACT_MAP 缺少非空 BRIEF');
        ended = true;
        state = 'done';
        continue;
      }
      const { key, value } = parseField(line, mapFields, 'FACT_MAP');
      if (seenMapFields.has(key)) fail(`FACT_MAP 中重复字段：${key}`);
      seenMapFields.add(key);
      if (key === 'BRIEF') map.documentBrief = value;
      if (key === 'TOPICS') map.topicKeywords = splitList(value);
      continue;
    }
    if (state === 'candidate') {
      if (line === '[OCCURRENCE]') {
        occurrence = { line: '', mention: '', before: '', after: '' };
        state = 'occurrence';
        continue;
      }
      if (line === '[/CANDIDATE]') {
        if (candidate.variants.length !== 1 || candidate.occurrences.length === 0) {
          fail('CANDIDATE 必须只有一个 VARIANT，且至少有一个 OCCURRENCE');
        }
        candidate.name = candidate.variants[0];
        map.candidates.push(candidate);
        candidate = null;
        state = 'map';
        continue;
      }
      const { key, value } = parseField(line, candidateFields, 'CANDIDATE');
      if (key === 'TYPE') candidate.type = value;
      if (key === 'VARIANT') candidate.variants = splitList(value);
      if (key === 'RISK') candidate.risk = value;
      continue;
    }
    if (state === 'occurrence') {
      if (line === '[/OCCURRENCE]') {
        if (!occurrence.line || !occurrence.mention) fail('OCCURRENCE 缺少 LINE 或 MENTION');
        candidate.occurrences.push(occurrence);
        occurrence = null;
        state = 'candidate';
        continue;
      }
      const { key, value } = parseField(line, occurrenceFields, 'OCCURRENCE');
      if (key === 'LINE') occurrence.line = Number(value.replace(/^L/i, ''));
      if (key === 'MENTION') occurrence.mention = value;
      if (key === 'BEFORE') occurrence.before = value;
      if (key === 'AFTER') occurrence.after = value;
      continue;
    }
    if (state === 'done') fail(`结束标记后不应再出现内容：${line}`);
  }
  if (!ended || state !== 'done') fail('缺少 [/FACT_MAP] 或存在未关闭的候选块');
  return map;
}

function parseVerificationText(text) {
  const lines = protocolLines(text);
  if (firstNonEmpty(lines) !== '[ANSWER]') fail('首个非空行必须是 [ANSWER]');
  const begin = lines.indexOf('[ANSWER]');
  const end = lines.indexOf('[/ANSWER]');
  if (end === -1 || end <= begin) fail('缺少 [/ANSWER]');
  if (lines.slice(end + 1).some(line => line)) fail('[/ANSWER] 后不应再出现内容');
  const fields = {};
  const allowed = new Set(['ANSWER', 'CONFIDENCE', 'SPEECH_MATCH', 'REASON']);
  for (const line of lines.slice(begin + 1, end)) {
    if (!line) continue;
    const { key, value } = parseField(line, allowed, 'ANSWER');
    if (Object.prototype.hasOwnProperty.call(fields, key)) fail(`ANSWER 中重复字段：${key}`);
    fields[key] = value;
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) fail(`ANSWER 缺少字段：${key}`);
  }
  const confidence = Number(fields.CONFIDENCE);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    fail('CONFIDENCE 必须是 0 到 1 的数字');
  }
  const speechMatch = fields.SPEECH_MATCH.toLowerCase();
  if (!new Set(['exact', 'homophone', 'no']).has(speechMatch)) {
    fail('SPEECH_MATCH 只能是 exact、homophone 或 no');
  }
  if (fields.ANSWER.toLowerCase() === 'uncertain') {
    if (speechMatch !== 'no') fail('ANSWER 为 uncertain 时 SPEECH_MATCH 必须是 no');
    return { status: 'unresolved', answerFrom: '', replacement: '', confidence, speechMatch, reason: fields.REASON };
  }
  if (speechMatch === 'no') fail('提出替换时 SPEECH_MATCH 必须是 exact 或 homophone');
  const match = fields.ANSWER.match(/^(.+?)\s*(?:->|→)\s*(.+?)$/);
  if (!match) fail('ANSWER 只能是“原文 -> 标准写法”或 uncertain');
  return {
    status: 'proposed',
    answerFrom: match[1].trim(),
    replacement: match[2].trim(),
    confidence,
    speechMatch,
    reason: fields.REASON,
  };
}

/*
 * 声学复核的最终裁决协议。
 *
 * 它与联网事实核验一样只接受受限文本，而不是 JSON；区别在于 ANSWER 的证据
 * 来自“首遍 ASR + 关闭 ITN 的二遍 ASR + 固定音频切片规则”，而非 Web Search。
 */
function parseAudioDecisionText(text) {
  const lines = protocolLines(text);
  if (firstNonEmpty(lines) !== '[AUDIO_DECISION]') fail('首个非空行必须是 [AUDIO_DECISION]');
  const begin = lines.indexOf('[AUDIO_DECISION]');
  const end = lines.indexOf('[/AUDIO_DECISION]');
  if (end === -1 || end <= begin) fail('缺少 [/AUDIO_DECISION]');
  if (lines.slice(end + 1).some(line => line)) fail('[/AUDIO_DECISION] 后不应再出现内容');
  const fields = {};
  const allowed = new Set(['ANSWER', 'CONFIDENCE', 'REASON']);
  for (const line of lines.slice(begin + 1, end)) {
    if (!line) continue;
    const { key, value } = parseField(line, allowed, 'AUDIO_DECISION');
    if (Object.prototype.hasOwnProperty.call(fields, key)) fail(`AUDIO_DECISION 中重复字段：${key}`);
    fields[key] = value;
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) fail(`AUDIO_DECISION 缺少字段：${key}`);
  }
  const confidence = Number(fields.CONFIDENCE);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    fail('AUDIO_DECISION 的 CONFIDENCE 必须是 0 到 1 的数字');
  }
  if (fields.ANSWER.toLowerCase() === 'uncertain') {
    return { status: 'unresolved', answerFrom: '', replacement: '', confidence, reason: fields.REASON };
  }
  const match = fields.ANSWER.match(/^(.+?)\s*(?:->|→)\s*(.+?)$/);
  if (!match) fail('AUDIO_DECISION 的 ANSWER 只能是“原文 -> 标准写法”或 uncertain');
  return {
    status: 'proposed',
    answerFrom: match[1].trim(),
    replacement: match[2].trim(),
    confidence,
    reason: fields.REASON,
  };
}

module.exports = {
  parseAudioDecisionText,
  parseFactMapText,
  parseVerificationText,
};
