#!/usr/bin/env node
/*
 * 应用已人工批准的事实纠错，生成新的字幕显示层文本。
 *
 * 用法:
 *   node apply_fact_corrections.js <4_字幕目录>
 *
 * 输入: corrected.txt + 事实核验/fact_check_candidates.json + approved_corrections.json
 * 输出: fact_checked.txt + 事实核验/fact_corrections_applied.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
  applyApprovedCorrections,
  ensureCaptionInput,
  readJson,
  writeJson,
} = require('./lib/fact_check_contract');
const { FACT_DIR_NAME } = require('./fact_check_subtitles');

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  if (argv.length !== 1 || argv[0].startsWith('-')) {
    fail('用法: node apply_fact_corrections.js <4_字幕目录>');
  }
  return { captionDir: argv[0] };
}

function applyFactCorrections(options) {
  const document = ensureCaptionInput(options.captionDir);
  const factDir = path.join(document.captionDir, FACT_DIR_NAME);
  const candidatesFile = path.join(factDir, 'fact_check_candidates.json');
  const approvalFile = path.join(factDir, 'approved_corrections.json');
  if (!fs.existsSync(candidatesFile)) fail(`找不到事实核验候选：${candidatesFile}`);
  if (!fs.existsSync(approvalFile)) fail(`找不到人工批准文件：${approvalFile}`);
  const candidatesArtifact = readJson(candidatesFile, 'fact_check_candidates.json');
  if (!Array.isArray(candidatesArtifact.candidates)) fail('fact_check_candidates.json 缺少 candidates 数组');
  const approval = readJson(approvalFile, 'approved_corrections.json');
  const applied = applyApprovedCorrections(document, candidatesArtifact.candidates, approval);
  const outputFile = path.join(document.captionDir, 'fact_checked.txt');
  const auditFile = path.join(factDir, 'fact_corrections_applied.json');
  fs.writeFileSync(outputFile, applied.outputText);
  writeJson(auditFile, {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    inputFile: document.correctedFile,
    inputSha256: document.documentSha256,
    outputFile,
    outputSha256: applied.outputSha256,
    appliedOperations: applied.operations,
  });
  return { outputFile, auditFile, applied };
}

function main() {
  try {
    const result = applyFactCorrections(parseArgs(process.argv.slice(2)));
    console.log(`✅ 已生成经人工批准的事实校对字幕：${result.outputFile}`);
    console.log(`   应用 ${result.applied.operations.length} 个指定出现位置；原 corrected.txt 未改动。`);
  } catch (error) {
    console.error(`❌ 应用事实纠错失败：${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  applyFactCorrections,
  parseArgs,
};
