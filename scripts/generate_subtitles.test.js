'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  collectWords,
  cueRanges,
  generateSubtitles,
  splitRecordingCueWord,
} = require('./generate_subtitles');

const ascii = splitRecordingCueWord({ text: '321但问题是', start: 1, end: 2 });
assert.deepStrictEqual(ascii.map(part => part.text), ['321', '但问题是']);
assert.strictEqual(ascii[0].isRecordingCue, true, '黏连的 321 必须成为独立口令原子');
assert.strictEqual(ascii[1].isRecordingCue, false, '口令后的正文不能继承删除标记');
assert.strictEqual(ascii[0].end, ascii[1].start, '拆分后的时间轴必须连续');

const chinese = splitRecordingCueWord({ text: '三二一好了', start: 1, end: 2 });
assert.deepStrictEqual(chinese.map(part => part.text), ['三二一', '好了']);
assert.strictEqual(chinese[0].isRecordingCue, true, '黏连的三二一必须成为独立口令原子');
assert.strictEqual(chinese[1].isRecordingCue, false, '三二一后的正文不能被吞掉');

assert.deepStrictEqual(cueRanges('1321年').ranges, [], '数字内部的 321 不得误判为录制口令');
assert.deepStrictEqual(cueRanges('321年').ranges, [], '带单位的 321 不得误判为录制口令');
assert.deepStrictEqual(cueRanges('A321').ranges, [], '英文型号中的 321 不得误判为录制口令');
assert.deepStrictEqual(cueRanges('三二一个人').ranges, [], '自然数量结构不得误判为录制口令');

const fixture = {
  result: {
    utterances: [{
      words: [
        { text: '321但问题是', start_time: 1000, end_time: 2000 },
        { text: '正文', start_time: 2100, end_time: 2300 },
      ],
    }],
  },
};
const collected = collectWords(fixture);
assert.deepStrictEqual(collected.map(word => word.text), ['321', '但问题是', '正文']);
assert.strictEqual(collected[0].isRecordingCue, true);
assert.strictEqual(collected[1].isRecordingCue, undefined);

const separated = collectWords({
  utterances: [{
    words: [
      { text: '三', start_time: 0, end_time: 100 },
      { text: '二', start_time: 100, end_time: 200 },
      { text: '一', start_time: 200, end_time: 300 },
      { text: '好了', start_time: 300, end_time: 500 },
      { text: '321年', start_time: 500, end_time: 700 },
    ],
  }],
});
assert.deepStrictEqual(separated.slice(0, 4).map(word => word.text), ['三', '二', '一', '好了']);
assert(separated.slice(0, 3).every(word => word.isRecordingCue), '被 ASR 拆开的三二一也必须逐词打上口令标记');
assert.strictEqual(separated[3].isRecordingCue, undefined, '拆开的口令不得连带标记后续正文');
assert.strictEqual(separated[4].isRecordingCue, undefined, '带数量单位的 321 不得标成录制口令');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-jian-koubo-generate-subtitles-'));
try {
  const input = path.join(root, 'result.json');
  const output = path.join(root, '1_转录');
  fs.mkdirSync(output);
  fs.writeFileSync(input, JSON.stringify(fixture));
  const outcome = generateSubtitles({ resultFile: input, outDir: output });
  const generated = JSON.parse(fs.readFileSync(outcome.outputFile, 'utf8'));
  const generatedCue = generated.find(word => word.text === '321');
  const generatedBody = generated.find(word => word.text === '但问题是');
  assert.strictEqual(outcome.rawWordCount, 3);
  assert(generatedCue, '生成结果必须保留独立的 321 口令原子');
  assert.strictEqual(generatedCue.isRecordingCue, true);
  assert(generatedBody, '生成结果必须保留口令后的正文');
  assert.strictEqual(generatedBody.isRecordingCue, undefined);
  console.log('generate subtitles recording-cue split test passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
