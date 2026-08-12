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
    { startIdx: 0, endIdx: 7 },
    { startIdx: 8, endIdx: 8 },
  ]));
  fs.writeFileSync(wordsFile, JSON.stringify([
    { text: '啊' }, { text: '这' }, { text: '是' }, { text: '一' }, { text: '个' }, { text: '完' }, { text: '整' }, { text: '啊' },
    { text: '嗯' },
  ]));
  fs.writeFileSync(errorsFile, JSON.stringify({ delete_sentences: [], delete_idx: [] }));

  execFileSync(process.execPath, [script, mapFile, wordsFile, errorsFile], { encoding: 'utf8' });
  const result = JSON.parse(fs.readFileSync(errorsFile, 'utf8'));
  assert(!result.delete_idx.includes(0), '自然句首“啊”必须默认保留');
  assert(!result.delete_idx.includes(7), '自然句尾“啊”必须默认保留');
  assert(result.delete_idx.includes(8), '独立“嗯”仍应进入自动候选');
  console.log('auto filler natural-a protection test passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
