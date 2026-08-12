'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scriptsDir = __dirname;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-jian-koubo-ab-test-'));

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function run(script, args) {
  return execFileSync(process.execPath, [path.join(scriptsDir, script), ...args], { encoding: 'utf8' });
}

try {
  const skillDir = path.join(root, 'skill');
  fs.mkdirSync(path.join(skillDir, '用户习惯'), { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# test skill\n');
  fs.writeFileSync(path.join(skillDir, '用户习惯', '规则.md'), '# baseline\n');
  fs.writeFileSync(path.join(skillDir, '用户习惯', '经验规则.md'), '# learned\n');
  const runtimeFiles = [
    'scripts/run_model_ab.sh',
    'scripts/complete_model_ab.sh',
    'scripts/volcengine_flash_transcribe.sh',
    'scripts/volcengine_seedasr2_transcribe.sh',
    'scripts/generate_subtitles.js',
    'scripts/gen_analysis.js',
    'scripts/auto_filler.js',
    'scripts/merge_selections.js',
    'scripts/generate_review.js',
    'scripts/review_server.js',
    'scripts/lib/compute_keeps.js',
    'scripts/lib/fcpxml.js',
  ];
  for (const file of runtimeFiles) {
    const target = path.join(skillDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `// ${file}\n`);
  }
  const personalRules = path.join(root, 'personal-rules');
  fs.mkdirSync(personalRules, { recursive: true });
  fs.writeFileSync(path.join(personalRules, '规则.md'), '# personal baseline\n');
  fs.writeFileSync(path.join(personalRules, '经验规则.md'), '# personal learned v1\n');

  const video = path.join(root, 'source.mp4');
  const audio = path.join(root, 'ab', 'shared', 'audio.mp3');
  fs.mkdirSync(path.dirname(audio), { recursive: true });
  fs.writeFileSync(video, 'video');
  fs.writeFileSync(audio, 'audio');
  const abDir = path.join(root, 'ab');

  run('create_model_ab_manifest.js', ['init', abDir, video, audio, skillDir, personalRules]);
  let manifest = JSON.parse(fs.readFileSync(path.join(abDir, 'manifest.json'), 'utf8'));
  assert.strictEqual(manifest.variants.A.asr.engine, 'flash');
  assert.strictEqual(manifest.variants.B.asr.engine, 'seedasr2');
  assert(fs.existsSync(path.join(abDir, 'contract', '经验规则.md')));
  assert.strictEqual(manifest.contract.preferencesSourceDir, personalRules);
  assert.strictEqual(fs.readFileSync(path.join(abDir, 'contract', '经验规则.md'), 'utf8'), '# personal learned v1\n');
  assert(fs.existsSync(path.join(abDir, 'contract', 'runtime', 'scripts', 'run_model_ab.sh')));

  fs.writeFileSync(path.join(personalRules, '经验规则.md'), '# personal learned v2\n');
  run('create_model_ab_manifest.js', ['freeze-contract', abDir, skillDir, personalRules]);
  manifest = JSON.parse(fs.readFileSync(path.join(abDir, 'manifest.json'), 'utf8'));
  assert(manifest.contractRefreshedAt, '刷新合同后应记录时间');
  assert.strictEqual(fs.readFileSync(path.join(abDir, 'contract', '经验规则.md'), 'utf8'), '# personal learned v2\n');

  const words = [
    { text: '甲', start: 0, end: 0.5, isGap: false },
    { text: '', start: 0.5, end: 0.8, isGap: true },
    { text: '乙', start: 0.8, end: 1.2, isGap: false },
  ];
  for (const variant of ['A', 'B']) {
    const variantDir = path.join(abDir, variant);
    const analysisDir = path.join(variantDir, '2_分析');
    writeJson(path.join(variantDir, '1_转录', 'subtitles_words.json'), words);
    fs.mkdirSync(analysisDir, { recursive: true });
    fs.writeFileSync(path.join(analysisDir, 'analysis.txt'), '0: 甲乙\n');
    writeJson(path.join(analysisDir, 'sentence_map.json'), [{ startIdx: 0, endIdx: 2 }]);
    writeJson(path.join(analysisDir, 'auto_selected.json'), [1]);
    writeJson(path.join(analysisDir, 'speech_errors.json'), { delete_sentences: [], delete_idx: [0] });
    run('create_model_ab_manifest.js', ['analysis-context', abDir, variant]);
    run('mark_model_ab_analysis_complete.js', [analysisDir, 'test-agent']);
    run('mark_model_ab_analysis_complete.js', ['--check', analysisDir]);

    const reviewDir = path.join(variantDir, '3_审核');
    fs.mkdirSync(reviewDir, { recursive: true });
    writeJson(path.join(reviewDir, 'data.json'), { words, autoSelected: [0, 1] });
    writeJson(path.join(reviewDir, 'silence_periods.json'), []);
    writeJson(path.join(reviewDir, 'peaks.json'), { duration: 1.2, peaks: [0, 0] });
    writeJson(path.join(reviewDir, 'ab_review_meta.json'), { variant, displayLabel: variant, runId: manifest.runId });
    writeJson(path.join(reviewDir, 'review_log.json'), {
      aiSelected: [0, 1],
      finalSelected: [0, 1],
      deleteList: [{ start: 0, end: 0.8 }],
      opts: { lookBack: 0.6, padStart: 0.05, padEnd: 0.05, minInternalSilence: 0.2 },
      reviewSession: { durationSeconds: 12, editCount: 1 },
      ab: { variant },
    });
  }

  run('compare_model_ab.js', [abDir]);
  const comparison = JSON.parse(fs.readFileSync(path.join(abDir, 'comparison', 'model_ab_comparison.json'), 'utf8'));
  assert.strictEqual(comparison.variants.length, 2);
  assert.strictEqual(comparison.variants[0].semanticSelection.precisionPercent, 100);
  assert.strictEqual(comparison.variants[0].cutSafety.keptWordBoundaryViolations, 0);
  console.log('model A/B contract test passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
