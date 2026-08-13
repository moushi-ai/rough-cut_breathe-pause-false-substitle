'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createStreamingReviewState,
  getPublicReviewState,
  planReviewChunks,
  publishChunkSelection,
  validateChunkSelection,
  writeJsonAtomic,
} = require('./lib/review_stream');

function makeTimedTranscript(sentenceCount, { speechSeconds = 5, gapSeconds = 25 } = {}) {
  const words = [];
  const sentenceMap = [];
  let clock = 0;
  for (let sentence = 0; sentence < sentenceCount; sentence++) {
    const startIdx = words.length;
    words.push({ text: String.fromCharCode(0x4e00 + sentence), start: clock, end: clock + speechSeconds, isGap: false });
    sentenceMap.push({ startIdx, endIdx: startIdx });
    clock += speechSeconds;
    if (sentence < sentenceCount - 1) {
      words.push({ text: '', start: clock, end: clock + gapSeconds, isGap: true });
      clock += gapSeconds;
    }
  }
  return { words, sentenceMap };
}

const longTranscript = makeTimedTranscript(12); // 335 秒：必须进入流式模式
const restartCandidates = {
  candidates: [{ sourceSentence: 3, restartSentence: 4 }],
};
const manifest = planReviewChunks({
  ...longTranscript,
  restartCandidates,
  options: { targetSeconds: 120, minSeconds: 90, maxSeconds: 150, contextSeconds: 12 },
});

assert.strictEqual(manifest.mode, 'streaming', '超过两分钟必须规划为流式审核');
assert(manifest.chunks.length >= 2, '长视频应拆成至少两个审核批次');
assert.notStrictEqual(manifest.chunks[0].core.endSentence, 3, '跨句重录候选所在的边界不可作为批次边界');

for (let index = 0; index < manifest.chunks.length; index++) {
  const chunk = manifest.chunks[index];
  assert(chunk.core.startIdx <= chunk.core.endIdx, '每批 core 必须是有效逐字范围');
  assert(chunk.context.startSentence <= chunk.core.startSentence, '上下文必须覆盖 core 开头');
  assert(chunk.context.endSentence >= chunk.core.endSentence, '上下文必须覆盖 core 结尾');
  if (index > 0) {
    const previous = manifest.chunks[index - 1];
    assert.strictEqual(chunk.core.startSentence, previous.core.endSentence + 1, 'core 批次必须完整且不重叠');
  }
}

const shortTranscript = makeTimedTranscript(4);
const shortManifest = planReviewChunks({ ...shortTranscript, restartCandidates: { candidates: [] } });
assert.strictEqual(shortManifest.mode, 'single', '两分钟以内保持既有单段流程');
assert.strictEqual(shortManifest.chunks.length, 1, '短视频只应有一个批次');

const exactlyTwoMinutes = planReviewChunks({
  words: [{ text: '甲', start: 0, end: 120, isGap: false }],
  sentenceMap: [{ startIdx: 0, endIdx: 0 }],
  restartCandidates: { candidates: [] },
});
assert.strictEqual(exactlyTwoMinutes.mode, 'streaming', '正好两分钟也应进入流式合同');

const review = createStreamingReviewState(manifest);
const reviewData = {
  words: longTranscript.words,
  // 模拟转录阶段已预选的静音；分批发布不能把这个基础选择丢掉。
  autoSelected: [1],
  baseAutoSelected: [1],
  review,
};
const firstChunk = review.chunks[0];
const firstSentence = firstChunk.core.startSentence;
const firstSelection = validateChunkSelection({
  words: longTranscript.words,
  sentenceMap: longTranscript.sentenceMap,
  chunk: firstChunk,
  rawErrors: { delete_sentences: [firstSentence], delete_idx: [] },
});
assert(firstSelection.length > 0, '本批整句删除必须展开为逐字选择');
assert.throws(() => validateChunkSelection({
  words: longTranscript.words,
  sentenceMap: longTranscript.sentenceMap,
  chunk: firstChunk,
  rawErrors: { delete_sentences: [firstChunk.core.endSentence + 1], delete_idx: [] },
}), /只能提交 core/, '跨批删除必须被合同拒绝');

let published = publishChunkSelection(reviewData, { chunkId: firstChunk.id, selected: firstSelection });
assert(published.changed, '首批发布应更新审核状态');
assert.strictEqual(published.data.review.chunks[0].status, 'ready', '首批必须变为 ready');
assert.strictEqual(published.data.review.chunks[1].status, 'analyzing', '首批完成后应推进下一批状态');
assert(published.data.autoSelected.includes(1), '静音基础选择必须保留');
assert(published.data.autoSelected.includes(firstSelection[0]), '首批语义选择必须合并到审核数据');

for (const chunk of published.data.review.chunks.slice(1)) {
  published = publishChunkSelection(published.data, { chunkId: chunk.id, selected: [] });
}
assert.strictEqual(published.data.review.status, 'complete', '所有批次发布后审核状态必须完成');
const publicState = getPublicReviewState(published.data);
assert.strictEqual(publicState.status, 'complete', '服务端公开状态必须反映完成');
assert(publicState.chunks.every(chunk => chunk.status === 'ready'), '公开状态中每批必须 ready');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-jian-koubo-stream-state-'));
try {
  const stateFile = path.join(root, 'data.json');
  writeJsonAtomic(stateFile, published.data);
  const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.strictEqual(persisted.review.revision, published.data.review.revision, '原子状态写入必须产生完整 JSON');
  assert(!fs.readdirSync(root).some(name => name.includes('.tmp')), '成功写入后不能遗留临时状态文件');
  console.log('stream review planning and publish test passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
