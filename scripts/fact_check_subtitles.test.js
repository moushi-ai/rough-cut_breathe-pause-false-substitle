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
      factMapText: '[FACT_MAP]\nBRIEF: 数学 | 获奖人物\nTOPICS: 数学 | 获奖\n[CANDIDATE]\nTYPE: PERSON\nVARIANT: 邓玉\nRISK: high\n[OCCURRENCE]\nLINE: 1\nMENTION: 邓玉\nBEFORE: \nAFTER: 和王虹\n[/OCCURRENCE]\n[/CANDIDATE]\n[/FACT_MAP]',
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

    const numberCaptionDir = path.join(root, 'number-4_字幕');
    fs.mkdirSync(numberCaptionDir, { recursive: true });
    const numberLine = '石油对外依存度超过了72';
    const numberWords = [...numberLine].map((text, sourceIndex) => ({
      text, sourceIndex, start: sourceIndex * 0.1, end: (sourceIndex + 1) * 0.1,
    }));
    fs.writeFileSync(path.join(numberCaptionDir, 'corrected.txt'), `${numberLine}\n`);
    fs.writeFileSync(path.join(numberCaptionDir, 'retained_transcript.json'), JSON.stringify({
      lines: [{ text: numberLine, sourceStart: 0, sourceEnd: numberWords.length * 0.1, sourceWordIndices: numberWords.map(word => word.sourceIndex) }],
      retainedWords: numberWords,
    }, null, 2));
    const numberMockFile = path.join(root, 'number-mock.json');
    fs.writeFileSync(numberMockFile, JSON.stringify({
      model: 'mock-doubao',
      factMapText: '[FACT_MAP]\nBRIEF: 石油依存度 | 能源安全\nTOPICS: 能源 | 石油\n[CANDIDATE]\nTYPE: NUMBER\nVARIANT: 72\nRISK: high\n[OCCURRENCE]\nLINE: 1\nMENTION: 72\nBEFORE: 超过了\nAFTER: \n[/OCCURRENCE]\n[/CANDIDATE]\n[/FACT_MAP]',
      audioRechecks: {
        'FC-001': {
          status: 'verified',
          sourceAudio: 'audio.mp3',
          window: {
            candidateStart: 1.1, candidateEnd: 1.3, clipStart: 0, clipEnd: 3.3, durationSeconds: 3.3,
            beforeSeconds: 1.1, afterSeconds: 2, policy: '连续原始音频窗口；候选前 2.00 秒、候选后 2.00 秒；不删静音、不拼接、不改速',
          },
          firstPass: { wordText: '石油对外依存度超过了72', utteranceText: '石油对外依存度超过了72', resultText: '' },
          secondPass: {
            engine: 'volc.bigasr.auc_turbo',
            request: { enableItn: false, enablePunc: false, showUtterances: true, mode: 'verbatim_audio_recheck' },
            wordText: '石油对外依存度超过了百分之七十二', utteranceText: '石油对外依存度超过了百分之七十二', resultText: '', resultSha256: 'mock',
          },
        },
      },
      audioDecisions: {
        'FC-001': {
          text: '[AUDIO_DECISION]\nANSWER: 72 -> 72%\nCONFIDENCE: 0.98\nREASON: 二遍原样复听文本为百分之七十二\n[/AUDIO_DECISION]',
        },
      },
    }, null, 2));
    const numberFactCheck = await runFactCheck({ captionDir: numberCaptionDir, mockFile: numberMockFile, maxCandidates: 20, model: '' });
    assert.strictEqual(numberFactCheck.candidates[0].verification.status, 'proposed', '明确的声学复核可形成待人工确认候选');
    assert.strictEqual(numberFactCheck.candidates[0].verification.replacement, '72%');
    assert.strictEqual(numberFactCheck.candidates[0].verification.evidenceType, 'audio_recheck');
    assert.match(fs.readFileSync(numberFactCheck.files.report, 'utf8'), /二遍 ASR 原样文本：石油对外依存度超过了百分之七十二/);
    approveFactCorrections({ captionDir: numberCaptionDir, approve: ['FC-001'], reject: [], by: 'tester', note: '' });
    const numberApplied = applyFactCorrections({ captionDir: numberCaptionDir });
    assert.strictEqual(fs.readFileSync(numberApplied.outputFile, 'utf8'), '石油对外依存度超过了72%\n', '声学候选也必须只在人工批准后应用');

    const malformedAudioDecisionFile = path.join(root, 'number-malformed-audio-decision.json');
    const malformedMock = JSON.parse(fs.readFileSync(numberMockFile, 'utf8'));
    malformedMock.audioDecisions['FC-001'] = { response: null };
    fs.writeFileSync(malformedAudioDecisionFile, JSON.stringify(malformedMock, null, 2));
    const malformedAudioDecision = await runFactCheck({
      captionDir: numberCaptionDir,
      mockFile: malformedAudioDecisionFile,
      maxCandidates: 20,
      model: '',
    });
    assert.strictEqual(
      malformedAudioDecision.candidates[0].verification.status,
      'unresolved',
      '缺失或格式错误的声学裁决不得进入人工批准'
    );

    const multipleOccurrencesFile = path.join(root, 'number-multiple-occurrences.json');
    const multipleOccurrencesMock = JSON.parse(fs.readFileSync(numberMockFile, 'utf8'));
    multipleOccurrencesMock.factMapText = '[FACT_MAP]\nBRIEF: 石油依存度 | 能源安全\nTOPICS: 能源 | 石油\n[CANDIDATE]\nTYPE: NUMBER\nVARIANT: 72\nRISK: high\n[OCCURRENCE]\nLINE: 1\nMENTION: 72\nBEFORE: 超过了\nAFTER: \n[/OCCURRENCE]\n[OCCURRENCE]\nLINE: 1\nMENTION: 72\nBEFORE: 超过了\nAFTER: \n[/OCCURRENCE]\n[/CANDIDATE]\n[/FACT_MAP]';
    fs.writeFileSync(multipleOccurrencesFile, JSON.stringify(multipleOccurrencesMock, null, 2));
    const multipleOccurrences = await runFactCheck({
      captionDir: numberCaptionDir,
      mockFile: multipleOccurrencesFile,
      maxCandidates: 20,
      model: '',
    });
    assert.strictEqual(
      multipleOccurrences.candidates[0].verification.status,
      'unresolved',
      '一个裸数字候选对应多个位置时不得交给模型猜单位'
    );
    assert.match(multipleOccurrences.candidates[0].verification.reason, /一个精确出现位置/);
    console.log('fact check subtitle flow test passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
