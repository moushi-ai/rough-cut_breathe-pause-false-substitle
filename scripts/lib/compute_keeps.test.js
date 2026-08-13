'use strict';

const assert = require('assert');
const { computeFinalKeeps, DEFAULTS } = require('./compute_keeps');

const words = [
  { text: '甲', start: 0, end: 1, isGap: false },
  { text: '乙', start: 1.2, end: 2, isGap: false },
  { text: '丙', start: 2.3, end: 3, isGap: false },
];

// 静音检测故意越过字的时间戳，模拟 refine_boundaries 的误差。
const silencePeriods = [
  { start: 0.85, end: 1.28 },
  { start: 2.05, end: 2.4 },
];

const keeps = computeFinalKeeps(
  [{ start: 1, end: 1.2 }],
  silencePeriods,
  3,
  { lookBack: 0.6, padStart: 0.2, padEnd: 0.2, minInternalSilence: 0.2 },
  words,
);

assert(keeps.length > 0);
for (let i = 1; i < keeps.length; i++) {
  assert(keeps[i].start >= keeps[i - 1].end, '保留片段不应重叠');
}
for (const keep of keeps) {
  for (const word of words) {
    assert(!(word.start < keep.start && keep.start < word.end), '起点不能落在字中');
    assert(!(word.start < keep.end && keep.end < word.end), '终点不能落在字中');
  }
}

// 内部静音默认阈值是 0.4 秒；更短的自然气口不应被拆段。
const thresholdWords = [
  { text: '甲', start: 0, end: 0.8, isGap: false },
  { text: '乙', start: 1.25, end: 2, isGap: false },
];
const shortInternalSilence = computeFinalKeeps(
  [],
  [{ start: 0.8, end: 1.15 }],
  2,
  undefined,
  thresholdWords,
);
const longInternalSilence = computeFinalKeeps(
  [],
  [{ start: 0.8, end: 1.25 }],
  2,
  undefined,
  thresholdWords,
);
const legacyExplicitThreshold = computeFinalKeeps(
  [],
  [{ start: 0.8, end: 1.15 }],
  2,
  { minInternalSilence: 0.2 },
  thresholdWords,
);

assert.strictEqual(DEFAULTS.minInternalSilence, 0.4, '默认内部静音阈值应为 0.4 秒');
assert.strictEqual(shortInternalSilence.length, 1, '短于 0.4 秒的内部气口不应自动拆段');
assert.strictEqual(longInternalSilence.length, 2, '长于 0.4 秒的内部静音应自动拆段');
assert.strictEqual(legacyExplicitThreshold.length, 2, '历史审核页显式传入的阈值仍应按其值执行');

console.log(`compute_keeps safety test passed (${keeps.length} keeps)`);
