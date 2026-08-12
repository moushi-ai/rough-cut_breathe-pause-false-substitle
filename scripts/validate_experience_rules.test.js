'use strict';

const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const script = path.join(__dirname, 'validate_experience_rules.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-jian-koubo-rules-test-'));
const rules = path.join(root, '经验规则.md');

try {
  fs.writeFileSync(rules, [
    '# 经验规则（机器学习产出，需人工确认）',
    '',
    '### 1. 规则',
    '',
    '保留自然语气词。',
    '',
    '（学于 测试视频 2026-08-12；已确认）',
  ].join('\n'));
  const output = execFileSync(process.execPath, [script, rules, '--require-confirmed'], { encoding: 'utf8' });
  assert(output.includes('校验通过'));

  const jsonOutput = execFileSync(process.execPath, [script, rules, '--require-confirmed', '--json'], { encoding: 'utf8' });
  assert.strictEqual(JSON.parse(jsonOutput).confirmedRules, 1);

  fs.writeFileSync(rules, `# 经验规则\n\nVOLCENGINE_${'API_KEY'}=should-not-be-here\n`);
  const badSecret = spawnSync(process.execPath, [script, rules], { encoding: 'utf8' });
  assert.notStrictEqual(badSecret.status, 0, '疑似密钥应被拒绝');

  fs.writeFileSync(rules, '# 经验规则\n\n_（暂无。第一次跑学习后，确认的规则会写在这里。）_\n');
  const unconfirmed = spawnSync(process.execPath, [script, rules, '--require-confirmed'], { encoding: 'utf8' });
  assert.notStrictEqual(unconfirmed.status, 0, '无确认标签不应被提交');

  fs.writeFileSync(rules, [
    '# 经验规则',
    '',
    '## 规则正文',
    '',
    '### 1. 已确认规则',
    '',
    '保留自然语气词。',
    '',
    '（学于 测试视频 2026-08-12；已确认）',
    '',
    '### 2. 未确认规则',
    '',
    '不要切掉句末停顿。',
  ].join('\n'));
  const mixedRules = spawnSync(process.execPath, [script, rules, '--require-confirmed'], { encoding: 'utf8' });
  assert.notStrictEqual(mixedRules.status, 0, '混入未确认规则不应被提交');

  console.log('experience rules validation test passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
