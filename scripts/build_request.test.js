'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-jian-koubo-build-request-'));
try {
  const audio = path.join(root, 'probe.wav');
  fs.writeFileSync(audio, Buffer.from([0, 1, 2, 3]));
  const script = path.join(__dirname, 'lib', 'build_request.py');
  const verbatim = JSON.parse(execFileSync('python3', [script, audio, '--enable-itn', 'false'], { encoding: 'utf8' }));
  const normal = JSON.parse(execFileSync('python3', [script, audio], { encoding: 'utf8' }));
  assert.strictEqual(verbatim.request.enable_itn, false, '原样复听必须显式关闭 ITN');
  assert.strictEqual(verbatim.request.enable_punc, false, '原样复听不得补标点');
  assert.strictEqual(normal.request.enable_itn, true, '完整首次转录必须保持既有 ITN 默认值');
  console.log('build request ITN mode test passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
