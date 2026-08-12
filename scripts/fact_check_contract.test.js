'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  applyApprovedCorrections,
  applyDecisions,
  buildApprovalTemplate,
  ensureCaptionInput,
  normalizeFactMap,
  normalizeVerification,
} = require('./lib/fact_check_contract');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-jian-koubo-fact-contract-'));
try {
  const captionDir = path.join(root, '4_字幕');
  fs.mkdirSync(captionDir, { recursive: true });
  fs.writeFileSync(path.join(captionDir, 'corrected.txt'), '王宏获得了奖项\n邓玉是她的同学\n');
  fs.writeFileSync(path.join(captionDir, 'retained_transcript.json'), JSON.stringify({
    lines: [
      { text: '王宏获得了奖项', sourceStart: 0, sourceEnd: 2, sourceWordIndices: [0, 1, 2, 3, 4, 5, 6] },
      { text: '邓玉是她的同学', sourceStart: 2, sourceEnd: 4, sourceWordIndices: [7, 8, 9, 10, 11, 12, 13] },
    ],
    retainedWords: [
      ...[...'王宏获得了奖项'].map((text, sourceIndex) => ({ text, sourceIndex, start: sourceIndex * 0.1, end: (sourceIndex + 1) * 0.1 })),
      ...[...'邓玉是她的同学'].map((text, index) => ({ text, sourceIndex: index + 7, start: (index + 7) * 0.1, end: (index + 8) * 0.1 })),
    ],
  }, null, 2));

  const document = ensureCaptionInput(captionDir);
  const factMap = normalizeFactMap({
    documentBrief: '两位数学获奖者的故事',
    candidates: [
      {
        name: '王虹', type: 'PERSON', variants: ['王宏'], risk: 'high',
        occurrences: [{ line: 1, mention: '王宏', before: '', after: '获得了' }],
      },
      {
        name: '邓煜', type: 'PERSON', variants: ['邓玉'], risk: 'high',
        occurrences: [{ line: 2, mention: '邓玉', before: '', after: '是她的' }],
      },
    ],
  }, document);
  assert.strictEqual(factMap.candidates.length, 2, '可精确定位的实体应成为候选');
  assert.deepStrictEqual(factMap.candidates[0].occurrences[0].sourceWordIndices, [0, 1], '候选应精确关联回原始逐字索引');
  assert.strictEqual(factMap.candidates[0].occurrences[0].sourceMapping, 'aligned', '逐字映射存在时应使用对齐映射');

  const candidates = factMap.candidates.map((candidate, index) => ({
    ...candidate,
    verification: normalizeVerification({
      status: 'proposed',
      replacement: index === 0 ? '王虹' : '邓煜',
      confidence: 0.99,
      sources: [{ url: `https://example.com/${index}`, title: '权威来源', snippet: '证据' }],
    }),
  }));
  const template = buildApprovalTemplate(document, candidates);
  const approval = applyDecisions(template, candidates, { approve: ['FC-001'], by: 'tester' });
  const result = applyApprovedCorrections(document, candidates, approval);
  assert.strictEqual(result.outputText, '王虹获得了奖项\n邓玉是她的同学\n', '只应用明确批准的候选');
  assert.strictEqual(result.operations.length, 1, '批准候选只生成一个指定位置的操作');

  fs.writeFileSync(path.join(captionDir, 'corrected.txt'), '王虹获得了奖项\n邓玉是她的同学\n');
  const correctedNameDocument = ensureCaptionInput(captionDir);
  const correctedNameMap = normalizeFactMap({
    candidates: [{
      name: '王虹', type: 'PERSON', variants: ['王虹'], risk: 'high',
      occurrences: [{ line: 1, mention: '王虹', before: '', after: '获得了' }],
    }],
  }, correctedNameDocument);
  assert.deepStrictEqual(correctedNameMap.candidates[0].occurrences[0].sourceWordIndices, [0, 1], '基础纠错后的文本也必须精确回链原始逐字索引');
  assert.strictEqual(correctedNameMap.candidates[0].occurrences[0].sourceMapping, 'aligned');

  const noEvidence = normalizeVerification({ status: 'proposed', replacement: '王虹', confidence: 0.99 });
  assert.strictEqual(noEvidence.status, 'unresolved', '没有来源时不得形成可批准提案');
  const noChange = normalizeVerification({
    status: 'verified_no_change', confidence: 0.99,
    sources: [{ url: 'https://example.com/verified', title: '权威来源' }],
  });
  assert.strictEqual(noChange.status, 'verified_no_change', '有证据的无修改结论应与无法确认区分');

  fs.writeFileSync(path.join(captionDir, 'corrected.txt'), '王宏获得了新的奖项\n邓玉是她的同学\n');
  const changedDocument = ensureCaptionInput(captionDir);
  assert.throws(
    () => applyApprovedCorrections(changedDocument, candidates, approval),
    /基础纠错字幕已经变化/,
    '文本快照变化后不得套用旧批准决定'
  );

  console.log('fact check contract test passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
