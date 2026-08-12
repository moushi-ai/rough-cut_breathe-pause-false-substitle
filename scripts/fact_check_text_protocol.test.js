'use strict';

const assert = require('assert');
const { parseAudioDecisionText, parseFactMapText, parseVerificationText } = require('./lib/fact_check_text_protocol');

const map = parseFactMapText(`
[FACT_MAP]
BRIEF: 菲尔兹奖人物介绍 | 数学家获奖事件
TOPICS: 菲尔兹奖 | 数学家
[CANDIDATE]
TYPE: PERSON
VARIANT: 邓玉
RISK: high
[OCCURRENCE]
LINE: 2
MENTION: 邓玉
BEFORE: 一个叫王虹一个叫
AFTER: 北大同届的校友
[/OCCURRENCE]
[/CANDIDATE]
[/FACT_MAP]
`);
assert.deepStrictEqual(map.topicKeywords, ['菲尔兹奖', '数学家']);
assert.strictEqual(map.documentBrief, '菲尔兹奖人物介绍 | 数学家获奖事件');
assert.strictEqual(map.candidates[0].name, '邓玉');
assert.strictEqual(map.candidates[0].occurrences[0].line, 2);
assert.strictEqual(map.candidates[0].occurrences[0].mention, '邓玉');

const verification = parseVerificationText(`
[ANSWER]
ANSWER: 邓玉 -> 邓煜
CONFIDENCE: 0.98
SPEECH_MATCH: homophone
REASON: 官方页面使用邓煜这一写法
[/ANSWER]
`);
assert.strictEqual(verification.status, 'proposed');
assert.strictEqual(verification.answerFrom, '邓玉');
assert.strictEqual(verification.replacement, '邓煜');
assert.strictEqual(verification.confidence, 0.98);
assert.strictEqual(verification.speechMatch, 'homophone');

const uncertain = parseVerificationText(`
[ANSWER]
ANSWER: uncertain
CONFIDENCE: 0.00
SPEECH_MATCH: no
REASON: 证据冲突
[/ANSWER]
`);
assert.strictEqual(uncertain.status, 'unresolved');
assert.strictEqual(uncertain.speechMatch, 'no');

const audioDecision = parseAudioDecisionText(`
[AUDIO_DECISION]
ANSWER: 72 -> 72%
CONFIDENCE: 0.98
REASON: 二遍原样复听文本明确为百分之七十二
[/AUDIO_DECISION]
`);
assert.strictEqual(audioDecision.status, 'proposed');
assert.strictEqual(audioDecision.answerFrom, '72');
assert.strictEqual(audioDecision.replacement, '72%');

assert.throws(
  () => parseAudioDecisionText('[AUDIO_DECISION]\nANSWER: 72 -> 72%\nCONFIDENCE: 0.98\n[/AUDIO_DECISION]'),
  /缺少字段：REASON/,
  '声学裁决协议缺字段必须被拒绝'
);

assert.throws(
  () => parseFactMapText('[FACT_MAP]\nTOPICS: x\n'),
  /缺少 \[\/FACT_MAP\]/,
  '不完整协议必须被拒绝'
);
assert.throws(
  () => parseFactMapText('[FACT_MAP]\nTOPICS: x\n[/FACT_MAP]'),
  /缺少非空 BRIEF/,
  '全文事实核验必须先产出 brief，不能退化为只带主题搜索'
);
assert.throws(
  () => parseVerificationText('{"status":"proposed"}'),
  /首个非空行必须是 \[ANSWER\]/,
  'JSON 不应被当作协议接受'
);
assert.throws(
  () => parseVerificationText('[ANSWER]\nANSWER: 邓玉 -> 邓煜\nCONFIDENCE: 0.98\nREASON: 缺字段\n[/ANSWER]'),
  /缺少字段：SPEECH_MATCH/,
  '字幕保真协议必须声明是否保持原话发音'
);
assert.throws(
  () => parseVerificationText('[ANSWER]\nANSWER: 邓玉 -> 邓煜\nCONFIDENCE: 0.98\nSPEECH_MATCH: maybe\nREASON: 非法值\n[/ANSWER]'),
  /SPEECH_MATCH 只能是 exact、homophone 或 no/,
  '未知的字幕保真状态不得被接受'
);
assert.throws(
  () => parseVerificationText('[ANSWER]\nANSWER: 邓玉 -> 邓煜\nCONFIDENCE: 0.98\nSPEECH_MATCH: no\nREASON: 不保真\n[/ANSWER]'),
  /提出替换时 SPEECH_MATCH 必须是 exact 或 homophone/,
  '不保真的模型答案不得伪装成可替换答案'
);
assert.throws(
  () => parseVerificationText('[ANSWER]\nANSWER: uncertain\nCONFIDENCE: 0\nSPEECH_MATCH: exact\nREASON: 协议不一致\n[/ANSWER]'),
  /ANSWER 为 uncertain 时 SPEECH_MATCH 必须是 no/,
  'uncertain 必须明确表示无法保证原话保真'
);
console.log('fact check text protocol test passed');
