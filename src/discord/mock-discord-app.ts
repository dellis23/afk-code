/**
 * Mock Discord app — HTTP server that simulates Discord events for testing.
 * All outbound Discord API calls are logged to the terminal instead.
 */

import { createServer } from 'http';
import { stat } from 'fs/promises';
import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { SessionManager } from '../slack/session-manager.js';
import { chunkMessage, formatSessionStatus, formatTodos } from '../slack/message-formatter.js';

const ALLOWED_MODELS = ['opus', 'sonnet', 'haiku'];

interface MockChannel {
  id: string;
  name: string;
  topic?: string;
  sessionId?: string;
}

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
  const channels = new Map<string, MockChannel>();
  const channelToSession = new Map<string, string>();
  const sessionToChannel = new Map<string, string>();
  let channelCounter = 0;

  function channelName(channelId: string): string {
    return channels.get(channelId)?.name || channelId;
  }

  function log(channelId: string, msg: string) {
    console.log(`[mock-discord] #${channelName(channelId)} → ${msg}`);
  }

  const sessionManager = new SessionManager({
    onSessionStart: async (session) => {
      const chId = sessionToChannel.get(session.id);
      if (chId) {
        log(chId, `🟢 **Session started** \`${session.cwd}\``);
      }
    },

    onSessionEnd: async (sessionId) => {
      const chId = sessionToChannel.get(sessionId);
      if (chId) {
        log(chId, '🛑 **Session ended**');
      }
    },

    onSessionUpdate: async (sessionId, name) => {
      const chId = sessionToChannel.get(sessionId);
      if (chId) {
        log(chId, `📝 Session name: ${name}`);
      }
    },

    onSessionStatus: async (sessionId, status) => {
      const chId = sessionToChannel.get(sessionId);
      if (chId) {
        log(chId, `${formatSessionStatus(status)} Status: ${status}`);
      }
    },

    onMessage: async (sessionId, role, content) => {
      const chId = sessionToChannel.get(sessionId);
      if (!chId) return;

      if (role === 'user') {
        log(chId, `[user] ${content.slice(0, 200)}`);
      } else {
        const chunks = chunkMessage(content);
        for (const chunk of chunks) {
          log(chId, `[assistant] ${chunk.slice(0, 200)}`);
        }
      }
    },

    onTodos: async (sessionId, todos) => {
      const chId = sessionToChannel.get(sessionId);
      if (chId && todos.length > 0) {
        log(chId, `📋 Tasks: ${formatTodos(todos)}`);
      }
    },

    onToolCall: async (sessionId, tool) => {
      const chId = sessionToChannel.get(sessionId);
      if (!chId) return;

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

      log(chId, inputSummary ? `🔧 ${tool.name}: ${inputSummary}` : `🔧 ${tool.name}`);
    },

    onToolResult: async (sessionId, result) => {
      const chId = sessionToChannel.get(sessionId);
      if (!chId) return;

      const prefix = result.isError ? '❌ Error' : '✅ Result';
      const content = result.content.length > 200
        ? result.content.slice(0, 200) + '...'
        : result.content;
      log(chId, `  ${prefix}: ${content}`);
    },

    onPlanModeChange: async (sessionId, inPlanMode) => {
      const chId = sessionToChannel.get(sessionId);
      if (chId) {
        log(chId, inPlanMode ? '📋 Plan mode active' : '🔨 Execution mode');
      }
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
        if (!name.startsWith('claude-')) {
          return json(res, 400, { error: 'Channel name must start with "claude-"' });
        }

        channelCounter++;
        const channelId = `mock-chan-${channelCounter}`;
        const home = homedir();
        const sessionId = randomUUID().slice(0, 8);

        channels.set(channelId, { id: channelId, name, topic: home, sessionId });
        channelToSession.set(channelId, sessionId);
        sessionToChannel.set(sessionId, channelId);

        console.log(`[mock-discord] Channel created: #${name} (${channelId})`);
        console.log(`[mock-discord] Auto-spawning session ${sessionId} in ${home}`);

        try {
          await sessionManager.spawnSession(sessionId, home);
          return json(res, 200, { channelId, name, sessionId, cwd: home });
        } catch (err: any) {
          // Clean up on failure
          channels.get(channelId)!.sessionId = undefined;
          channelToSession.delete(channelId);
          sessionToChannel.delete(sessionId);
          console.error(`[mock-discord] Failed to spawn session: ${err.message || err}`);
          return json(res, 200, { channelId, name, error: `Failed to auto-spawn: ${err.message || err}` });
        }
      }

      if (req.method === 'POST' && url === '/change-topic') {
        const { channelId, topic } = body;
        if (!channelId || !topic) {
          return json(res, 400, { error: 'Missing "channelId" or "topic"' });
        }

        const channel = channels.get(channelId);
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
          console.log(`[mock-discord] Killing existing session ${oldSessionId} for #${channel.name}`);
          sessionToChannel.delete(oldSessionId);
          channelToSession.delete(channelId);
          sessionManager.killSession(oldSessionId);
          channel.sessionId = undefined;
          // Brief pause for cleanup
          await new Promise(r => setTimeout(r, 500));
        }

        const sessionId = randomUUID().slice(0, 8);
        channel.topic = cwd;
        channel.sessionId = sessionId;
        channelToSession.set(channelId, sessionId);
        sessionToChannel.set(sessionId, channelId);

        console.log(`[mock-discord] Topic changed on #${channel.name}: ${cwd}`);
        console.log(`[mock-discord] Spawning session ${sessionId} in ${cwd}`);

        try {
          await sessionManager.spawnSession(sessionId, cwd);
          return json(res, 200, { sessionId, channelId, cwd, previousSessionId: oldSessionId || null });
        } catch (err: any) {
          // Clean up on failure
          channel.sessionId = undefined;
          channelToSession.delete(channelId);
          sessionToChannel.delete(sessionId);
          return json(res, 500, { error: `Failed to spawn: ${err.message || err}` });
        }
      }

      if (req.method === 'POST' && url === '/send-message') {
        const { channelId, content } = body;
        if (!channelId || !content) {
          return json(res, 400, { error: 'Missing "channelId" or "content"' });
        }

        const sessionId = channelToSession.get(channelId);
        if (!sessionId) {
          return json(res, 404, { error: 'No session for this channel' });
        }

        const sent = sessionManager.sendInput(sessionId, content);
        return json(res, sent ? 200 : 500, { ok: sent });
      }

      if (req.method === 'POST' && url === '/command') {
        const { channelId, command } = body;
        if (!channelId || !command) {
          return json(res, 400, { error: 'Missing "channelId" or "command"' });
        }

        const sessionId = channelToSession.get(channelId);
        if (!sessionId) {
          return json(res, 404, { error: 'No session for this channel' });
        }

        let sent = false;
        const cmd = command.trim().toLowerCase();

        if (cmd === 'clear') {
          sessionManager.resetWatchedFile(sessionId);
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

        const channel = channels.get(channelId);
        if (!channel) {
          return json(res, 404, { error: 'Channel not found' });
        }

        // Kill session if one exists (unregister mappings first, then kill)
        const sessionId = channel.sessionId;
        if (sessionId) {
          console.log(`[mock-discord] Deleting channel #${channel.name}, killing session ${sessionId}`);
          sessionToChannel.delete(sessionId);
          channelToSession.delete(channelId);
          sessionManager.killSession(sessionId);
          // Brief pause for cleanup
          await new Promise(r => setTimeout(r, 500));
        }

        channels.delete(channelId);
        console.log(`[mock-discord] Channel deleted: #${channel.name} (${channelId})`);
        return json(res, 200, { ok: true, channelId, killedSessionId: sessionId || null });
      }

      if (req.method === 'GET' && url === '/sessions') {
        const sessions = sessionManager.getAllSessions();
        const channelList = Array.from(channels.values()).map(ch => ({
          channelId: ch.id,
          name: ch.name,
          topic: ch.topic,
          sessionId: ch.sessionId,
        }));
        return json(res, 200, { sessions, channels: channelList });
      }

      // Default: show available endpoints
      return json(res, 200, {
        endpoints: {
          'POST /create-channel': { body: '{ "name": "claude-test" }' },
          'POST /change-topic': { body: '{ "channelId": "...", "topic": "/path/to/dir" }' },
          'POST /delete-channel': { body: '{ "channelId": "..." }' },
          'POST /send-message': { body: '{ "channelId": "...", "content": "hello" }' },
          'POST /command': { body: '{ "channelId": "...", "command": "clear|interrupt|background|mode|compact|model opus" }' },
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
