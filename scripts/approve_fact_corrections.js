#!/usr/bin/env node
/*
 * 把人工决定写入批准清单。这个命令本身不改字幕。
 *
 * 用法:
 *   node approve_fact_corrections.js <4_字幕目录> --approve FC-001,FC-002 [--reject FC-003] [--by 姓名] [--note 备注]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { applyDecisions, readJson, writeJson } = require('./lib/fact_check_contract');
const { FACT_DIR_NAME } = require('./fact_check_subtitles');

function fail(message) {
  throw new Error(message);
}

function parseIds(value) {
  return [...new Set(String(value || '').split(',').map(item => item.trim()).filter(Boolean))];
}

function parseArgs(argv) {
  const result = { captionDir: '', approve: [], reject: [], by: 'manual', note: '' };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--approve') {
      result.approve.push(...parseIds(argv[++index]));
    } else if (arg === '--reject') {
      result.reject.push(...parseIds(argv[++index]));
    } else if (arg === '--by') {
      result.by = argv[++index] || 'manual';
    } else if (arg === '--note') {
      result.note = argv[++index] || '';
    } else if (!arg.startsWith('-') && !result.captionDir) {
      result.captionDir = arg;
    } else {
      fail(`未知或重复参数：${arg}`);
    }
  }
  if (!result.captionDir) fail('用法: node approve_fact_corrections.js <4_字幕目录> --approve FC-001,FC-002 [--reject FC-003]');
  if (result.approve.length === 0 && result.reject.length === 0) fail('至少提供一个 --approve 或 --reject 候选 ID');
  const conflict = result.approve.find(id => result.reject.includes(id));
  if (conflict) fail(`同一候选不能同时批准和拒绝：${conflict}`);
  return result;
}

function approveFactCorrections(options) {
  const captionDir = path.resolve(options.captionDir);
  const factDir = path.join(captionDir, FACT_DIR_NAME);
  const candidatesFile = path.join(factDir, 'fact_check_candidates.json');
  const templateFile = path.join(factDir, 'approval_template.json');
  if (!fs.existsSync(candidatesFile)) fail(`找不到事实核验候选：${candidatesFile}`);
  if (!fs.existsSync(templateFile)) fail(`找不到批准模板：${templateFile}`);
  const candidatesArtifact = readJson(candidatesFile, 'fact_check_candidates.json');
  if (!Array.isArray(candidatesArtifact.candidates)) fail('fact_check_candidates.json 缺少 candidates 数组');
  const template = readJson(templateFile, 'approval_template.json');
  const approval = applyDecisions(template, candidatesArtifact.candidates, options);
  const output = path.join(factDir, 'approved_corrections.json');
  writeJson(output, approval);
  return { output, approval };
}

function main() {
  try {
    const result = approveFactCorrections(parseArgs(process.argv.slice(2)));
    const approved = result.approval.decisions.filter(item => item.decision === 'approved').length;
    const rejected = result.approval.decisions.filter(item => item.decision === 'rejected').length;
    console.log(`✅ 已记录人工事实核验决定：${result.output}`);
    console.log(`   已批准 ${approved} 条，已拒绝 ${rejected} 条；字幕尚未改动。`);
  } catch (error) {
    console.error(`❌ 记录事实核验决定失败：${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  approveFactCorrections,
  parseArgs,
};
