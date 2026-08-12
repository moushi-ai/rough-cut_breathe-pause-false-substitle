'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { detectRestartCandidates } = require('./lib/detect_restarts');

function makeWords(sentenceTexts) {
  const words = [];
  const sentenceMap = [];
  let clock = 0;
  for (let sentenceIndex = 0; sentenceIndex < sentenceTexts.length; sentenceIndex++) {
    const startIdx = words.length;
    for (const text of [...sentenceTexts[sentenceIndex]]) {
      words.push({ text, start: clock, end: clock + 0.1, isGap: false });
      clock += 0.1;
    }
    sentenceMap.push({ startIdx, endIdx: words.length - 1 });
    if (sentenceIndex < sentenceTexts.length - 1) {
      words.push({ text: '', start: clock, end: clock + 0.3, isGap: true });
      clock += 0.3;
    }
  }
  return { words, sentenceMap };
}

const nearby = makeWords([
  '第一届在北边一月七号温州举办第二届绿色甲醇能源',
  '一月七号温州举办第二届绿色甲醇能源产业发展论坛',
]);
const nearbyResult = detectRestartCandidates(nearby);
const nearbyCandidate = nearbyResult.candidates.find(candidate => candidate.kind === 'nearby-sentence-restart');
assert(nearbyCandidate, '前短后长的邻句重说必须产生待审核候选');
assert.strictEqual(nearbyCandidate.sourceSentence, 0);
assert.strictEqual(nearbyCandidate.restartSentence, 1);
assert(nearbyCandidate.overlapText.includes('一月七号温州举办'), '候选应保留可核对的重复锚点');
assert(nearbyCandidate.reviewInstruction.includes('不打删除标'), '候选必须明确不是自动删除');
assert(
  nearbyCandidate.sourceSentenceRange.startIdx <= nearbyCandidate.suggestedDelete.startIdx,
  '候选必须提供完整源句范围，供语义层确认草稿的实际起点',
);

const fuzzyNearby = makeWords([
  '就是他就微笑看着他然后呢王宏后来说这个教会了一件他非常重要的事一个想法到底靠不靠谱得自己想明白',
  '不能靠别人等你',
  '就是不能靠',
  '王红后来说呀这教会了她一件非常重要的事一个想法到底靠不靠谱呢得自己想明白不能等别人告诉你',
]);
assert(
  detectRestartCandidates(fuzzyNearby).candidates.some(candidate => candidate.sourceSentence === 0 && candidate.restartSentence === 3),
  '应容忍少量 ASR 代词差异和语气词插入，找出隔句的完整重说',
);

const inline = makeWords(['这个方案我们先做一个小版本这个方案我们先做一个小版本再上线验证']);
const inlineResult = detectRestartCandidates(inline);
assert(
  inlineResult.candidates.some(candidate => candidate.kind === 'inline-restart'),
  '同句内前短后长的重说必须产生待审核候选',
);

const nonRestart = makeWords(['大家大家一起努力']);
assert.strictEqual(
  detectRestartCandidates(nonRestart).candidates.length,
  0,
  '短促重复不能被误判为完整重说',
);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-jian-koubo-restart-test-'));
try {
  const input = path.join(root, 'subtitles_words.json');
  const output = path.join(root, '2_分析');
  fs.writeFileSync(input, `${JSON.stringify(nearby.words, null, 2)}\n`);
  execFileSync(process.execPath, [path.join(__dirname, 'gen_analysis.js'), input, output], { encoding: 'utf8' });
  const generated = JSON.parse(fs.readFileSync(path.join(output, 'restart_candidates.json'), 'utf8'));
  assert(generated.candidates.length > 0, 'gen_analysis.js 必须输出 restart_candidates.json');
  assert(fs.existsSync(path.join(output, 'analysis.txt')), '既有 analysis.txt 输出必须仍然存在');
  assert(fs.existsSync(path.join(output, 'sentence_map.json')), '既有 sentence_map.json 输出必须仍然存在');
  // 模拟语义层确认：候选本身不选中，确认后写 delete_idx，再由正式合并脚本送进审核预选。
  const confirmed = generated.candidates[0].suggestedDelete;
  const deleteIdx = [];
  for (let idx = confirmed.startIdx; idx <= confirmed.endIdx; idx++) {
    if (!nearby.words[idx].isGap) deleteIdx.push(idx);
  }
  fs.writeFileSync(path.join(output, 'speech_errors.json'), JSON.stringify({ delete_sentences: [], delete_idx: deleteIdx }));
  execFileSync(process.execPath, [
    path.join(__dirname, 'merge_selections.js'),
    path.join(output, 'sentence_map.json'),
    path.join(output, 'speech_errors.json'),
    path.join(output, 'auto_selected.json'),
  ], { encoding: 'utf8' });
  const reviewPreselected = JSON.parse(fs.readFileSync(path.join(output, 'auto_selected.json'), 'utf8'));
  assert(reviewPreselected.includes(confirmed.startIdx), '语义确认后的重说范围必须进入审核页预选');
  assert(reviewPreselected.includes(confirmed.endIdx), '语义确认后的重说范围必须完整进入审核页预选');
  console.log('restart candidate detection test passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
