'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { extractRetainedTranscript } = require('./extract_retained_transcript');

const words = [
  { text: '这', start: 0, end: 0.1, isGap: false },
  { text: '是', start: 0.1, end: 0.2, isGap: false },
  { text: '嗯', start: 0.2, end: 0.3, isGap: false },
  { text: '第', start: 0.3, end: 0.4, isGap: false },
  { text: '一', start: 0.4, end: 0.5, isGap: false },
  { text: '', start: 0.5, end: 0.9, isGap: true },
  { text: '王', start: 0.9, end: 1.0, isGap: false },
  { text: '宏', start: 1.0, end: 1.1, isGap: false },
  { text: '说', start: 1.1, end: 1.2, isGap: false },
];

const direct = extractRetainedTranscript({ words, finalSelected: [2, 5] });
assert.strictEqual(direct.retainedWordCount, 7, '被选中的口癖词必须不进入成片台词');
assert.strictEqual(direct.deletedWordCount, 1, '静音选择不应算删除台词');
assert.strictEqual(direct.selectedGapCount, 1, '应保留审核页静音选择的统计');
assert.deepStrictEqual(direct.lines.map(line => line.text), ['这是第一', '王宏说']);
assert.deepStrictEqual(direct.lines[1].sourceWordIndices, [6, 7, 8]);
assert.throws(
  () => extractRetainedTranscript({ words, finalSelected: null }),
  /缺少 finalSelected/,
  '没有最终审核选择时不得回退导出完整 ASR'
);
assert.throws(
  () => extractRetainedTranscript({ words, finalSelected: [99] }),
  /无效 idx/,
  '审核日志中越界 idx 必须阻止导出'
);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-jian-koubo-retained-transcript-'));
try {
  const reviewDir = path.join(root, '3_审核');
  const outputDir = path.join(root, '4_字幕');
  fs.mkdirSync(reviewDir, { recursive: true });
  fs.writeFileSync(path.join(reviewDir, 'data.json'), JSON.stringify({ words }, null, 2));
  fs.writeFileSync(path.join(reviewDir, 'review_log.json'), JSON.stringify({
    video: 'demo',
    exportedAt: '2026-08-12T00:00:00.000Z',
    finalSelected: [2, 5],
  }, null, 2));

  execFileSync(process.execPath, [path.join(__dirname, 'extract_retained_transcript.js'), reviewDir, outputDir], { encoding: 'utf8' });
  assert.strictEqual(fs.readFileSync(path.join(outputDir, 'retained_raw.txt'), 'utf8'), '这是第一\n王宏说\n');
  const artifact = JSON.parse(fs.readFileSync(path.join(outputDir, 'retained_transcript.json'), 'utf8'));
  assert.strictEqual(artifact.source.reviewLogVideo, 'demo');
  assert.strictEqual(artifact.correctionPolicy.includes('uncertain.md'), true);
  console.log('retained transcript extraction test passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
