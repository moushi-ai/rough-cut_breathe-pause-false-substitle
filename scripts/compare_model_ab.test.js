'use strict';

const assert = require('assert');
const {
  duration,
  intersectionDuration,
  intervalsFromSelectedIndices,
  normalizeIntervals,
} = require('./compare_model_ab');

const words = [
  { text: '甲', start: 0, end: 0.5, isGap: false },
  { text: '', start: 0.5, end: 0.8, isGap: true },
  { text: '乙', start: 0.8, end: 1.2, isGap: false },
  { text: '丙', start: 1.3, end: 1.7, isGap: false },
  { text: '丁', start: 2.0, end: 2.4, isGap: false },
];

const intervals = normalizeIntervals(intervalsFromSelectedIndices([0, 2, 3], words));
assert.deepStrictEqual(intervals.map(x => [x.start, x.end]), [[0, 1.7]], '允许跨一个 gap 合并同一删除意图');
assert.strictEqual(duration(intervals), 1.7);

const left = [{ start: 0, end: 1.7 }, { start: 2.1, end: 3 }];
const right = [{ start: 1, end: 2.5 }];
assert(Math.abs(intersectionDuration(left, right) - 1.1) < 1e-9, '区间交集应按源时间轴计算');

console.log('compare_model_ab interval test passed');
