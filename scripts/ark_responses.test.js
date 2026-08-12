'use strict';

const assert = require('assert');
const {
  collectEvidence,
  collectWebSearchToolTrace,
  extractOutputText,
  resolveModelId,
  tryParseJson,
} = require('./lib/ark_responses');

const response = {
  output: [{
    type: 'message',
    content: [{ type: 'output_text', text: '```json\n{"status":"proposed"}\n```' }],
  }, {
    type: 'web_search_call',
    name: 'web_search',
    results: [{ url: 'https://example.com/source', title: '来源', snippet: '证据摘要' }],
  }],
};

assert.deepStrictEqual(tryParseJson(extractOutputText(response)), { status: 'proposed' });
assert.strictEqual(collectWebSearchToolTrace(response).length, 1, '必须识别 Web Search 调用痕迹');
assert.deepStrictEqual(collectEvidence(response), [{
  url: 'https://example.com/source', title: '来源', snippet: '证据摘要',
}]);
assert.strictEqual(resolveModelId('doubao-seed-2.0-lite'), 'doubao-seed-2-0-lite-260215', '产品名应解析到当前 Responses API 端点');
console.log('ark responses parsing test passed');
