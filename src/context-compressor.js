'use strict';

/**
 * context-compressor.js —— 上下文与日志智能压缩模块
 * 灵感来自 Headroom、RTK（Rust Token Killer）和 LLMLingua 的算法。
 */

/**
 * 1. RTK (Rust Token Killer / Terminal Output Compressor)
 * 压缩冗长的终端输出（bash、git diff、npm、pytest、linters）。
 */
function compressTerminalOutput(text) {
  if (typeof text !== 'string' || text.length < 500) return text;

  // A) Git Diff 压缩：保留文件结构与改动行，剔除未改动的噪声
  if (text.includes('diff --git') || text.includes('--- a/') || text.includes('+++ b/')) {
    const lines = text.split('\n');
    const kept = [];
    let diffContextCount = 0;

    for (const line of lines) {
      if (
        line.startsWith('diff --git') ||
        line.startsWith('--- ') ||
        line.startsWith('+++ ') ||
        line.startsWith('@@') ||
        line.startsWith('+') ||
        line.startsWith('-')
      ) {
        kept.push(line);
        diffContextCount = 0;
      } else if (diffContextCount < 2) {
        kept.push(line);
        diffContextCount += 1;
      } else if (diffContextCount === 2) {
        kept.push('  ... [unchanged lines omitted]');
        diffContextCount += 1;
      }
    }
    const compressed = kept.join('\n');
    if (compressed.length < text.length) return compressed;
  }

  // B) 构建 / npm / pip / pytest 日志压缩：保留开头说明与末尾错误
  if (text.includes('npm ERR!') || text.includes('FAIL') || text.includes('Traceback (most recent call last)')) {
    const lines = text.split('\n');
    if (lines.length > 50) {
      const head = lines.slice(0, 15);
      const tail = lines.slice(-25);
      return [...head, `\n... [${lines.length - 40} lines of intermediate build/test log omitted] ...\n`, ...tail].join('\n');
    }
  }

  // C) 通用工具输出超过 3000 字符时，紧凑地截掉中间部分
  if (text.length > 4000) {
    const head = text.slice(0, 1500);
    const tail = text.slice(-2000);
    return `${head}\n\n... [${text.length - 3500} chars of verbose tool output omitted] ...\n\n${tail}`;
  }

  return text;
}

/**
 * 2. Skeletonizer（长源码文件骨架化）
 * 若历史中存在已读取、超过 1000 字符、且不是当前问题的文件，
 * 则把函数内部折叠掉，只保留 import 与函数签名。
 */
function skeletonizeCode(text) {
  if (typeof text !== 'string' || text.length < 2000) return text;

  // 不是成块的代码就不动
  if (!text.includes('function') && !text.includes('class') && !text.includes('def ')) return text;

  const lines = text.split('\n');
  if (lines.length < 60) return text;

  const head = lines.slice(0, 20).join('\n');
  const tail = lines.slice(-15).join('\n');
  return `${head}\n  // ... [middle file content skeletonized (${lines.length - 35} lines)] ...\n${tail}`;
}

/**
 * 3. Semantic Word Trimmer（去掉口语化噪声与开场白）
 */
function trimSemanticNoise(text) {
  if (typeof text !== 'string' || text.length < 150) return text;

  return text
    .replace(/^Sure,? I can help with that\.?\s*/i, '')
    .replace(/^Certainly!? Here is what I found:\s*/i, '')
    .replace(/^As an AI coding assistant,?\s*/i, '')
    .replace(/^I understand your request\.?\s*/i, '');
}

/**
 * 4. Hierarchical History Aging（历史消息分层老化）
 *  - Hot Zone（最近 3 条消息）：保持不变（100% 精确）。
 *  - Warm Zone（倒数第 4 到第 10 条）：应用 RTK 与 Skeletonizer。
 *  - Cold Zone（超过 10 条）：紧凑折叠。
 */
function compressConversationHistory(messages, options = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  const total = messages.length;
  // 只有对话足够长时才压缩
  if (total <= 4) return messages;

  return messages.map((msg, index) => {
    if (!msg || typeof msg.content !== 'string') return msg;

    const distanceFromEnd = total - 1 - index;

    // Hot Zone：最新鲜的上下文（最近 3 条消息）—— 不动
    if (distanceFromEnd <= 2) {
      return msg;
    }

    let newContent = msg.content;

    // Warm Zone：（倒数第 3 到第 8 步）—— 过滤日志与 diff
    if (distanceFromEnd <= 8) {
      if (msg.role === 'tool' || msg.role === 'user') {
        newContent = compressTerminalOutput(newContent);
      } else if (msg.role === 'assistant') {
        newContent = trimSemanticNoise(newContent);
      }
    } else {
      // Cold Zone：（超过 8 步之前）—— 深度骨架化并剔除噪声
      if (msg.role === 'tool') {
        newContent = compressTerminalOutput(newContent);
      } else if (msg.role === 'assistant') {
        newContent = skeletonizeCode(trimSemanticNoise(newContent));
      } else if (msg.role === 'user') {
        newContent = compressTerminalOutput(newContent);
      }
    }

    if (newContent === msg.content) return msg;
    return { ...msg, content: newContent };
  });
}

module.exports = {
  compressTerminalOutput,
  skeletonizeCode,
  trimSemanticNoise,
  compressConversationHistory,
};
