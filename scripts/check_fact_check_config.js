#!/usr/bin/env node
/*
 * 校验字幕事实核验所需的方舟模型与 Web Search 权限。
 *
 * 用法:
 *   node check_fact_check_config.js [--model 模型名] [--web-search]
 *
 * --web-search 会发起一条极小的公开事实检索，仅用于确认内置工具已开通。
 */

'use strict';

const {
  callResponses,
  collectEvidence,
  collectWebSearchToolTrace,
  loadArkConfig,
} = require('./lib/ark_responses');

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const result = { model: '', webSearch: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--model') result.model = argv[++index] || '';
    else if (arg === '--web-search') result.webSearch = true;
    else fail(`未知参数：${arg}`);
  }
  return result;
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const config = loadArkConfig({ model: args.model });
    if (config.state !== 'ok') {
      fail(`未找到 ARK_API_KEY。请写入未提交的 ${config.recommendedEnvFile}，或设置环境变量 ARK_API_KEY。`);
    }
    const response = await callResponses({
      apiKey: config.apiKey,
      endpoint: config.endpoint,
      model: config.model,
      prompt: args.webSearch
        ? '必须使用联网搜索 Web Search 查询“菲尔兹奖”，随后仅回复 READY。'
        : '仅回复 READY。',
      tools: args.webSearch ? [{ type: 'web_search' }] : [],
      thinking: { type: 'disabled' },
      maxOutputTokens: 128,
    });
    if (args.webSearch) {
      const trace = collectWebSearchToolTrace(response);
      const evidence = collectEvidence(response);
      if (trace.length === 0 && evidence.length === 0) {
        fail('模型调用成功，但响应中没有 Web Search 调用痕迹或来源链接；请确认方舟联网搜索资源已开通');
      }
    }
    console.log(`✅ 方舟事实核验配置可用：${config.model}`);
    console.log(`   Key 来源：${config.source}（为安全起见不显示任何 Key 字符）`);
    console.log(`   Web Search：${args.webSearch ? '已验证' : '未测试（加 --web-search 测试）'}`);
  } catch (error) {
    console.error(`❌ 方舟事实核验配置不可用：${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { parseArgs };
