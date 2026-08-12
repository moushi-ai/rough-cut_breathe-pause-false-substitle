#!/usr/bin/env node
/*
 * 为完整模型 A/B 建立可复现实验合同，并为每个审核页写入不暴露模型名的盲审元数据。
 *
 * 用法:
 *   node create_model_ab_manifest.js init <ab_dir> <video> <audio> <skill_dir> [rules_dir]
 *   node create_model_ab_manifest.js freeze-contract <ab_dir> <skill_dir> [rules_dir]
 *   node create_model_ab_manifest.js analysis-context <ab_dir> <A|B>
 *   node create_model_ab_manifest.js review-meta <ab_dir> <A|B>
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const [, , command, ...args] = process.argv;

function die(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    die(`无法读取 JSON：${file} (${error.message})`);
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function gitCommit(skillDir) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: skillDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (_) {
    return null;
  }
}

function gitWorkingTreeDirty(skillDir) {
  try {
    return execFileSync('git', ['status', '--porcelain'], {
      cwd: skillDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().length > 0;
  } catch (_) {
    return null;
  }
}

function requireVariant(variant) {
  if (!['A', 'B'].includes(variant)) die('变体必须是 A 或 B');
  return variant;
}

function loadManifest(abDir) {
  const manifestFile = path.join(abDir, 'manifest.json');
  if (!fs.existsSync(manifestFile)) die(`找不到 manifest.json：${manifestFile}`);
  return readJson(manifestFile);
}

const RUNTIME_FILES = [
  'scripts/run_model_ab.sh',
  'scripts/complete_model_ab.sh',
  'scripts/volcengine_flash_transcribe.sh',
  'scripts/volcengine_seedasr2_transcribe.sh',
  'scripts/generate_subtitles.js',
  'scripts/gen_analysis.js',
  'scripts/lib/detect_restarts.js',
  'scripts/auto_filler.js',
  'scripts/merge_selections.js',
  'scripts/generate_review.js',
  'scripts/review_server.js',
  'scripts/lib/compute_keeps.js',
  'scripts/lib/fcpxml.js',
];

function snapshotFile(abDir, source, target) {
  if (!fs.existsSync(source)) die(`缺少 A/B 合同文件：${source}`);
  const copied = path.join(abDir, 'contract', target);
  fs.mkdirSync(path.dirname(copied), { recursive: true });
  fs.copyFileSync(source, copied);
  return {
    source,
    snapshot: path.relative(abDir, copied),
    sha256: sha256File(source),
  };
}

function resolveRulesDir(skillDir, rulesDirInput) {
  const rulesDir = path.resolve(rulesDirInput || path.join(skillDir, '用户习惯'));
  for (const name of ['规则.md', '经验规则.md']) {
    if (!fs.existsSync(path.join(rulesDir, name))) {
      die(`规则目录缺少 ${name}：${rulesDir}`);
    }
  }
  return rulesDir;
}

function freezeContract(abDir, skillDir, rulesDirInput) {
  const rulesDir = resolveRulesDir(skillDir, rulesDirInput);
  const contract = {
    skill: snapshotFile(abDir, path.join(skillDir, 'SKILL.md'), 'SKILL.md'),
    baselineRules: snapshotFile(abDir, path.join(rulesDir, '规则.md'), '规则.md'),
    learnedRules: snapshotFile(abDir, path.join(rulesDir, '经验规则.md'), '经验规则.md'),
    preferencesSourceDir: rulesDir,
  };
  const runtime = {};
  for (const relative of RUNTIME_FILES) {
    runtime[relative] = snapshotFile(abDir, path.join(skillDir, relative), path.join('runtime', relative));
  }
  return {
    contract,
    code: {
      skillDir,
      gitCommit: gitCommit(skillDir),
      workingTreeDirty: gitWorkingTreeDirty(skillDir),
      runtime,
    },
  };
}

function init(abDirInput, videoInput, audioInput, skillDirInput, rulesDirInput) {
  const abDir = path.resolve(abDirInput);
  const video = path.resolve(videoInput);
  const audio = path.resolve(audioInput);
  const skillDir = path.resolve(skillDirInput);

  for (const [label, file] of [['视频', video], ['共享音频', audio]]) {
    if (!fs.existsSync(file)) die(`${label}不存在：${file}`);
  }

  const frozen = freezeContract(abDir, skillDir, rulesDirInput);

  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    runId: path.basename(abDir),
    source: {
      video: video,
      sharedAudio: path.relative(abDir, audio),
      sharedAudioBytes: fs.statSync(audio).size,
      sharedAudioSha256: sha256File(audio),
    },
    code: frozen.code,
    contract: frozen.contract,
    variants: {
      A: {
        displayLabel: 'A',
        asr: { engine: 'flash', resourceId: 'volc.bigasr.auc_turbo' },
      },
      B: {
        displayLabel: 'B',
        asr: { engine: 'seedasr2', resourceId: 'volc.seedasr.auc' },
      },
    },
    scoring: {
      unit: '源时间轴区间，而非逐字 idx',
      primaryMetrics: ['口误候选精确率', '口误候选召回率', '人工撤销', '人工补删', '审核时长', '切点安全'],
    },
  };
  writeJson(path.join(abDir, 'manifest.json'), manifest);
  console.log(`✅ 已写入 A/B 合同：${path.join(abDir, 'manifest.json')}`);
}

function freezeExistingContract(abDirInput, skillDirInput, rulesDirInput) {
  const abDir = path.resolve(abDirInput);
  const skillDir = path.resolve(skillDirInput);
  const manifest = loadManifest(abDir);
  for (const variant of ['A', 'B']) {
    const analysisDir = path.join(abDir, variant, '2_分析');
    for (const file of ['speech_errors.json', 'analysis_completion.json']) {
      if (fs.existsSync(path.join(analysisDir, file))) {
        die(`已开始 ${variant} 的语义分析，不能再替换合同：${path.join(analysisDir, file)}`);
      }
    }
  }
  const frozen = freezeContract(abDir, skillDir, rulesDirInput);
  manifest.code = frozen.code;
  manifest.contract = frozen.contract;
  manifest.contractRefreshedAt = new Date().toISOString();
  writeJson(path.join(abDir, 'manifest.json'), manifest);
  for (const variant of ['A', 'B']) {
    const analysisDir = path.join(abDir, variant, '2_分析');
    if (fs.existsSync(analysisDir)) writeAnalysisContext(abDir, variant);
  }
  console.log(`✅ 已刷新 A/B 合同：${path.join(abDir, 'manifest.json')}`);
}

function writeAnalysisContext(abDirInput, variantInput) {
  const abDir = path.resolve(abDirInput);
  const variant = requireVariant(variantInput);
  const manifest = loadManifest(abDir);
  const analysisDir = path.join(abDir, variant, '2_分析');
  for (const file of ['analysis.txt', 'sentence_map.json', 'auto_selected.json', 'restart_candidates.json']) {
    if (!fs.existsSync(path.join(analysisDir, file))) die(`${variant} 缺少分析输入：${file}`);
  }
  const restartCandidates = readJson(path.join(analysisDir, 'restart_candidates.json'));
  if (!restartCandidates || !Array.isArray(restartCandidates.candidates)) {
    die(`${variant} 的 restart_candidates.json 格式不正确：必须包含 candidates 数组`);
  }
  writeJson(path.join(analysisDir, 'analysis_context.json'), {
    schemaVersion: 1,
    runId: manifest.runId,
    variant,
    displayLabel: manifest.variants[variant].displayLabel,
    status: 'pending_semantic_analysis',
    generatedAt: new Date().toISOString(),
    requiredNextStep: '由同一位 Agent 使用 contract/ 中冻结的 SKILL 与规则，结合 analysis.txt 与 restart_candidates.json 回听、审阅后写 speech_errors.json；restart_candidates 只提供证据，确认成立才写入删除标。完成后运行 mark_model_ab_analysis_complete.js。',
    restartCandidates: {
      file: 'restart_candidates.json',
      count: restartCandidates.candidates.length,
      enforcement: 'semantic-review-only',
    },
    contract: manifest.contract,
  });
  console.log(`✅ ${variant} 已建立待办分析合同`);
}

function writeReviewMeta(abDirInput, variantInput) {
  const abDir = path.resolve(abDirInput);
  const variant = requireVariant(variantInput);
  const manifest = loadManifest(abDir);
  const reviewDir = path.join(abDir, variant, '3_审核');
  if (!fs.existsSync(reviewDir)) die(`${variant} 审核目录不存在：${reviewDir}`);
  // 审核页/日志只保留 A/B 标签，不携带 engine/resource，避免在人工审核时泄露模型身份。
  writeJson(path.join(reviewDir, 'ab_review_meta.json'), {
    schemaVersion: 1,
    runId: manifest.runId,
    variant,
    displayLabel: manifest.variants[variant].displayLabel,
    reviewMode: 'blind',
    generatedAt: new Date().toISOString(),
  });
  console.log(`✅ ${variant} 已写入盲审元数据`);
}

if (command === 'init' && (args.length === 4 || args.length === 5)) {
  init(...args);
} else if (command === 'freeze-contract' && (args.length === 2 || args.length === 3)) {
  freezeExistingContract(...args);
} else if (command === 'analysis-context' && args.length === 2) {
  writeAnalysisContext(...args);
} else if (command === 'review-meta' && args.length === 2) {
  writeReviewMeta(...args);
} else {
  die('用法：init <ab_dir> <video> <audio> <skill_dir> [rules_dir] | freeze-contract <ab_dir> <skill_dir> [rules_dir] | analysis-context <ab_dir> <A|B> | review-meta <ab_dir> <A|B>');
}
