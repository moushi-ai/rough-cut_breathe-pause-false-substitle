'use strict';

const assert = require('assert');
const {
  buildClipWindow,
  extractAsrTexts,
  needsAudioRecheck,
} = require('./fact_audio_recheck');

const window = buildClipWindow({ sourceStart: 59.2, sourceEnd: 59.6 }, 100);
assert.deepStrictEqual(window, {
  candidateStart: 59.2,
  candidateEnd: 59.6,
  clipStart: 57.2,
  clipEnd: 61.6,
  durationSeconds: 4.4,
  beforeSeconds: 2,
  afterSeconds: 2,
  policy: '连续原始音频窗口；候选前 2.00 秒、候选后 2.00 秒；不删静音、不拼接、不改速',
});

const clamped = buildClipWindow({ sourceStart: 0.4, sourceEnd: 0.8 }, 1.5);
assert.strictEqual(clamped.clipStart, 0, '开头候选必须向 0 秒安全截断');
assert.strictEqual(clamped.clipEnd, 1.5, '结尾候选必须向音频时长安全截断');

assert.strictEqual(needsAudioRecheck({ type: 'NUMBER', variants: ['72'] }), true);
assert.strictEqual(needsAudioRecheck({ type: 'NUMBER', variants: ['70多份'] }), false);
assert.strictEqual(needsAudioRecheck({ type: 'PERSON', variants: ['72'] }), false);

const sourceResult = {
  result: {
    text: '百分之七十二',
    utterances: [{
      start_time: 200,
      end_time: 800,
      text: '百分之七十二',
      words: [
        { text: '百', start_time: 200, end_time: 300 },
        { text: '分', start_time: 300, end_time: 400 },
        { text: '之', start_time: 400, end_time: 500 },
        { text: '七十二', start_time: 500, end_time: 800 },
      ],
    }],
  },
};
const texts = extractAsrTexts(sourceResult, { clipStart: 0.35, clipEnd: 0.6 });
assert.strictEqual(texts.wordText, '分之七十二', '原始 start_time/end_time 即使小于 1000ms 也必须按毫秒处理');

console.log('fact audio recheck test passed');
