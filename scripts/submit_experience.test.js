'use strict';

/*
 * 在隔离 Git 仓库中验证经验提交脚本：成功路径只提交规则文件并推送，
 * 已暂存的无关文件会阻止下一次提交。不会访问真实远程仓库。
 */

const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sourceRoot = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-jian-koubo-submit-test-'));
const remote = path.join(root, 'remote.git');
const repo = path.join(root, 'repo');

function git(args, cwd = repo) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

try {
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(repo, '用户习惯'), { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, 'scripts', 'submit_experience.sh'), path.join(repo, 'scripts', 'submit_experience.sh'));
  fs.copyFileSync(path.join(sourceRoot, 'scripts', 'validate_experience_rules.js'), path.join(repo, 'scripts', 'validate_experience_rules.js'));
  fs.writeFileSync(path.join(repo, '用户习惯', '经验规则.md'), [
    '# 经验规则',
    '',
    '## 规则正文',
    '',
    '### 1. 原始规则',
    '',
    '保留自然语气词。',
    '',
    '（学于 初始样本 2026-08-01；已确认）',
  ].join('\n'));

  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Experience Test']);
  git(['config', 'user.email', 'experience-test@example.invalid']);
  git(['add', '.']);
  git(['commit', '-m', 'init']);
  git(['init', '--bare', remote], root);
  git(['remote', 'add', 'origin', remote]);
  git(['push', '-u', 'origin', 'main']);

  fs.appendFileSync(path.join(repo, '用户习惯', '经验规则.md'), [
    '',
    '### 2. 新规则',
    '',
    '回听临近切点的语气词。',
    '',
    '（学于 团队测试 2026-08-12；已确认）',
  ].join('\n'));

  const success = spawnSync('bash', ['scripts/submit_experience.sh', '团队测试'], {
    cwd: repo,
    encoding: 'utf8',
  });
  assert.strictEqual(success.status, 0, success.stdout + success.stderr);
  assert(success.stdout.includes('团队经验已推送'));

  const committedFiles = git(['-c', 'core.quotePath=false', 'show', '--format=', '--name-only', 'HEAD'])
    .trim()
    .split('\n')
    .filter(Boolean);
  assert.deepStrictEqual(committedFiles, ['用户习惯/经验规则.md']);
  assert(git(['--git-dir', remote, 'log', '--format=%s', '-1', 'main'], root).startsWith('learn: 团队测试'));

  fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'do not mix into experience commit\n');
  git(['add', 'unrelated.txt']);
  fs.appendFileSync(path.join(repo, '用户习惯', '经验规则.md'), '\n<!-- later confirmed edit -->\n');
  const blocked = spawnSync('bash', ['scripts/submit_experience.sh', '--dry-run', '第二次团队测试'], {
    cwd: repo,
    encoding: 'utf8',
  });
  assert.notStrictEqual(blocked.status, 0, '已暂存无关文件时应拒绝提交');
  assert(blocked.stdout.includes('已暂存的无关文件'));

  console.log('submit experience integration test passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
