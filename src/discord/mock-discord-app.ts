/**
 * Mock Discord app — HTTP server that simulates Discord events for testing.
 * All outbound Discord API calls are logged to the terminal instead.
 */

import { createServer } from 'http';
import { execSync } from 'child_process';
import { stat, mkdir, copyFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { join, basename } from 'path';
import { SessionManager } from '../slack/session-manager.js';
import { ChannelStore } from './channel-store.js';
import { chunkMessage, formatSessionStatus, formatTodos } from '../slack/message-formatter.js';

const ALLOWED_MODELS = ['opus', 'sonnet', 'haiku'];

function parseBody(req: import('http').IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function json(res: import('http').ServerResponse, status: number, data: any) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2) + '\n');
}

export function createMockDiscordApp(port: number) {
  let store: ChannelStore;
  let channelCounter = 0;

  function channelName(channelId: string): string {
    return store?.get(channelId)?.channelName || channelId;
  }

  function log(channelId: string, msg: string) {
    console.log(`[mock-discord] #${channelName(channelId)} → ${msg}`);
  }

  const sessionManager = new SessionManager({
    onSessionStart: async (session) => {
      const channel = store?.getBySession(session.id);
      if (channel) {
        log(channel.channelId, `🟢 **Session started** \`${session.cwd}\``);
      }
    },

    onSessionEnd: async (sessionId) => {
      const channel = store?.getBySession(sessionId);
      if (!channel) return;
      if (channel.status !== 'running' && channel.status !== 'idle') return;
      log(channel.channelId, '🛑 **Session ended**');
    },

    onSessionUpdate: async (sessionId, name) => {
      const channel = store?.getBySession(sessionId);
      if (channel) {
        log(channel.channelId, `📝 Session name: ${name}`);
      }
    },

    onSessionStatus: async (sessionId, status) => {
      const channel = store?.getBySession(sessionId);
      if (channel) {
        log(channel.channelId, `${formatSessionStatus(status)} Status: ${status}`);
      }
    },

    onMessage: async (sessionId, role, content) => {
      const channel = store?.getBySession(sessionId);
      if (!channel) return;

      // Persist the Claude session UUID once it's known
      const claudeId = sessionManager.getClaudeSessionId(sessionId);
      if (claudeId && channel.claudeSessionId !== claudeId) {
        store.setClaudeSessionId(channel.channelId, claudeId);
        console.log(`[mock-discord] Persisted Claude session UUID: ${claudeId} for channel ${channel.channelId}`);
      }

      if (role === 'user') {
        log(channel.channelId, `[user] ${content.slice(0, 200)}`);
      } else {
        const chunks = chunkMessage(content);
        for (const chunk of chunks) {
          log(channel.channelId, `[assistant] ${chunk.slice(0, 200)}`);
        }
      }
    },

    onTodos: async (sessionId, todos) => {
      const channel = store?.getBySession(sessionId);
      if (channel && todos.length > 0) {
        log(channel.channelId, `📋 Tasks: ${formatTodos(todos)}`);
      }
    },

    onToolCall: async (sessionId, tool) => {
      const channel = store?.getBySession(sessionId);
      if (!channel) return;

      let inputSummary = '';
      if (tool.name === 'Bash' && tool.input.command) {
        inputSummary = `\`${tool.input.command.slice(0, 100)}\``;
      } else if (tool.input.file_path) {
        inputSummary = `\`${tool.input.file_path}\``;
      } else if (tool.input.pattern) {
        inputSummary = `\`${tool.input.pattern}\``;
      } else if (tool.input.description) {
        inputSummary = tool.input.description;
      }

      log(channel.channelId, inputSummary ? `🔧 ${tool.name}: ${inputSummary}` : `🔧 ${tool.name}`);
    },

    onToolResult: async (sessionId, result) => {
      const channel = store?.getBySession(sessionId);
      if (!channel) return;

      const prefix = result.isError ? '❌ Error' : '✅ Result';
      const content = result.content.length > 200
        ? result.content.slice(0, 200) + '...'
        : result.content;
      log(channel.channelId, `  ${prefix}: ${content}`);
    },

    onPlanModeChange: async (sessionId, inPlanMode) => {
      const channel = store?.getBySession(sessionId);
      if (channel) {
        log(channel.channelId, inPlanMode ? '📋 Plan mode active' : '🔨 Execution mode');
      }
    },

    onAskUserQuestion: async (sessionId, questions) => {
      const channel = store?.getBySession(sessionId);
      if (!channel) return;
      let text = '❓ Claude is asking:\n';
      for (const q of questions) {
        text += `  ${q.header ? q.header + ': ' : ''}${q.question}`;
        if (q.options?.length) {
          text += ' [' + q.options.map(o => o.label).join(', ') + ']';
        }
        text += '\n';
      }
      log(channel.channelId, text.trim());
    },
  });

  const server = createServer(async (req, res) => {
    try {
      const body = req.method === 'POST' ? await parseBody(req) : {};
      const url = req.url || '/';

      if (req.method === 'POST' && url === '/create-channel') {
        const { name } = body;
        if (!name || typeof name !== 'string') {
          return json(res, 400, { error: 'Missing "name" field' });
        }
        if (!name.startsWith('afk-')) {
          return json(res, 400, { error: 'Channel name must start with "afk-"' });
        }

        channelCounter++;
        const channelId = `mock-chan-${channelCounter}`;
        const home = homedir();
        const sessionId = randomUUID().slice(0, 8);

        store.register(channelId, name, home);

        console.log(`[mock-discord] Channel created: #${name} (${channelId})`);
        console.log(`[mock-discord] Auto-spawning session ${sessionId} in ${home}`);

        // Bind BEFORE spawning so onSessionStart can find the channel
        store.bindSession(channelId, sessionId);

        try {
          await sessionManager.spawnSession(sessionId, home);
          return json(res, 200, { channelId, name, sessionId, cwd: home });
        } catch (err: any) {
          store.unbindSession(channelId);
          store.transition(channelId, 'ended');
          console.error(`[mock-discord] Failed to spawn session: ${err.message || err}`);
          return json(res, 200, { channelId, name, error: `Failed to auto-spawn: ${err.message || err}` });
        }
      }

      if (req.method === 'POST' && url === '/change-topic') {
        const { channelId, topic } = body;
        if (!channelId || !topic) {
          return json(res, 400, { error: 'Missing "channelId" or "topic"' });
        }

        const channel = store.get(channelId);
        if (!channel) {
          return json(res, 404, { error: 'Channel not found' });
        }

        const cwd = topic.trim().replace(/\/+$/, '') || '/';

        try {
          const stats = await stat(cwd);
          if (!stats.isDirectory()) {
            return json(res, 400, { error: `Path is not a directory: ${cwd}` });
          }
        } catch {
          return json(res, 400, { error: `Path does not exist: ${cwd}` });
        }

        // Kill existing session for this channel if any
        const oldSessionId = channel.sessionId;
        if (oldSessionId) {
          console.log(`[mock-discord] Killing existing session ${oldSessionId} for #${channel.channelName}`);
          store.unbindSession(channelId);
          sessionManager.killSession(oldSessionId);
          await new Promise(r => setTimeout(r, 500));
        }

        // Remove old entry, register fresh
        store.remove(channelId);
        store.register(channelId, channel.channelName, cwd);

        const sessionId = randomUUID().slice(0, 8);

        console.log(`[mock-discord] Topic changed on #${channel.channelName}: ${cwd}`);
        console.log(`[mock-discord] Spawning session ${sessionId} in ${cwd}`);

        // Bind BEFORE spawning so onSessionStart can find the channel
        store.bindSession(channelId, sessionId);

        try {
          await sessionManager.spawnSession(sessionId, cwd);
          return json(res, 200, { sessionId, channelId, cwd, previousSessionId: oldSessionId || null });
        } catch (err: any) {
          store.unbindSession(channelId);
          store.transition(channelId, 'ended');
          return json(res, 500, { error: `Failed to spawn: ${err.message || err}` });
        }
      }

      if (req.method === 'POST' && url === '/send-message') {
        const { channelId, content, attachments } = body;
        if (!channelId || (!content && !attachments)) {
          return json(res, 400, { error: 'Missing "channelId" and "content" or "attachments"' });
        }

        // Build full content with attachments
        let fullContent = content || '';
        const savedPaths: string[] = [];
        if (Array.isArray(attachments)) {
          const attachDir = join(homedir(), '.afk-code', 'attachments');
          await mkdir(attachDir, { recursive: true });
          for (const filePath of attachments) {
            try {
              const prefix = randomUUID().slice(0, 8);
              const name = basename(filePath);
              const dest = join(attachDir, `${prefix}-${name}`);
              await copyFile(filePath, dest);
              savedPaths.push(dest);
              console.log(`[mock-discord] Saved attachment: ${name} → ${dest}`);
            } catch (err: any) {
              console.error(`[mock-discord] Failed to copy attachment ${filePath}:`, err.message);
            }
          }
          if (savedPaths.length > 0) {
            fullContent += '\nAttachment(s):\n' + savedPaths.join('\n');
          }
        }

        // Check if channel is archived — re-spawn session
        const channel = store.get(channelId);
        if (channel?.status === 'archived') {
          store.transition(channelId, 'resuming');

          const cwd = channel.cwd;
          const resumeSessionId = channel.claudeSessionId || undefined;
          const cleanName = channel.channelName.replace(/-archived$/, '');

          // Clean up old session binding
          store.unbindSession(channelId);

          // Spawn new session with --resume
          let newSessionId = randomUUID().slice(0, 8);

          console.log(`[mock-discord] Re-spawning session ${newSessionId} for archived channel #${channel.channelName} in ${cwd}`);

          // Bind BEFORE spawning so onSessionStart can find the channel
          store.bindSession(channelId, newSessionId);
          store.setChannelName(channelId, cleanName);

          try {
            await sessionManager.spawnSession(newSessionId, cwd, { resumeSessionId });

            // Check if Claude exited immediately (bad --resume)
            if (resumeSessionId) {
              const alive = await sessionManager.checkAlive(newSessionId);
              if (!alive) {
                console.log(`[mock-discord] Resume failed for #${channel.channelName}, retrying with fresh session`);
                const retryId = randomUUID().slice(0, 8);
                store.bindSession(channelId, retryId);
                await sessionManager.spawnSession(retryId, cwd);
                newSessionId = retryId;
              }
            }

            await sessionManager.waitForReady(newSessionId);
            await new Promise(r => setTimeout(r, 1000));

            // Send the message
            const sent = sessionManager.sendInput(newSessionId, fullContent);

            return json(res, 200, { ok: sent, resumed: true, newSessionId, attachments: savedPaths.length > 0 ? savedPaths : undefined });
          } catch (err: any) {
            store.unbindSession(channelId);
            store.transition(channelId, 'archived'); // revert
            return json(res, 500, { error: `Failed to re-spawn: ${err.message || err}` });
          }
        }

        if (!channel?.sessionId) {
          return json(res, 404, { error: 'No session for this channel' });
        }

        const sent = sessionManager.sendInput(channel.sessionId, fullContent);
        return json(res, sent ? 200 : 500, { ok: sent, attachments: savedPaths.length > 0 ? savedPaths : undefined });
      }

      if (req.method === 'POST' && url === '/command') {
        const { channelId, command } = body;
        if (!channelId || !command) {
          return json(res, 400, { error: 'Missing "channelId" or "command"' });
        }

        const channel = store.get(channelId);
        if (!channel?.sessionId) {
          return json(res, 404, { error: 'No session for this channel' });
        }

        const sessionId = channel.sessionId;
        let sent = false;
        const cmd = command.trim().toLowerCase();

        if (cmd === 'clear') {
          await sessionManager.resetWatchedFile(sessionId);
          sent = sessionManager.sendInput(sessionId, '/clear\n');
        } else if (cmd === 'interrupt') {
          sent = sessionManager.sendInput(sessionId, '\x1b', true);
        } else if (cmd === 'background') {
          sent = sessionManager.sendInput(sessionId, '\x02', true);
        } else if (cmd === 'mode') {
          sent = sessionManager.sendInput(sessionId, '\x1b[Z', true);
        } else if (cmd === 'compact') {
          sent = sessionManager.sendInput(sessionId, '/compact\n');
        } else if (cmd.startsWith('model ')) {
          const model = cmd.slice(6).trim();
          if (!ALLOWED_MODELS.includes(model)) {
            return json(res, 400, { error: `Invalid model. Choose from: ${ALLOWED_MODELS.join(', ')}` });
          }
          sent = sessionManager.sendInput(sessionId, `/model ${model}\n`);
        } else if (cmd === 'context') {
          const usage = await sessionManager.getContextUsage(sessionId);
          if (!usage) {
            return json(res, 200, { ok: true, command, message: 'No usage data yet' });
          }
          const pct = ((usage.totalTokens / usage.contextLimit) * 100).toFixed(1);
          const usedK = Math.round(usage.totalTokens / 1000);
          const limitK = usage.contextLimit / 1000;
          return json(res, 200, { ok: true, command, usedK, limitK, percent: pct, ...usage });
        } else if (cmd === 'tmux') {
          return json(res, 200, { ok: true, command, attach: `tmux attach -t afk-${sessionId}` });
        } else if (cmd === 'screenshot') {
          try {
            const paneText = sessionManager.capturePane(sessionId);
            return json(res, 200, { ok: true, command, paneText });
          } catch {
            return json(res, 500, { ok: false, command, error: 'Failed to capture tmux pane' });
          }
        } else if (cmd === 'archive') {
          if (channel.status === 'archived') {
            return json(res, 400, { error: 'Channel is already archived' });
          }

          const archivedName = `${channel.channelName}-archived`;
          store.transition(channelId, 'archived');
          store.setChannelName(channelId, archivedName);
          store.unbindSession(channelId);

          console.log(`[mock-discord] #${archivedName} → 📦 Session archived. Send a message to resume.`);
          sessionManager.killSession(sessionId);
          return json(res, 200, { ok: true, command, channelId, sessionId, message: 'Session archived. Send a message to resume.' });
        } else {
          return json(res, 400, { error: `Unknown command: ${command}` });
        }

        return json(res, sent ? 200 : 500, { ok: sent, command });
      }

      if (req.method === 'POST' && url === '/delete-channel') {
        const { channelId } = body;
        if (!channelId) {
          return json(res, 400, { error: 'Missing "channelId"' });
        }

        const channel = store.get(channelId);
        if (!channel) {
          return json(res, 404, { error: 'Channel not found' });
        }

        const sessionId = channel.sessionId;
        if (sessionId) {
          console.log(`[mock-discord] Deleting channel #${channel.channelName}, killing session ${sessionId}`);
          store.remove(channelId);
          sessionManager.killSession(sessionId);
          await new Promise(r => setTimeout(r, 500));
        } else {
          store.remove(channelId);
        }

        console.log(`[mock-discord] Channel deleted: #${channel.channelName} (${channelId})`);
        return json(res, 200, { ok: true, channelId, killedSessionId: sessionId || null });
      }

      // Test-only: manipulate channel state for testing edge cases
      if (req.method === 'POST' && url === '/set-channel-state') {
        const { channelId, claudeSessionId, status } = body;
        if (!channelId) {
          return json(res, 400, { error: 'Missing "channelId"' });
        }

        const channel = store.get(channelId);
        if (!channel) {
          return json(res, 404, { error: 'Channel not found' });
        }

        if (claudeSessionId !== undefined) {
          store.setClaudeSessionId(channelId, claudeSessionId);
        }
        if (status) {
          // Force status directly (bypasses transition validation — test only)
          store.forceStatus(channelId, status);
        }

        const updated = store.get(channelId);
        return json(res, 200, {
          ok: true,
          channelId,
          status: updated?.status,
          claudeSessionId: updated?.claudeSessionId,
        });
      }

      if (req.method === 'GET' && (url === '/sessions' || url === '/sessions?all=true')) {
        const sessions = sessionManager.getAllSessions();
        const includeAll = url.includes('all=true');
        const channelSource = includeAll ? store.getAll() : store.getAllActive();
        const channelList = channelSource.map(ch => ({
          channelId: ch.channelId,
          name: ch.channelName,
          cwd: ch.cwd,
          sessionId: ch.sessionId,
          claudeSessionId: ch.claudeSessionId,
          status: ch.status,
        }));
        return json(res, 200, { sessions, channels: channelList });
      }

      // Default: show available endpoints
      return json(res, 200, {
        endpoints: {
          'POST /create-channel': { body: '{ "name": "afk-test" }' },
          'POST /change-topic': { body: '{ "channelId": "...", "topic": "/path/to/dir" }' },
          'POST /delete-channel': { body: '{ "channelId": "..." }' },
          'POST /send-message': { body: '{ "channelId": "...", "content": "hello" }' },
          'POST /command': { body: '{ "channelId": "...", "command": "clear|interrupt|background|mode|compact|model opus|archive" }' },
          'GET /sessions': 'List all sessions and channels',
        },
      });
    } catch (err: any) {
      json(res, 500, { error: err.message || 'Internal error' });
    }
  });

  return {
    server,
    sessionManager,
    async start() {
      await sessionManager.start();

      // Load persisted state for orphan recovery
      store = await ChannelStore.load();

      // Discover running afk-* tmux sessions
      const runningTmuxSessions = new Set<string>();
      try {
        const tmuxOutput = execSync("tmux ls -F '#{session_name}'", { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        for (const line of tmuxOutput.trim().split('\n')) {
          const name = line.trim();
          if (name.startsWith('afk-')) {
            runningTmuxSessions.add(name.slice(4));
          }
        }
        if (runningTmuxSessions.size > 0) {
          console.log(`[mock-discord] Found ${runningTmuxSessions.size} running afk-* tmux session(s)`);
        }
      } catch {
        // No tmux sessions running
      }

      // Try to re-attach to tmux sessions that match persisted state
      const claimedSessions = new Set<string>();
      for (const ch of store.getAll()) {
        if (ch.sessionId && runningTmuxSessions.has(ch.sessionId)) {
          console.log(`[mock-discord] Re-attaching to tmux session afk-${ch.sessionId} for channel ${ch.channelId}`);
          claimedSessions.add(ch.sessionId);

          channelCounter++;
          try {
            await sessionManager.attachSession(ch.sessionId, ch.cwd);
            store.bindSession(ch.channelId, ch.sessionId);
            console.log(`[mock-discord] Successfully re-attached to afk-${ch.sessionId}`);
          } catch (err) {
            console.error(`[mock-discord] Failed to attach to afk-${ch.sessionId}:`, err);
            store.transition(ch.channelId, 'ended');
          }
          continue;
        }

        // Ended channels with no live tmux — try to restore by spawning fresh
        if (ch.status === 'ended') {
          console.log(`[mock-discord] Restoring ended channel #${ch.channelName} in ${ch.cwd}`);
          store.transition(ch.channelId, 'spawning');

          channelCounter++;
          const sessionId = randomUUID().slice(0, 8);
          const resumeSessionId = ch.claudeSessionId || undefined;

          store.bindSession(ch.channelId, sessionId);

          try {
            await sessionManager.spawnSession(sessionId, ch.cwd, { resumeSessionId });

            // Check for early exit (bad --resume)
            if (resumeSessionId) {
              const alive = await sessionManager.checkAlive(sessionId);
              if (!alive) {
                console.log(`[mock-discord] Resume failed for #${ch.channelName}, retrying with fresh session`);
                const retryId = randomUUID().slice(0, 8);
                store.bindSession(ch.channelId, retryId);
                await sessionManager.spawnSession(retryId, ch.cwd);
              }
            }

            console.log(`[mock-discord] Restored #${ch.channelName}`);
          } catch (err) {
            console.error(`[mock-discord] Failed to restore #${ch.channelName}:`, err);
            store.transition(ch.channelId, 'ended');
          }
        }
      }

      // Kill orphaned tmux sessions not claimed by any channel
      for (const tmuxSessionId of runningTmuxSessions) {
        if (!claimedSessions.has(tmuxSessionId)) {
          console.log(`[mock-discord] Killing orphaned tmux session: afk-${tmuxSessionId}`);
          try {
            execSync(`tmux kill-session -t afk-${tmuxSessionId}`, { stdio: 'ignore' });
          } catch {}
        }
      }

      await new Promise<void>((resolve) => {
        server.listen(port, () => resolve());
      });
    },
    stop() {
      sessionManager.stop();
      server.close();
    },
  };
}
