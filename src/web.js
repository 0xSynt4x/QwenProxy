'use strict';

const path = require('path');
const express = require('express');
const config = require('./config');
const chatStore = require('./chat-store');
const agent = require('./agent');
const toolExecutor = require('./tool-executor');
const accountStore = require('./account-store');
const { buildPoolStatus } = require('./pool-status');
const { logger } = require('./util');

/**
 * 聊天 Web 应用：静态资源 + REST API + 流式消息下发（SSE）。
 * 挂载在与 /v1 代理同一个 Express 服务器上。
 */

function attachWeb(app) {
  const publicDir = path.join(config.PROJECT_ROOT, 'public');

  // ---------- Static ----------
  // 号池看板是独立单页（/pool.html），不走聊天 SPA 的路由，直接静态托管。
  app.use(express.static(publicDir));

  // ---------- API: chats ----------
  app.get('/api/chats', (req, res) => {
    res.json({ chats: chatStore.list() });
  });

  app.post('/api/chats', (req, res) => {
    const body = req.body || {};
    const chat = chatStore.create({
      title: body.title || '新会话',
      model: body.model || config.DEFAULT_MODEL,
      settings: body.settings || {},
    });
    res.status(201).json({ chat });
  });

  app.get('/api/chats/:id', (req, res) => {
    const chat = chatStore.get(req.params.id);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    res.json({ chat });
  });

  app.delete('/api/chats/:id', (req, res) => {
    chatStore.remove(req.params.id);
    res.json({ ok: true });
  });

  app.patch('/api/chats/:id', (req, res) => {
    const body = req.body || {};
    const chat = chatStore.update(req.params.id, {
      title: body.title,
      model: body.model,
      settings: body.settings,
    });
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    res.json({ chat });
  });

  app.post('/api/chats/:id/clear', (req, res) => {
    const chat = chatStore.update(req.params.id, { messages: [] });
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    res.json({ ok: true });
  });

  // ---------- API: config ----------
  app.get('/api/models', (req, res) => {
    res.json({ models: config.MODELS, default: config.DEFAULT_MODEL });
  });

  // ---------- API: 号池状态（给 /pool.html 看板用） ----------
  // 号池几百个时不能靠肉眼翻 config/accounts/*.json，这里汇总成一张表：
  // 每个号当天各模型打了多少、谁打光了、谁在冷却、整体还剩多少配额。
  app.get('/api/pool', (req, res) => {
    try {
      const status = buildPoolStatus(
        accountStore.list(),
        config.MODELS,
        accountStore.DAILY_LIMIT,
        Date.now(),
      );
      res.json(status);
    } catch (err) {
      logger.error(`[pool status] ${err.message}`, 'WEB', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/workspace', (req, res) => {
    res.json({ workspace: toolExecutor.getWorkspace() });
  });

  app.post('/api/workspace', (req, res) => {
    const dir = (req.body || {}).workspace;
    if (!dir) return res.status(400).json({ error: 'workspace required' });
    toolExecutor.initWorkspace(dir);
    res.json({ workspace: toolExecutor.getWorkspace() });
  });

  // ---------- API: send message (SSE) ----------
  app.post('/api/chats/:id/messages', async (req, res) => {
    const id = req.params.id;
    const chat = chatStore.get(id);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });

    const content = String((req.body || {}).content || '').trim();
    if (!content) return res.status(400).json({ error: 'Empty message' });

    const patch = (req.body || {}).settings;
    if (patch) {
      chat.settings = { ...(chat.settings || {}), ...patch };
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const emit = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);

    try {
      const finalAssistant = await agent.runTurn(chat, content, emit);
      chatStore.save(chat);
      if (chat.messages.length > 0) {
        const firstUser = chat.messages.find((m) => m.role === 'user');
        const title = firstUser
          ? String(firstUser.content).slice(0, 42).replace(/\s+/g, ' ').trim()
          : '新会话';
        if (chat.title === '新会话' && title) chat.title = title;
        chatStore.save(chat);
      }
      emit({ type: 'done', content: finalAssistant.content });
    } catch (err) {
      logger.error(`[chat message] ${err.message}`, 'WEB', err);
      emit({ type: 'error', message: err.message });
    } finally {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  });
}

module.exports = { attachWeb };
