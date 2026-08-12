#!/usr/bin/env node
/*
 * 校验可共享的团队经验规则，阻止未确认的规则或凭证进入 Git。
 *
 * 用法:
 *   node validate_experience_rules.js [经验规则.md] [--require-confirmed] [--json]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let requireConfirmed = false;
let outputJson = false;
let rulesFile = path.resolve(__dirname, '..', '用户习惯', '经验规则.md');

for (const arg of args) {
  if (arg === '--require-confirmed') {
    requireConfirmed = true;
  } else if (arg === '--json') {
    outputJson = true;
  } else if (!arg.startsWith('-')) {
    rulesFile = path.resolve(arg);
  } else {
    console.error(`❌ 未知参数: ${arg}`);
    process.exit(1);
  }
}

function fail(message) {
  console.error(`❌ 经验规则校验失败: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(rulesFile)) fail(`文件不存在: ${rulesFile}`);
const content = fs.readFileSync(rulesFile, 'utf8');
if (!content.trim()) fail('文件为空');
if (!content.startsWith('# 经验规则')) fail('文件必须以“# 经验规则”标题开始');

// 经验规则属于共享文本，提交前作保守的凭证扫描。命中时由人工处理，绝不自动清洗。
const secretMarkers = [
  /VOLCENGINE_API_KEY\s*=/i,
  /(?:api[_ -]?key|secret|token|password)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{16,}/i,
  /AK[A-Za-z0-9]{16,}/,
];
if (secretMarkers.some(pattern => pattern.test(content))) {
  fail('检测到疑似凭证；请移除后再提交');
}

const placeholder = '_（暂无。第一次跑学习后，确认的规则会写在这里。）_';
const confirmedTags = [...content.matchAll(/（学于\s+.+?\s+\d{4}-\d{2}-\d{2}；已确认）/g)];
if (requireConfirmed && confirmedTags.length === 0) {
  fail('没有带“（学于 <视频> YYYY-MM-DD；已确认）”标签的可共享规则');
}
if (confirmedTags.length > 0 && content.includes(placeholder)) {
  fail('已有确认规则时不得保留空白占位符');
}

// 规则正文以三级标题为一个可独立维护、提交和回滚的单元。这样“有一条已确认
// 规则 + 又悄悄加一条未确认规则”也会被拦住，而不只是检查文件里是否出现过一次标签。
const rulesBodyMarker = '## 规则正文';
const rulesBodyIndex = content.indexOf(rulesBodyMarker);
if (requireConfirmed && rulesBodyIndex !== -1) {
  const rulesBody = content.slice(rulesBodyIndex + rulesBodyMarker.length);
  const sections = rulesBody
    .split(/^###\s+/m)
    .slice(1)
    .map(section => section.trim())
    .filter(Boolean);

  if (sections.length === 0) {
    fail('规则正文中没有可确认的三级规则条目');
  }
  for (const section of sections) {
    if (!/（学于\s+.+?\s+\d{4}-\d{2}-\d{2}；已确认）/.test(section)) {
      const title = section.split('\n', 1)[0];
      fail(`规则条目“${title}”缺少已确认出处标签`);
    }
  }
}

const result = {
  valid: true,
  rulesFile,
  confirmedRules: confirmedTags.length,
};
if (outputJson) {
  console.log(JSON.stringify(result));
} else {
  console.log(`✅ 经验规则校验通过：已确认规则 ${confirmedTags.length} 条`);
}
