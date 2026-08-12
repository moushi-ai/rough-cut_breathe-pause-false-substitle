/**
 * 切割算法单一来源（前后端共用）
 *
 * 输入「用户选中的删除段」，输出「实际保留片段 finalKeeps」。
 * 中间会做：合并相邻删除段 → 取反得保留段 → 边界向静音吸附 →
 * 保留段内部的长静音二次切割。这套逻辑过去内联在 review_server.js，
 * 现在抽出来让审核页前端也能实时预览到「真正会切到哪一帧」。
 *
 * 当调用方提供 spokenWords 时，静音段会先被裁成「字与字之间的空隙」，
 * 并且所有吸附/内部切割边界都会避开字的时间范围。这样 ASR 的边界误差
 * 只能让剪辑少切一点，不能把一个正在发音的字从中间切断。
 *
 * UMD：Node 用 require('./lib/compute_keeps')，浏览器用 <script> 后读 window.ComputeKeeps。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ComputeKeeps = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 默认阈值（与历史 review_server.js 行为完全一致）
  const DEFAULTS = {
    mergeGap: 0.15,          // 相邻删除段间距 < 此值则合并，吸收词级时间戳天然间隙
    minKeepDur: 0.1,         // 短于此的保留段无意义，丢弃
    lookBack: 0.6,           // 删除点前后多大窗口内寻找静音作为吸附切点
    padFrames: 2 / 30,       // 吸附后给说话者留的喘气余量（秒）
    edgeMargin: 0.05,        // 保留段边缘此范围内的静音不算「内部静音」
    minInternalSilence: 0.2, // 保留段内部 ≥ 此长度的静音会被二次切掉（换气/未识别停顿）
  };

  function normalizeSpokenWords(spokenWords) {
    return (Array.isArray(spokenWords) ? spokenWords : [])
      .filter(w => w && !w.isGap && Number.isFinite(Number(w.start)) && Number.isFinite(Number(w.end)) && Number(w.end) > Number(w.start))
      .map(w => ({ start: Number(w.start), end: Number(w.end) }))
      .sort((a, b) => a.start - b.start || a.end - b.end);
  }

  // ASR/能量回收的静音段有时会越过字的 start/end。只保留静音段与「字间空隙」
  // 的交集，避免后续的 pad 或内部静音切割把边界推进正在发音的字里。
  function clipPeriodsToWordGaps(periods, spokenWords) {
    if (!spokenWords.length) return periods;
    const clipped = [];
    for (const raw of periods) {
      if (!raw || !Number.isFinite(raw.start) || !Number.isFinite(raw.end) || raw.end <= raw.start) continue;
      let cursor = raw.start;
      for (const word of spokenWords) {
        if (word.end <= cursor) continue;
        if (word.start >= raw.end) break;
        if (word.start > cursor) {
          clipped.push({ start: cursor, end: Math.min(word.start, raw.end) });
        }
        cursor = Math.max(cursor, word.end);
        if (cursor >= raw.end) break;
      }
      if (cursor < raw.end) clipped.push({ start: cursor, end: raw.end });
    }
    return clipped
      .filter(p => p.end > p.start + 1e-6)
      .sort((a, b) => a.start - b.start || a.end - b.end);
  }

  // 若用户/旧版调用方传入的删除区间碰到了一个字，扩大到完整字，绝不保留
  // 「半个字」。审核页目前按 word.start/end 生成区间，这里是后端最后一道保险。
  function expandDeletesToWords(deleteList, spokenWords) {
    if (!spokenWords.length) return deleteList;
    return deleteList.map(seg => {
      let start = seg.start;
      let end = seg.end;
      for (const word of spokenWords) {
        if (word.end <= start) continue;
        if (word.start >= end) break;
        start = Math.min(start, word.start);
        end = Math.max(end, word.end);
      }
      return { start, end };
    });
  }

  function wordContaining(point, spokenWords) {
    for (const word of spokenWords) {
      if (point <= word.start) break;
      if (point < word.end) return word;
    }
    return null;
  }

  // keepStart/keepEnd 不能落在字中。对「删除边界附近」的吸附，保留字就整字
  // 保留；若字本身属于删除区间，则整字跳过。
  function clampKeepBoundary(point, side, spokenWords, mergedDeletes, keepEndLimit) {
    const word = wordContaining(point, spokenWords);
    if (!word) return point;
    const deleted = mergedDeletes.some(del => del.start < word.end && del.end > word.start);
    if (side === 'start') return deleted ? word.end : word.start;
    // 若吸附候选落在一个需要保留的字中，当前 keep 段本来就要一直保留到
    // 下一段删除边界；直接用该边界，避免「保留到这个字的字尾，却把后面
    // 紧接着的正常文本截掉」的断句问题。
    return deleted ? word.start : (keepEndLimit == null ? word.end : keepEndLimit);
  }

  // 保留段内部的切割同样不能穿过字。内部静音若因 pad 越过了字边界，
  // 将边界退回完整字的两端；最后的合并步骤会把这类「本应不切」的碎片合回去。
  function clampInternalBoundary(point, side, spokenWords) {
    const word = wordContaining(point, spokenWords);
    if (!word) return point;
    return side === 'start' ? word.start : word.end;
  }

  function mergeKeepSegments(segments, minKeepDur) {
    const sorted = segments
      .filter(seg => seg && seg.end > seg.start + minKeepDur)
      .sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = [];
    for (const seg of sorted) {
      const last = merged[merged.length - 1];
      if (last && seg.start <= last.end + 1e-6) {
        last.end = Math.max(last.end, seg.end);
      } else {
        merged.push({ start: seg.start, end: seg.end });
      }
    }
    return merged;
  }

  // 在 (rawStart, windowEnd] 内找最近的静音终点（最小 end），用于裁保留段开头
  function findNextSilenceEnd(periods, rawStart, windowEnd) {
    let best = null;
    for (const sp of periods) {
      if (sp.end > rawStart && sp.end <= windowEnd) {
        if (best === null || sp.end < best) best = sp.end;
      }
    }
    return best;
  }

  // 在 [windowStart, rawEnd) 内找最后一个静音起点，用于裁保留段末尾
  function findLastSilenceStart(periods, rawEnd, windowStart) {
    let best = null;
    for (const sp of periods) {
      if (sp.start >= windowStart && sp.start < rawEnd) best = sp.start;
    }
    return best;
  }

  /**
   * @param {{start:number,end:number}[]} deleteList 用户选中的删除段（无需排序）
   * @param {{start:number,end:number}[]} silencePeriods ffmpeg 检测的静音段
   * @param {number} duration 媒体总时长（秒）
   * @param {object} [opts] 覆盖默认阈值
   * @param {{start:number,end:number,isGap?:boolean}[]} [spokenWords] 逐字时间轴；
   *   提供后启用「不切字」保护
   * @returns {{start:number,end:number}[]} 实际保留片段（已吸附 + 内部二次切）
   */
  function computeFinalKeeps(deleteList, silencePeriods, duration, opts, spokenWords) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    // 非对称喘气余量：起始(lead-in)与结尾(trail)可分别设置。
    // 未显式给 padStart/padEnd 时退回对称 padFrames，保持旧行为。
    const padStart = (opts && opts.padStart != null) ? opts.padStart : o.padFrames;
    const padEnd = (opts && opts.padEnd != null) ? opts.padEnd : o.padFrames;
    const words = normalizeSpokenWords(spokenWords);
    const rawPeriods = (silencePeriods || []).slice().sort((a, b) => a.start - b.start);
    const periods = clipPeriodsToWordGaps(rawPeriods, words);

    // 1) 合并删除段
    const rawDeletes = (deleteList || [])
      .filter(seg => seg && Number.isFinite(Number(seg.start)) && Number.isFinite(Number(seg.end)) && Number(seg.end) > Number(seg.start))
      .map(seg => ({ start: Number(seg.start), end: Number(seg.end) }));
    const sorted = expandDeletesToWords(rawDeletes, words).sort((a, b) => a.start - b.start);
    const merged = [];
    for (const seg of sorted) {
      const last = merged[merged.length - 1];
      if (!last || seg.start > last.end + o.mergeGap) merged.push({ start: seg.start, end: seg.end });
      else last.end = Math.max(last.end, seg.end);
    }

    // 2) 取反得保留段，并把边界吸附到最近静音
    const keepSegments = [];
    let cursor = 0;
    for (const del of merged) {
      if (del.start > cursor + o.minKeepDur) {
        const silEnd = findNextSilenceEnd(periods, cursor, cursor + o.lookBack);
        const rawStart = silEnd !== null ? silEnd - padStart : cursor;
        const trimmedStart = words.length
          ? Math.max(cursor, Math.min(del.start, clampKeepBoundary(rawStart, 'start', words, merged)))
          : rawStart;

        const silStart = findLastSilenceStart(periods, del.start, del.start - o.lookBack);
        const rawEnd = silStart !== null ? silStart + padEnd : del.start;
        const trimmedEnd = words.length
          ? Math.max(cursor, Math.min(del.start, clampKeepBoundary(rawEnd, 'end', words, merged, del.start)))
          : rawEnd;

        if (trimmedEnd > trimmedStart + o.minKeepDur) {
          keepSegments.push({ start: trimmedStart, end: trimmedEnd });
        }
      }
      cursor = del.end;
    }
    if (cursor < duration - o.minKeepDur) {
      const silEnd = findNextSilenceEnd(periods, cursor, cursor + o.lookBack);
      const rawStart = silEnd !== null ? silEnd - padStart : cursor;
      const trimmedStart = words.length
        ? Math.max(cursor, Math.min(duration, clampKeepBoundary(rawStart, 'start', words, merged)))
        : rawStart;
      keepSegments.push({ start: trimmedStart, end: duration });
    }

    // 3) 保留段内部长静音二次切割
    const finalKeeps = [];
    for (const keep of keepSegments) {
      const internal = periods.filter(sp =>
        sp.start > keep.start + o.edgeMargin &&
        sp.end < keep.end - o.edgeMargin &&
        (sp.end - sp.start) >= o.minInternalSilence
      );
      let cur = keep.start;
      for (const sp of internal) {
        const rawEnd = sp.start + padEnd;
        const safeEnd = words.length ? clampInternalBoundary(rawEnd, 'end', words) : rawEnd;
        const cutEnd = Math.min(keep.end, safeEnd);
        if (cutEnd > cur + o.minKeepDur) finalKeeps.push({ start: cur, end: cutEnd });
        const rawStart = sp.end;
        const safeStart = words.length ? clampInternalBoundary(rawStart, 'start', words) : rawStart;
        cur = Math.max(cur, Math.min(keep.end, safeStart));
      }
      if (keep.end > cur + o.minKeepDur) finalKeeps.push({ start: cur, end: keep.end });
    }

    return mergeKeepSegments(finalKeeps, o.minKeepDur);
  }

  // 区间相减：a 减去 b（两侧都已按 start 升序、内部不重叠），丢弃短于 minDur 的碎片。
  // 审核页用它算「算法切了、但用户没选」的误伤段（cuts − deleteSegs）。
  function intervalSubtract(a, b, minDur) {
    const min = minDur == null ? 0.02 : minDur;
    const out = [];
    for (const c of a) {
      let segs = [{ start: c.start, end: c.end }];
      for (const d of b) {
        const next = [];
        for (const s of segs) {
          if (d.end <= s.start || d.start >= s.end) { next.push(s); continue; }
          if (d.start > s.start) next.push({ start: s.start, end: d.start });
          if (d.end < s.end) next.push({ start: d.end, end: s.end });
        }
        segs = next;
      }
      for (const s of segs) if (s.end - s.start > min) out.push(s);
    }
    return out;
  }

  // 保留段取反 → 实际被切掉的区间（含吸附/二次切的「误伤」）
  function keepsToCuts(finalKeeps, duration) {
    const cuts = [];
    let cursor = 0;
    for (const k of finalKeeps) {
      if (k.start > cursor + 1e-6) cuts.push({ start: cursor, end: k.start });
      cursor = Math.max(cursor, k.end);
    }
    if (cursor < duration - 1e-6) cuts.push({ start: cursor, end: duration });
    return cuts;
  }

  return { computeFinalKeeps, keepsToCuts, intervalSubtract, DEFAULTS };
});
