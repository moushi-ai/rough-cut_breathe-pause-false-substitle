/*
 * 数字事实的声学复核。
 *
 * 原则：首次完整 ASR 适合生成整片逐词时间轴；当裸数字可能漏掉单位时，必须
 * 回到原始音频，以候选前后各约 2 秒的连续窗口做第二遍、关闭 ITN 的原样复听。
 * 该模块只生成证据，不决定字幕文本，更不会直接写字幕。
 */

'use strict';

const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_PREROLL_SECONDS = 2;
const DEFAULT_POSTROLL_SECONDS = 2;
const VERBATIM_ENGINE = 'volc.bigasr.auc_turbo';

function fail(message) {
  throw new Error(message);
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundSeconds(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function isBareArabicNumber(value) {
  return /^\d+(?:\.\d+)?$/.test(String(value || '').trim());
}

function needsAudioRecheck(candidate) {
  return Boolean(candidate
    && candidate.type === 'NUMBER'
    && Array.isArray(candidate.variants)
    && candidate.variants.length === 1
    && isBareArabicNumber(candidate.variants[0]));
}

function buildClipWindow(occurrence, duration, options = {}) {
  const candidateStart = finiteNumber(occurrence && occurrence.sourceStart);
  const candidateEnd = finiteNumber(occurrence && occurrence.sourceEnd);
  const audioDuration = finiteNumber(duration);
  const preRollSeconds = finiteNumber(options.preRollSeconds) ?? DEFAULT_PREROLL_SECONDS;
  const postRollSeconds = finiteNumber(options.postRollSeconds) ?? DEFAULT_POSTROLL_SECONDS;
  if (candidateStart === null || candidateEnd === null || candidateEnd <= candidateStart) {
    fail('候选缺少有效的原始词级时间范围，不能做声学复核');
  }
  if (audioDuration === null || audioDuration <= 0) {
    fail('原始音频时长不可用，不能计算声学复核切片');
  }
  if (preRollSeconds < 0 || postRollSeconds < 0) {
    fail('声学复核的前后留白不能为负数');
  }
  const clipStart = Math.max(0, candidateStart - preRollSeconds);
  const clipEnd = Math.min(audioDuration, candidateEnd + postRollSeconds);
  if (clipEnd <= clipStart) fail('声学复核切片范围为空');
  return {
    candidateStart: roundSeconds(candidateStart),
    candidateEnd: roundSeconds(candidateEnd),
    clipStart: roundSeconds(clipStart),
    clipEnd: roundSeconds(clipEnd),
    durationSeconds: roundSeconds(clipEnd - clipStart),
    beforeSeconds: roundSeconds(candidateStart - clipStart),
    afterSeconds: roundSeconds(clipEnd - candidateEnd),
    policy: `连续原始音频窗口；候选前 ${preRollSeconds.toFixed(2)} 秒、候选后 ${postRollSeconds.toFixed(2)} 秒；不删静音、不拼接、不改速`,
  };
}

function readAudioDuration(audioFile) {
  const stdout = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', audioFile,
  ], { encoding: 'utf8' });
  const duration = finiteNumber(stdout.trim());
  if (duration === null || duration <= 0) fail('ffprobe 未返回有效音频时长');
  return duration;
}

function wordTimestampInSeconds(item, startOrEnd) {
  const rawMilliseconds = item && item[`${startOrEnd}_time`];
  if (rawMilliseconds !== undefined && rawMilliseconds !== null) {
    const timestamp = finiteNumber(rawMilliseconds);
    return timestamp === null ? null : timestamp / 1000;
  }
  return finiteNumber(item && item[startOrEnd]);
}

function extractAsrTexts(result, window = null) {
  const payload = result && result.result ? result.result : (result || {});
  const utterances = Array.isArray(payload.utterances) ? payload.utterances : [];
  const allWords = utterances.flatMap(item => Array.isArray(item && item.words) ? item.words : []);
  const selectedWords = window
    ? allWords.filter(word => {
        const start = wordTimestampInSeconds(word, 'start');
        const end = wordTimestampInSeconds(word, 'end');
      return start !== null && end !== null && end > window.clipStart && start < window.clipEnd;
    })
    : allWords;
  return {
    resultText: String(payload.text || ''),
    wordText: selectedWords.map(word => String(word && word.text || '')).join(''),
    utteranceText: utterances
      .filter(utterance => {
        if (!window) return true;
        const start = wordTimestampInSeconds(utterance, 'start');
        const end = wordTimestampInSeconds(utterance, 'end');
        return start !== null && end !== null && end > window.clipStart && start < window.clipEnd;
      })
      .map(utterance => String(utterance && utterance.text || ''))
      .join(''),
  };
}

function transcriptWordText(document, window) {
  const retainedWords = Array.isArray(document && document.transcript && document.transcript.retainedWords)
    ? document.transcript.retainedWords : [];
  return retainedWords
    .filter(word => {
      const start = finiteNumber(word && word.start);
      const end = finiteNumber(word && word.end);
      return start !== null && end !== null && end > window.clipStart && start < window.clipEnd;
    })
    .map(word => String(word.text || ''))
    .join('');
}

function resolveProjectFile(document, relativePath) {
  return path.resolve(document.captionDir, '..', relativePath);
}

function firstPassEvidence(document, window, options = {}) {
  const originalResultFile = options.originalResultFile || resolveProjectFile(document, path.join('1_转录', 'volcengine_v3_result.json'));
  const fallback = transcriptWordText(document, window);
  if (!fs.existsSync(originalResultFile)) {
    return {
      source: 'retained_transcript.json（原始 ASR 结果文件缺失，使用保留逐词时间轴回退）',
      resultText: '',
      utteranceText: '',
      wordText: fallback,
    };
  }
  try {
    const result = JSON.parse(fs.readFileSync(originalResultFile, 'utf8'));
    const texts = extractAsrTexts(result, window);
    return {
      source: path.basename(originalResultFile),
      resultText: texts.resultText,
      utteranceText: texts.utteranceText,
      wordText: texts.wordText || fallback,
    };
  } catch (error) {
    return {
      source: 'retained_transcript.json（原始 ASR 结果无法读取，使用保留逐词时间轴回退）',
      resultText: '',
      utteranceText: '',
      wordText: fallback,
      readWarning: error.message,
    };
  }
}

function resolveAudioFile(document, options = {}) {
  const audioFile = options.audioFile || resolveProjectFile(document, path.join('1_转录', 'audio.mp3'));
  if (!fs.existsSync(audioFile)) fail(`找不到原始音频，无法做声学复核：${audioFile}`);
  return path.resolve(audioFile);
}

function sliceAudio(audioFile, window, tempDir) {
  const clipFile = path.join(tempDir, 'audio_recheck.wav');
  const result = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(window.clipStart),
    '-t', String(window.durationSeconds),
    '-i', audioFile,
    '-ac', '1', '-ar', '16000', '-y', clipFile,
  ], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0 || !fs.existsSync(clipFile)) {
    const reason = String(result.error && result.error.message || result.stderr || result.stdout || 'ffmpeg 切片失败').trim();
    fail(`声学复核音频切片失败：${reason.slice(-800)}`);
  }
  return clipFile;
}

function transcribeVerbatim(clipFile, options = {}) {
  const skillDir = path.resolve(options.skillDir || path.join(__dirname, '..', '..'));
  const script = path.join(skillDir, 'scripts', 'volcengine_flash_transcribe.sh');
  if (!fs.existsSync(script)) fail(`找不到极速版 ASR 脚本：${script}`);
  const outputDir = path.join(path.dirname(clipFile), 'asr');
  const env = { ...process.env };
  if (options.envFile) env.VOLCENGINE_ENV_FILE = options.envFile;
  const result = spawnSync('bash', [script, clipFile, outputDir, '--verbatim'], {
    cwd: skillDir,
    encoding: 'utf8',
    env,
    timeout: options.timeoutMs || 150000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const resultFile = path.join(outputDir, 'volcengine_v3_result.json');
  if (result.error || result.status !== 0 || !fs.existsSync(resultFile)) {
    const reason = String(result.error && result.error.message || result.stderr || result.stdout || '二遍 ASR 未生成结果').trim();
    fail(`二遍原样 ASR 失败：${reason.slice(-1000)}`);
  }
  const parsed = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  const texts = extractAsrTexts(parsed);
  if (!texts.wordText) fail('二遍原样 ASR 返回了空文本');
  return {
    engine: VERBATIM_ENGINE,
    request: {
      enableItn: false,
      enablePunc: false,
      showUtterances: true,
      mode: 'verbatim_audio_recheck',
    },
    resultText: texts.resultText,
    utteranceText: texts.utteranceText,
    wordText: texts.wordText,
    resultSha256: sha256File(resultFile),
  };
}

function normalizeMockRecheck(mock, document, candidate, occurrence) {
  if (!mock || typeof mock !== 'object') return null;
  const window = mock.window || buildClipWindow(occurrence, Number(mock.audioDuration || 120));
  return {
    status: mock.status || 'verified',
    candidateId: candidate.id,
    occurrence: { line: occurrence.line, mention: occurrence.mention },
    window,
    sourceAudio: mock.sourceAudio || 'audio.mp3',
    firstPass: mock.firstPass || firstPassEvidence(document, window),
    secondPass: mock.secondPass || {
      engine: VERBATIM_ENGINE,
      request: { enableItn: false, enablePunc: false, showUtterances: true, mode: 'verbatim_audio_recheck' },
      resultText: '', utteranceText: '', wordText: '', resultSha256: '',
    },
    reason: String(mock.reason || ''),
  };
}

function recheckCandidateAudio(document, candidate, options = {}) {
  if (!needsAudioRecheck(candidate)) {
    return { status: 'not_applicable', candidateId: candidate && candidate.id || '', reason: '仅对裸阿拉伯数字候选做声学复核' };
  }
  if (!Array.isArray(candidate.occurrences) || candidate.occurrences.length !== 1) {
    return { status: 'unavailable', candidateId: candidate.id, reason: '裸数字候选必须只有一个精确出现位置；拒绝把多个语义位置合并后复核' };
  }
  const occurrence = candidate.occurrences[0];
  if (options.mockRecheck) return normalizeMockRecheck(options.mockRecheck, document, candidate, occurrence);

  let tempDir = null;
  try {
    const audioFile = resolveAudioFile(document, options);
    const duration = readAudioDuration(audioFile);
    const window = buildClipWindow(occurrence, duration, options);
    const firstPass = firstPassEvidence(document, window, options);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-jian-koubo-audio-recheck-'));
    const clipFile = sliceAudio(audioFile, window, tempDir);
    const secondPass = transcribeVerbatim(clipFile, options);
    return {
      status: 'verified',
      candidateId: candidate.id,
      occurrence: { line: occurrence.line, mention: occurrence.mention },
      sourceAudio: path.basename(audioFile),
      window,
      firstPass,
      secondPass,
      reason: '',
    };
  } catch (error) {
    return {
      status: 'unavailable',
      candidateId: candidate.id,
      reason: error.message,
    };
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

module.exports = {
  DEFAULT_POSTROLL_SECONDS,
  DEFAULT_PREROLL_SECONDS,
  VERBATIM_ENGINE,
  buildClipWindow,
  extractAsrTexts,
  firstPassEvidence,
  isBareArabicNumber,
  needsAudioRecheck,
  recheckCandidateAudio,
};
