'use strict';

const qwenClient = require('./qwen-client');
const chatAdapter = require('./chat-adapter');
const toolProtocol = require('./tools');
const toolExecutor = require('./tool-executor');
const { logger } = require('./util');

/**
 * 聊天的 Agent 循环。
 *
 * 过去每一轮都通过 HTTP 请求打到项目自己的 /v1/chat/completions
 * （PROXY_URL）。这破坏了工具循环：每一轮都要做一次 OpenAI<->Qwen 的
 * 双重序列化，多一次 HTTP 跳转，且 /v1 内部重试时会悄无声息地重建上游会话。
 * 现在 Agent 通过 chat-adapter/qwen-client 直接调用 Qwen：
 *   - chat.qwenChatId 记在聊天对象上并随 chatStore.save() 持久化，
 *     因此同一聊天的所有轮次都延续同一个上游会话；
 *   - 已有 chatId 时适配器只发送当前消息（currentOnly），
 *     不再把整段历史重复塞进每一次工具调用；
 *   - 会话死亡（frames=0）-> 在全新会话上用完整历史重试一次，
 *     与 server.js 中的 retry 一致。
 *
 * 发给 Web 客户端的事件不变：reasoning/text/round/tool/tool_result。
 */

const MAX_ROUNDS = 6;

// ---------------------------------------------------------------------------
// Qwen 流消费者：reasoning/content -> 客户端，tool_calls -> 交给执行器
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{content:string, reasoning:string, toolCalls:Array, finish:string|null}>}
 */
function consumeQwenStream(stream, emit, toolParser) {
  return new Promise((resolve, reject) => {
    const state = {
      content: '',
      reasoning: '', // UI 增量事件用的缓冲区
      reasoningAll: '', // 写入聊天历史的完整 reasoning
      byIndex: new Map(), // index -> {id, name, arguments}
      finish: null,
    };

    const sendReasoning = () => {
      if (state.reasoning) {
        emit({ type: 'reasoning', text: state.reasoning });
        state.reasoning = '';
      }
    };

    const handleLine = (raw) => {
      const trimmed = String(raw).trim();
      if (!trimmed.startsWith('data:')) return;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      let obj;
      try {
        obj = JSON.parse(payload);
      } catch (_) {
        return;
      }
      if (obj.error) {
        reject(new Error(obj.error.message || 'Upstream error'));
        return;
      }
      const choice = obj.choices && obj.choices[0];
      if (!choice) return;
      if (choice.finish_reason) state.finish = choice.finish_reason;

      const delta = choice.delta || {};
      if (delta.reasoning_content) {
        state.reasoning += delta.reasoning_content;
        state.reasoningAll += delta.reasoning_content;
      }
      if (delta.content) {
        sendReasoning();
        state.content += delta.content;
        emit({ type: 'text', text: delta.content });
      }
      if (delta.tool_calls) {
        sendReasoning();
        for (const tc of delta.tool_calls) {
          const index = tc.index ?? 0;
          let entry = state.byIndex.get(index);
          if (!entry) {
            entry = { id: tc.id, name: '', arguments: '' };
            state.byIndex.set(index, entry);
          }
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name += tc.function.name;
          if (tc.function?.arguments) entry.arguments += tc.function.arguments;
        }
      }
    };

    // parseQwenSSE 自己切分上游 SSE，并输出 OpenAI 形状的行，
    // 传入 toolParser 时还包括 tool_calls 增量。
    chatAdapter.parseQwenSSE(
      stream,
      handleLine,
      (error) => {
        if (error) {
          reject(error);
          return;
        }
        sendReasoning();
        const toolCalls = [...state.byIndex.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([index, c]) => ({
            id: c.id || `call_${index}`,
            type: 'function',
            function: { name: c.name, arguments: c.arguments || '{}' },
          }));
        resolve({
          content: state.content,
          reasoning: state.reasoningAll,
          toolCalls,
          finish: state.finish,
        });
      },
      { toolParser }
    );
  });
}

// ---------------------------------------------------------------------------
// 按聊天设置选择工具集
// ---------------------------------------------------------------------------

function pickTools(settings) {
  const tools = [];
  const add = (name) => {
    const def = toolExecutor.TOOL_DEFS.find((t) => t.function.name === name);
    if (def) tools.push(def);
  };
  if (settings.terminal !== false) add('bash');
  if (settings.files !== false) {
    add('list_dir');
    add('read_file');
    add('write_file');
    add('edit_file');
  }
  if (settings.webSearch !== false) add('web_search');
  return tools;
}

// ---------------------------------------------------------------------------
// 单个轮次：准备 payload -> 发给 Qwen -> 收集流
// ---------------------------------------------------------------------------

async function requestRound(body, chat, emit) {
  // 没有 chatId 时 preparePublicPayload 会新建一个上游会话，并把
  // 完整历史作为首条消息发出（currentOnly=false）。有 chatId 时只发
  // 当前消息：该会话已经保留了之前的轮次。
  const prepared = await chatAdapter.preparePublicPayload(body, {
    chatId: chat.qwenChatId || undefined,
  });
  chat.qwenChatId = prepared.chatId;

  const response = await qwenClient.sendChatRequest(prepared.qwenPayload);
  if (!response || !response.status) {
    throw new Error((response && response.message) || 'Qwen upstream request failed');
  }

  const toolParser = prepared.hasTools ? toolProtocol.createToolCallStreamParser() : null;
  return consumeQwenStream(response.response, emit, toolParser);
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------

/**
 * 执行一次用户回合。
 * @param {Object} chat - 存储中的聊天对象（会改写 messages 和 qwenChatId）
 * @param {string} userText
 * @param {(ev:Object)=>void} emit - 向客户端发送事件
 * @returns {Promise<Object>} 最终的 assistant 消息
 */
async function runTurn(chat, userText, emit) {
  const settings = chat.settings || {};
  const tools = pickTools(settings);
  chat.messages.push({ role: 'user', content: userText });

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    emit({ type: 'round', round });

    const body = {
      model: chat.model,
      messages: chat.messages,
      stream: true,
    };
    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    if (settings.thinking) body.thinking = true;
    if (settings.webSearch) body.search = true;

    let result;
    try {
      result = await requestRound(body, chat, emit);
    } catch (err) {
      if (err.message && err.message.includes('WAF_CAPTCHA_CHALLENGE')) {
        const captchaResolver = require('./captcha-resolver');
        const accountStore = require('./account-store');
        const acc = accountStore.current();
        if (acc) captchaResolver.solveCaptcha(acc.id);
      }
      // 会话一帧都没吐就死了：清空 qwenChatId，并在全新会话上
      // 重试一次该轮次（完整历史会自动带上）。
      const deadThread = /^Qwen upstream closed without a usable response \(frames=0/.test(err.message);
      if (!deadThread || !chat.qwenChatId) throw err;
      logger.warn('Qwen thread died without output, retrying on a fresh thread', 'AGENT');
      chat.qwenChatId = null;
      result = await requestRound(body, chat, emit);
    }

    if (result.toolCalls.length === 0) {
      const content = result.content.trim() ? result.content : '(空回复)';
      const finalAssistant = { role: 'assistant', content };
      if (result.reasoning) finalAssistant.reasoning_content = result.reasoning;
      chat.messages.push(finalAssistant);
      return finalAssistant;
    }

    // 把 tool_calls 作为 assistant 消息回放到历史中
    chat.messages.push({
      role: 'assistant',
      content: result.content || null,
      tool_calls: result.toolCalls.map((tc, i) => ({ ...tc, index: i })),
    });

    // 执行工具
    for (const call of result.toolCalls) {
      const name = call.function.name;
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch (_) {
        args = {};
      }
      emit({ type: 'tool', name, args });
      const output = await toolExecutor.executeTool(name, args);
      emit({ type: 'tool_result', name, output });
      chat.messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name,
        content: output,
      });
    }
  }

  const fallback = { role: 'assistant', content: '(达到步数上限，已停止)' };
  chat.messages.push(fallback);
  return fallback;
}

module.exports = { runTurn, consumeQwenStream, pickTools };
