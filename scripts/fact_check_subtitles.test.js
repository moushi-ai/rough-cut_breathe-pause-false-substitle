'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runFactCheck } = require('./fact_check_subtitles');
const { approveFactCorrections } = require('./approve_fact_corrections');
const { applyFactCorrections } = require('./apply_fact_corrections');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-jian-koubo-fact-flow-'));
  try {
    const captionDir = path.join(root, '4_字幕');
    fs.mkdirSync(captionDir, { recursive: true });
    fs.writeFileSync(path.join(captionDir, 'corrected.txt'), '邓玉和王虹一起获奖\n');
    fs.writeFileSync(path.join(captionDir, 'retained_transcript.json'), JSON.stringify({
      lines: [{ text: '邓玉和王虹一起获奖', sourceStart: 0, sourceEnd: 3, sourceWordIndices: [0, 1, 2, 3, 4, 5, 6, 7] }],
    }, null, 2));
    const mockFile = path.join(root, 'mock.json');
    fs.writeFileSync(mockFile, JSON.stringify({
      model: 'mock-doubao',
      factMapText: '[FACT_MAP]\nTOPICS: 数学 | 获奖\n[CANDIDATE]\nTYPE: PERSON\nVARIANT: 邓玉\nRISK: high\n[OCCURRENCE]\nLINE: 1\nMENTION: 邓玉\nBEFORE: \nAFTER: 和王虹\n[/OCCURRENCE]\n[/CANDIDATE]\n[/FACT_MAP]',
      verifications: {
        'FC-001': {
          webSearchUsed: true,
          text: '[ANSWER]\nANSWER: 邓玉 -> 邓煜\nCONFIDENCE: 0.98\nREASON: 权威页面列出正确姓名\n[/ANSWER]',
          evidence: [{ url: 'https://example.com/deng', title: '官方页面', snippet: '邓煜' }],
        },
      },
    }, null, 2));

    const factCheck = await runFactCheck({ captionDir, mockFile, maxCandidates: 20, model: '' });
    assert.strictEqual(factCheck.candidates.length, 1);
    assert.strictEqual(factCheck.candidates[0].verification.status, 'proposed');
    assert.strictEqual(fs.existsSync(factCheck.files.report), true, '必须生成可审阅候选报告');
    assert.strictEqual(fs.readFileSync(path.join(captionDir, 'corrected.txt'), 'utf8'), '邓玉和王虹一起获奖\n', '生成候选前不得改字幕');

    approveFactCorrections({ captionDir, approve: ['FC-001'], reject: [], by: 'tester', note: '' });
    const applied = applyFactCorrections({ captionDir });
    assert.strictEqual(fs.readFileSync(applied.outputFile, 'utf8'), '邓煜和王虹一起获奖\n');
    assert.strictEqual(applied.applied.operations.length, 1);

    const noChangeFile = path.join(root, 'no-change.json');
    fs.writeFileSync(noChangeFile, JSON.stringify({
      factMap: {
        documentBrief: '数学获奖人物介绍',
        candidates: [{
          name: '王虹', type: 'PERSON', variants: ['王虹'], risk: 'high',
          occurrences: [{ line: 1, mention: '王虹', before: '邓玉和', after: '一起获奖' }],
        }],
      },
      verifications: {
        'FC-001': {
          webSearchUsed: true,
          response: {
            status: 'proposed', replacement: '王虹', confidence: 0.98,
            sources: [{ url: 'https://example.com/wang', title: '官方页面', snippet: '王虹' }],
          },
        },
      },
    }, null, 2));
    const noChange = await runFactCheck({ captionDir, mockFile: noChangeFile, maxCandidates: 20, model: '' });
    assert.strictEqual(noChange.candidates[0].verification.status, 'verified_no_change', '原文已正确时应记录为已核验、无需修改');

    const unsafeFile = path.join(root, 'unsafe.json');
    fs.writeFileSync(unsafeFile, JSON.stringify({
      factMap: {
        documentBrief: '数学获奖人物介绍',
        candidates: [{
          name: '王虹', type: 'PERSON', variants: ['王虹'], risk: 'high',
          occurrences: [{ line: 1, mention: '王虹', before: '邓玉和', after: '一起获奖' }],
        }],
      },
      verifications: {
        'FC-001': {
          webSearchUsed: true,
          response: {
            status: 'proposed', replacement: '邓玉和王虹一起获奖', confidence: 0.98,
            sources: [{ url: 'https://example.com/unsafe', title: '官方页面', snippet: '王虹' }],
          },
        },
      },
    }, null, 2));
    const unsafe = await runFactCheck({ captionDir, mockFile: unsafeFile, maxCandidates: 20, model: '' });
    assert.strictEqual(unsafe.candidates[0].verification.status, 'unresolved', '句子级替换不得进入人工审批');
    assert.match(unsafe.candidates[0].verification.reason, /短实体\/日期\/术语/);
    console.log('fact check subtitle flow test passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
