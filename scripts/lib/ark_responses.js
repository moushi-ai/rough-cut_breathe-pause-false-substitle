#!/usr/bin/env node
/*
 * 火山方舟 Responses API 的最小安全适配层。
 *
 * - 只从环境变量或未提交的 .env 读取 ARK_API_KEY；绝不打印 Key。
 * - 为字幕事实核验提供文本输出、JSON 输出与联网搜索证据的通用解析。
 */

'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');

const DEFAULT_ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/responses';
// “doubao-seed-2.0-lite” 是产品名；Responses API 需要当前公开的实际端点 ID。
const DEFAULT_MODEL = 'doubao-seed-2-0-lite-260215';
const MODEL_ALIASES = new Map([
  ['doubao-seed-2.0-lite', DEFAULT_MODEL],
]);
const PLACEHOLDERS = new Set(['', 'your_api_key_here', 'your-api-key', 'xxx', '<your_api_key>']);

function fail(message) {
  throw new Error(message);
}

function unquote(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '');
}

function readEnvFile(file) {
  const values = {};
  if (!file || !fs.existsSync(file)) return values;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match) values[match[1]] = unquote(match[2]);
  }
  return values;
}

function resolveModelId(value) {
  const requested = unquote(value);
  return MODEL_ALIASES.get(requested.toLowerCase()) || requested;
}

function loadArkConfig(options = {}) {
  const skillDir = options.skillDir || path.resolve(__dirname, '..', '..');
  const explicitEnvFile = options.envFile || process.env.ARK_ENV_FILE;
  const candidates = [
    explicitEnvFile,
    path.join(skillDir, '.env'),
    path.join(path.dirname(skillDir), '.env'),
  ].filter(Boolean);

  let fileValues = {};
  let source = null;
  for (const file of candidates) {
    const values = readEnvFile(file);
    if (Object.keys(values).length === 0) continue;
    if (!source && values.ARK_API_KEY) source = file;
    fileValues = { ...values, ...fileValues };
  }

  const apiKey = unquote(options.apiKey || process.env.ARK_API_KEY || fileValues.ARK_API_KEY);
  const requestedModel = unquote(options.model || process.env.FACT_CHECK_MODEL || fileValues.FACT_CHECK_MODEL || DEFAULT_MODEL);
  const model = resolveModelId(requestedModel || DEFAULT_MODEL);
  const endpoint = unquote(options.endpoint || process.env.ARK_RESPONSES_ENDPOINT || fileValues.ARK_RESPONSES_ENDPOINT || DEFAULT_ENDPOINT);
  if (!apiKey || PLACEHOLDERS.has(apiKey.toLowerCase())) {
    return {
      state: 'missing_key',
      model,
      requestedModel,
      endpoint,
      source,
      recommendedEnvFile: path.join(skillDir, '.env'),
    };
  }
  return {
    state: 'ok',
    apiKey,
    model,
    requestedModel,
    endpoint,
    source: process.env.ARK_API_KEY ? '环境变量' : (source || '显式参数'),
  };
}

function safeRemoteError(status, body) {
  let description = '';
  try {
    const parsed = JSON.parse(body);
    description = parsed && (parsed.message || (parsed.error && parsed.error.message) || parsed.error);
  } catch (_) {
    description = body;
  }
  description = String(description || '').replace(/\s+/g, ' ').slice(0, 500);
  return `方舟 Responses API 返回 HTTP ${status}${description ? `：${description}` : ''}`;
}

function postJson(endpoint, apiKey, payload, options = {}) {
  const url = new URL(endpoint);
  const body = JSON.stringify(payload);
  const timeoutMs = options.timeoutMs || 90000;
  return new Promise((resolve, reject) => {
    const request = https.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, response => {
      let chunks = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { chunks += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(safeRemoteError(response.statusCode, chunks)));
          return;
        }
        try {
          resolve(JSON.parse(chunks));
        } catch (error) {
          reject(new Error(`方舟 Responses API 返回了无法解析的 JSON：${error.message}`));
        }
      });
    });
    request.on('error', error => reject(new Error(`无法连接方舟 Responses API：${error.message}`)));
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      reject(new Error(`方舟 Responses API 超时（${Math.round(timeoutMs / 1000)} 秒）`));
    });
    request.write(body);
    request.end();
  });
}

async function callResponses(options) {
  if (!options || !options.apiKey) fail('调用方舟前必须提供 ARK_API_KEY');
  if (!options.model) fail('调用方舟前必须提供模型名');
  const payload = {
    model: options.model,
    input: [{ type: 'message', role: 'user', content: options.prompt }],
    // 字幕文本可能包含创作内容；默认不要求服务端保存本次 Responses 会话。
    store: false,
  };
  if (Array.isArray(options.tools) && options.tools.length > 0) payload.tools = options.tools;
  if (options.thinking && typeof options.thinking === 'object') payload.thinking = options.thinking;
  if (Number.isInteger(options.maxOutputTokens) && options.maxOutputTokens > 0) {
    payload.max_output_tokens = options.maxOutputTokens;
  }
  return postJson(options.endpoint || DEFAULT_ENDPOINT, options.apiKey, payload, options);
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(contentText).filter(Boolean).join('\n');
  if (!content || typeof content !== 'object') return '';
  if (typeof content.text === 'string') return content.text;
  if (typeof content.output_text === 'string') return content.output_text;
  if (typeof content.content === 'string' || Array.isArray(content.content)) return contentText(content.content);
  return '';
}

function extractOutputText(response) {
  const output = Array.isArray(response && response.output) ? response.output : [];
  const messages = output
    .filter(item => item && (item.type === 'message' || item.role === 'assistant' || item.content))
    .map(item => contentText(item.content || item))
    .filter(Boolean);
  if (messages.length > 0) return messages.join('\n').trim();
  return contentText(response && (response.output_text || response.content)).trim();
}

function tryParseJson(text) {
  const trimmed = String(text || '').trim();
  const candidates = [trimmed];
  for (const block of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(block[1].trim());
  const firstObject = trimmed.indexOf('{');
  const lastObject = trimmed.lastIndexOf('}');
  if (firstObject !== -1 && lastObject > firstObject) candidates.push(trimmed.slice(firstObject, lastObject + 1));
  const firstArray = trimmed.indexOf('[');
  const lastArray = trimmed.lastIndexOf(']');
  if (firstArray !== -1 && lastArray > firstArray) candidates.push(trimmed.slice(firstArray, lastArray + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (_) {
      // Continue with the next plausible JSON slice.
    }
  }
  fail('模型输出不是可解析的 JSON；请重试，不会据此改动字幕');
}

function collectEvidence(response) {
  const sources = [];
  const seen = new Set();
  function visit(value) {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== 'object') return;
    const url = typeof value.url === 'string' ? value.url : (typeof value.source_url === 'string' ? value.source_url : '');
    if (url && /^https?:\/\//i.test(url) && !seen.has(url)) {
      seen.add(url);
      sources.push({
        url,
        title: typeof value.title === 'string' ? value.title : (typeof value.source_title === 'string' ? value.source_title : ''),
        snippet: typeof value.text === 'string' ? value.text.slice(0, 800) : (typeof value.snippet === 'string' ? value.snippet.slice(0, 800) : ''),
      });
    }
    for (const child of Object.values(value)) visit(child);
  }
  visit(response && response.output);
  return sources;
}

function collectWebSearchToolTrace(response) {
  const trace = [];
  function visit(value) {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== 'object') return;
    const type = String(value.type || value.name || value.tool_type || '').toLowerCase();
    if (type.includes('web_search') || type.includes('websearch')) {
      trace.push({ type: value.type || value.name || value.tool_type || 'web_search' });
    }
    for (const child of Object.values(value)) visit(child);
  }
  visit(response && response.output);
  return trace;
}

module.exports = {
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  callResponses,
  collectEvidence,
  collectWebSearchToolTrace,
  extractOutputText,
  loadArkConfig,
  postJson,
  resolveModelId,
  tryParseJson,
};
