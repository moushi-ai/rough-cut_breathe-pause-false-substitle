'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const script = path.join(__dirname, 'auto_filler.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-jian-koubo-auto-filler-'));
const mapFile = path.join(root, 'sentence_map.json');
const wordsFile = path.join(root, 'subtitles_words.json');
const errorsFile = path.join(root, 'speech_errors.json');

try {
  fs.writeFileSync(mapFile, JSON.stringify([
    { startIdx: 0, endIdx: 8 },
    { startIdx: 9, endIdx: 9 },
    { startIdx: 10, endIdx: 19 },
    { startIdx: 20, endIdx: 29 },
    { startIdx: 30, endIdx: 33 },
    { startIdx: 34, endIdx: 35 },
    { startIdx: 36, endIdx: 38 },
    { startIdx: 39, endIdx: 40 },
    { startIdx: 41, endIdx: 42 },
  ]));
  fs.writeFileSync(wordsFile, JSON.stringify([
    { text: '啊' }, { text: '这' }, { text: '是' }, { text: '一' }, { text: '个' }, { text: '完' }, { text: '整' }, { text: '呢' }, { text: '啊' },
    { text: '嗯' },
    { text: '然' }, { text: '后' }, { text: '先' }, { text: '核' }, { text: '对' }, { text: '数' }, { text: '据' }, { text: '再' }, { text: '发' }, { text: '布' },
    { text: '先' }, { text: '核' }, { text: '对' }, { text: '数' }, { text: '据' }, { text: '然' }, { text: '后' }, { text: '再' }, { text: '发' }, { text: '布' },
    { text: '三' }, { text: '二' }, { text: '一' }, { text: '好' },
    { text: '321' }, { text: '但' },
    { text: '三' }, { text: '二' }, { text: '甲' },
    { text: '321' }, { text: '年' },
    { text: 'A' }, { text: '321' },
  ]));
  fs.writeFileSync(errorsFile, JSON.stringify({ delete_sentences: [], delete_idx: [] }));

  execFileSync(process.execPath, [script, mapFile, wordsFile, errorsFile], { encoding: 'utf8' });
  const result = JSON.parse(fs.readFileSync(errorsFile, 'utf8'));
  assert(!result.delete_idx.includes(0), '自然句首“啊”必须默认保留');
  assert(!result.delete_idx.includes(7), '功能性句尾“呢”必须默认保留');
  assert(!result.delete_idx.includes(8), '自然句尾“啊”必须默认保留');
  assert(result.delete_idx.includes(9), '独立“嗯”仍应进入自动候选');
  assert(!result.delete_idx.includes(10) && !result.delete_idx.includes(11), '句首表达真实时序的“然后”不得自动删除');
  assert(!result.delete_idx.includes(25) && !result.delete_idx.includes(26), '句中表达真实时序的“然后”不得自动删除');
  assert(result.delete_idx.includes(30) && result.delete_idx.includes(31) && result.delete_idx.includes(32), '拆成三词的“三二一”必须精确进入自动删除');
  assert(!result.delete_idx.includes(33), '删除“三二一”不得吞掉后续正文');
  assert(result.delete_idx.includes(34), '独立“321”必须精确进入自动删除');
  assert(!result.delete_idx.includes(35), '删除“321”不得吞掉黏连后的正文');
  assert(!result.delete_idx.includes(36) && !result.delete_idx.includes(37), '非完整“三二一”不得误判为录制口令');
  assert(!result.delete_idx.includes(39), '带数量单位的“321年”不得误删为录制口令');
  assert(!result.delete_idx.includes(42), '英文型号 A321 中的 321 不得误删为录制口令');
  console.log('auto filler natural-a-ne protection test passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
