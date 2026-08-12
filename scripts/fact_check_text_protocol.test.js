'use strict';

const assert = require('assert');
const { parseFactMapText, parseVerificationText } = require('./lib/fact_check_text_protocol');

const map = parseFactMapText(`
[FACT_MAP]
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
assert.strictEqual(map.candidates[0].name, '邓玉');
assert.strictEqual(map.candidates[0].occurrences[0].line, 2);
assert.strictEqual(map.candidates[0].occurrences[0].mention, '邓玉');

const verification = parseVerificationText(`
[ANSWER]
ANSWER: 邓玉 -> 邓煜
CONFIDENCE: 0.98
REASON: 官方页面使用邓煜这一写法
[/ANSWER]
`);
assert.strictEqual(verification.status, 'proposed');
assert.strictEqual(verification.answerFrom, '邓玉');
assert.strictEqual(verification.replacement, '邓煜');
assert.strictEqual(verification.confidence, 0.98);

const uncertain = parseVerificationText(`
[ANSWER]
ANSWER: uncertain
CONFIDENCE: 0.00
REASON: 证据冲突
[/ANSWER]
`);
assert.strictEqual(uncertain.status, 'unresolved');

assert.throws(
  () => parseFactMapText('[FACT_MAP]\nTOPICS: x\n'),
  /缺少 \[\/FACT_MAP\]/,
  '不完整协议必须被拒绝'
);
assert.throws(
  () => parseVerificationText('{"status":"proposed"}'),
  /首个非空行必须是 \[ANSWER\]/,
  'JSON 不应被当作协议接受'
);
console.log('fact check text protocol test passed');
