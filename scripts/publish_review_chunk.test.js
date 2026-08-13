'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStreamingReviewState, planReviewChunks } = require('./lib/review_stream');

function makeTranscript() {
  const words = [];
  const sentenceMap = [];
  let clock = 0;
  for (let sentence = 0; sentence < 12; sentence++) {
    const startIdx = words.length;
    // 第一批中放一个安全的独立口癖，验证 publish 会自动限定范围运行 auto_filler。
    words.push({ text: sentence === 0 ? '嗯' : '甲', start: clock, end: clock + 5, isGap: false });
    sentenceMap.push({ startIdx, endIdx: startIdx });
    clock += 5;
    if (sentence < 11) {
      words.push({ text: '', start: clock, end: clock + 25, isGap: true });
      clock += 25;
    }
  }
  return { words, sentenceMap };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-jian-koubo-publish-chunk-'));
try {
  const transcribeDir = path.join(root, '1_转录');
  const analysisDir = path.join(root, '2_分析');
  const reviewDir = path.join(root, '3_审核');
  fs.mkdirSync(transcribeDir, { recursive: true });
  fs.mkdirSync(analysisDir, { recursive: true });
  fs.mkdirSync(reviewDir, { recursive: true });

  const { words, sentenceMap } = makeTranscript();
  const manifest = planReviewChunks({ words, sentenceMap, restartCandidates: { candidates: [] } });
  assert.strictEqual(manifest.mode, 'streaming', '测试素材必须进入流式模式');
  const review = createStreamingReviewState(manifest);
  fs.writeFileSync(path.join(transcribeDir, 'subtitles_words.json'), JSON.stringify(words));
  fs.writeFileSync(path.join(analysisDir, 'sentence_map.json'), JSON.stringify(sentenceMap));
  fs.writeFileSync(path.join(analysisDir, 'review_chunks.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(reviewDir, 'data.json'), JSON.stringify({
    words,
    autoSelected: [],
    baseAutoSelected: [],
    review,
  }));

  const errorsFile = path.join(analysisDir, 'chunk-001.speech_errors.json');
  fs.writeFileSync(errorsFile, JSON.stringify({ delete_sentences: [], delete_idx: [] }));
  const output = execFileSync(process.execPath, [
    path.join(__dirname, 'publish_review_chunk.js'),
    analysisDir,
    reviewDir,
    'chunk-001',
    errorsFile,
  ], { encoding: 'utf8' });
  assert(output.includes('已发布 chunk-001'), '发布命令必须输出批次完成信息');

  const saved = JSON.parse(fs.readFileSync(path.join(reviewDir, 'data.json'), 'utf8'));
  assert.strictEqual(saved.review.chunks[0].status, 'ready', '发布后首批必须 ready');
  assert.strictEqual(saved.review.chunks[1].status, 'analyzing', '发布后下一批必须开始分析');
  assert(saved.autoSelected.includes(0), '限定范围的 auto_filler 必须把本批独立“嗯”合并到审核预选');

  fs.writeFileSync(errorsFile, JSON.stringify({ delete_sentences: [saved.review.chunks[1].core.startSentence], delete_idx: [] }));
  assert.throws(() => execFileSync(process.execPath, [
    path.join(__dirname, 'publish_review_chunk.js'),
    analysisDir,
    reviewDir,
    'chunk-001',
    errorsFile,
    '--replace',
    '--skip-auto-filler',
  ], { encoding: 'utf8', stdio: 'pipe' }), /发布审核批次失败/, '越过 core 的删除清单必须被拒绝');

  console.log('stream chunk publish CLI test passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
