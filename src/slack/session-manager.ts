/**
 * Session manager for Slack bot - handles JSONL watching and Unix socket communication
 * This replaces the need for the daemon + relay.
 */

import { watch, type FSWatcher } from 'fs';
import { readdir, readFile, stat, unlink, mkdir, writeFile } from 'fs/promises';
import { createServer, type Server, type Socket } from 'net';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import type { IPty } from 'node-pty';
import type { TodoItem } from '../types.js';
import { sanitizePtyInput } from '../utils/sanitize.js';
import { getClaudeProjectDir } from '../utils/claude-paths.js';

const AFK_CODE_DIR = join(homedir(), '.afk-code');
export const DAEMON_SOCKET = join(AFK_CODE_DIR, 'daemon.sock');
export const DAEMON_SECRET_PATH = join(AFK_CODE_DIR, 'daemon.secret');

export interface SessionInfo {
  id: string;
  name: string;
  cwd: string;
  projectDir: string;
  status: 'running' | 'idle' | 'ended';
  startedAt: Date;
}

interface InternalSession extends SessionInfo {
  socket?: Socket;    // present for remote CLI sessions
  pty?: IPty;         // present for locally-spawned sessions
  watcher?: FSWatcher;
  watchedFile?: string;
  jsonlOffset: number;
  resumed: boolean; // true if session was spawned with --resume
  slugFound: boolean;
  lastTodosHash: string;
  inPlanMode: boolean;
  initialFileStats: Map<string, number>; // path -> mtime at session start
  previousWatchedFiles: Set<string>; // files we've already moved on from
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface ToolCallInfo {
  id: string;
  name: string;
  input: any;
}

export interface ToolResultInfo {
  toolUseId: string;
  content: string;
  isError: boolean;
}

export interface AskUserQuestionOption {
  label: string;
  description?: string;
}

export interface AskUserQuestionItem {
  header?: string;
  question: string;
  options?: AskUserQuestionOption[];
  multiSelect?: boolean;
}

export interface SessionEvents {
  onSessionStart: (session: SessionInfo) => void;
  onSessionEnd: (sessionId: string) => void;
  onSessionUpdate: (sessionId: string, name: string) => void;
  onSessionStatus: (sessionId: string, status: 'running' | 'idle' | 'ended') => void;
  onMessage: (sessionId: string, role: 'user' | 'assistant', content: string) => void;
  onTodos: (sessionId: string, todos: TodoItem[]) => void;
  onToolCall: (sessionId: string, tool: ToolCallInfo) => void;
  onToolResult: (sessionId: string, result: ToolResultInfo) => void;
  onPlanModeChange: (sessionId: string, inPlanMode: boolean) => void;
  onAskUserQuestion: (sessionId: string, questions: AskUserQuestionItem[]) => void;
}

function hash(data: string): string {
  return createHash('md5').update(data).digest('hex');
}

export class SessionManager {
  private sessions = new Map<string, InternalSession>();
  private claimedFiles = new Set<string>();
  private events: SessionEvents;
  private server: Server | null = null;
  private sharedSecret: string = '';

  constructor(events: SessionEvents) {
    this.events = events;
  }

  async start(): Promise<void> {
    // Ensure ~/.afk-code directory exists with restricted permissions
    await mkdir(AFK_CODE_DIR, { recursive: true, mode: 0o700 });

    // Generate shared secret for socket authentication
    this.sharedSecret = randomBytes(32).toString('hex');
    await writeFile(DAEMON_SECRET_PATH, this.sharedSecret, { mode: 0o600 });

    // Remove old socket file
    try {
      await unlink(DAEMON_SOCKET);
    } catch {}

    // Start Unix socket server
    this.server = createServer((socket) => {
      let messageBuffer = '';

      socket.on('data', (data) => {
        messageBuffer += data.toString();
        const lines = messageBuffer.split('\n');
        messageBuffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            this.handleSessionMessage(socket, parsed);
          } catch (error) {
            console.error('[SessionManager] Error parsing message:', error);
          }
        }
      });

      socket.on('error', (error) => {
        console.error('[SessionManager] Socket error:', error);
      });

      socket.on('close', () => {
        // Find and cleanup session for this socket
        for (const [id, session] of this.sessions) {
          if (session.socket === socket) {
            console.log(`[SessionManager] Session disconnected: ${id}`);
            this.stopWatching(session);
            this.sessions.delete(id);
            this.events.onSessionEnd(id);
            break;
          }
        }
      });
    });

    this.server.listen(DAEMON_SOCKET, () => {
      console.log(`[SessionManager] Listening on ${DAEMON_SOCKET}`);
    });
  }

  stop(): void {
    for (const session of this.sessions.values()) {
      this.stopWatching(session);
      if (session.pty) {
        try {
          session.pty.kill();
        } catch {}
        try {
          execSync(`tmux kill-session -t afk-${session.id}`, { stdio: 'ignore' });
        } catch {}
      }
    }
    this.sessions.clear();
    if (this.server) {
      this.server.close();
    }
  }

  async spawnSession(sessionId: string, cwd: string, options?: { resumeSessionId?: string }): Promise<void> {
    const pty = await import('node-pty');
    // Normalize: strip trailing slashes so the project dir matches what Claude uses
    cwd = cwd.replace(/\/+$/, '') || '/';
    const projectDir = getClaudeProjectDir(cwd);

    const claudeArgs = ['--dangerously-skip-permissions'];
    if (options?.resumeSessionId) {
      claudeArgs.push('--resume', options.resumeSessionId);
    }

    // Wrap in tmux so we can `tmux attach -t afk-<id>` to inspect/debug
    const tmuxSessionName = `afk-${sessionId}`;
    const command = ['tmux', 'new-session', '-s', tmuxSessionName, '--', 'claude', ...claudeArgs];

    // Strip Claude-related env vars so the child process doesn't think
    // it's nested inside another Claude session
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    const ptyProcess = pty.spawn(command[0], command.slice(1), {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd,
      env: env as Record<string, string>,
    });

    // Snapshot existing JSONL files before creating session
    const initialFileStats = await this.snapshotJsonlFiles(projectDir);

    const session: InternalSession = {
      id: sessionId,
      name: `claude-${sessionId}`,
      cwd,
      projectDir,
      pty: ptyProcess,
      status: 'running',
      jsonlOffset: 0,
      resumed: !!options?.resumeSessionId,
      startedAt: new Date(),
      slugFound: false,
      lastTodosHash: '',
      inPlanMode: false,
      initialFileStats,
      previousWatchedFiles: new Set(),
    };

    this.sessions.set(sessionId, session);
    console.log(`[SessionManager] Spawned local session: ${sessionId} in ${cwd} (tmux: ${tmuxSessionName})`);

    // Drain PTY output to prevent the buffer from filling up and blocking Claude.
    // The actual conversation data comes from JSONL file watching, not PTY output.
    ptyProcess.onData(() => {});

    ptyProcess.onExit(() => {
      console.log(`[SessionManager] Local session exited: ${sessionId}`);
      this.stopWatching(session);
      this.sessions.delete(sessionId);
      this.events.onSessionEnd(sessionId);
    });

    this.events.onSessionStart({
      id: session.id,
      name: session.name,
      cwd: session.cwd,
      projectDir: session.projectDir,
      status: session.status,
      startedAt: session.startedAt,
    });

    this.startWatching(session);

    // Claude Code shows a workspace trust prompt on first launch.
    // Auto-dismiss it so the first user message doesn't get eaten.
    this.dismissTrustPrompt(sessionId, tmuxSessionName);
  }

  /**
   * Wait briefly and check if the session is still alive.
   * Returns true if alive, false if the process exited within the grace period.
   * Used to detect --resume failures where Claude exits immediately.
   */
  async checkAlive(sessionId: string, graceMs = 2000): Promise<boolean> {
    await new Promise(resolve => setTimeout(resolve, graceMs));
    return this.sessions.has(sessionId);
  }

  /**
   * Attach to an existing tmux session instead of spawning a new one.
   * Used for orphan recovery on restart — re-uses a live tmux session
   * so we don't spawn a duplicate Claude process.
   */
  async attachSession(sessionId: string, cwd: string): Promise<void> {
    const pty = await import('node-pty');
    cwd = cwd.replace(/\/+$/, '') || '/';
    const projectDir = getClaudeProjectDir(cwd);

    const tmuxSessionName = `afk-${sessionId}`;

    // Strip Claude-related env vars
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    const ptyProcess = pty.spawn('tmux', ['attach-session', '-t', tmuxSessionName], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd,
      env: env as Record<string, string>,
    });

    // Snapshot existing JSONL files — we'll look for the most recent one
    const initialFileStats = await this.snapshotJsonlFiles(projectDir);

    const session: InternalSession = {
      id: sessionId,
      name: `claude-${sessionId}`,
      cwd,
      projectDir,
      pty: ptyProcess,
      status: 'running',
      jsonlOffset: 0,
      resumed: false,
      startedAt: new Date(0), // epoch so we don't skip existing messages
      slugFound: false,
      lastTodosHash: '',
      inPlanMode: false,
      initialFileStats,
      previousWatchedFiles: new Set(),
    };

    this.sessions.set(sessionId, session);
    console.log(`[SessionManager] Attached to existing tmux session: ${tmuxSessionName} in ${cwd}`);

    // Drain PTY output
    ptyProcess.onData(() => {});

    ptyProcess.onExit(() => {
      console.log(`[SessionManager] Attached session exited: ${sessionId}`);
      this.stopWatching(session);
      this.sessions.delete(sessionId);
      this.events.onSessionEnd(sessionId);
    });

    this.events.onSessionStart({
      id: session.id,
      name: session.name,
      cwd: session.cwd,
      projectDir: session.projectDir,
      status: session.status,
      startedAt: session.startedAt,
    });

    this.startWatching(session);
  }

  /**
   * Reset the watched JSONL file for a session, so the watcher picks up
   * the next new file. Used after /clear which starts a new conversation.
   */
  async resetWatchedFile(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.watchedFile) {
      // Keep the old file in claimedFiles so it's never re-found by
      // findActiveJsonlFile. Only clear the watchedFile reference so the
      // watcher/poll picks up the next new unclaimed file.
      session.watchedFile = undefined;
      session.jsonlOffset = 0;
      session.slugFound = false;

      // Re-snapshot all existing JSONL files so findActiveJsonlFile treats
      // them as "old" and only picks up truly new files created after /clear.
      // Without this, it can claim an unrelated session's JSONL from the same
      // project directory and replay its entire history.
      session.initialFileStats = await this.snapshotJsonlFiles(session.projectDir);

      console.log(`[SessionManager] Reset watched file for session ${sessionId}`);
    }
  }

  killSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.pty) {
      try {
        session.pty.kill();
      } catch {}
      // Clean up the tmux session as a safety net
      try {
        execSync(`tmux kill-session -t afk-${sessionId}`, { stdio: 'ignore' });
      } catch {}
    }

    if (session.socket) {
      try {
        session.socket.end();
      } catch {}
    }
  }

  sendInput(sessionId: string, text: string, raw?: boolean): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.error(`[SessionManager] Session not found: ${sessionId}`);
      return false;
    }

    // Sanitize input unless raw mode is requested (for control sequences)
    const sanitizedText = raw ? text : sanitizePtyInput(text);

    if (session.pty) {
      // Local PTY session — write directly
      try {
        session.pty.write(sanitizedText);
      } catch (err) {
        console.error(`[SessionManager] Failed to write to PTY for ${sessionId}:`, err);
        return false;
      }

      // Scale delay for long pastes — Claude Code needs time to process
      // "[pasted text]" before it's ready to receive Enter.
      // Short messages keep the original 50ms; only scale above 500 chars.
      const delay = Math.min(50 + Math.max(0, sanitizedText.length - 500), 2000);
      setTimeout(() => {
        try {
          session.pty?.write('\r');
        } catch {
          // PTY likely already dead
        }
      }, delay);

      return true;
    }

    if (session.socket) {
      // Remote CLI session — send JSON over socket
      try {
        session.socket.write(JSON.stringify({ type: 'input', text: sanitizedText }) + '\n');
      } catch (err) {
        console.error(`[SessionManager] Failed to send input to ${sessionId}:`, err);
        // Socket is dead, clean up
        this.stopWatching(session);
        this.sessions.delete(sessionId);
        this.events.onSessionEnd(sessionId);
        return false;
      }

      setTimeout(() => {
        try {
          session.socket?.write(JSON.stringify({ type: 'input', text: '\r' }) + '\n');
        } catch {
          // Session likely already cleaned up from the first write failure
        }
      }, 50);

      return true;
    }

    console.error(`[SessionManager] Session ${sessionId} has no pty or socket`);
    return false;
  }

  getSession(sessionId: string): SessionInfo | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    return {
      id: session.id,
      name: session.name,
      cwd: session.cwd,
      projectDir: session.projectDir,
      status: session.status,
      startedAt: session.startedAt,
    };
  }

  /**
   * Get the Claude session UUID (from the JSONL filename) for a session.
   * Returns undefined if no JSONL file has been claimed yet.
   */
  getClaudeSessionId(sessionId: string): string | undefined {
    const session = this.sessions.get(sessionId);
    if (!session?.watchedFile) return undefined;
    // Extract UUID from path like /home/user/.claude/projects/-home-user/16eb1b09-...jsonl
    const filename = session.watchedFile.split('/').pop();
    if (!filename) return undefined;
    return filename.replace('.jsonl', '');
  }

  /**
   * Get context window usage from the last assistant message in the JSONL.
   * Returns null if no watched file or no usage data found.
   */
  async getContextUsage(sessionId: string): Promise<{ inputTokens: number; outputTokens: number; totalTokens: number; contextLimit: number } | null> {
    const session = this.sessions.get(sessionId);
    if (!session?.watchedFile) return null;

    try {
      const content = await readFile(session.watchedFile, 'utf-8');
      const lines = content.split('\n').filter(Boolean);

      // Iterate backwards to find the last assistant message with usage
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const data = JSON.parse(lines[i]);
          if (data.type === 'assistant' && data.message?.usage) {
            const u = data.message.usage;
            const inputTokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
            const outputTokens = u.output_tokens || 0;
            return {
              inputTokens,
              outputTokens,
              totalTokens: inputTokens,
              contextLimit: 200_000,
            };
          }
        } catch {
          continue;
        }
      }
    } catch {
      // File read error
    }

    return null;
  }

  /**
   * Poll the tmux pane for the workspace trust prompt and dismiss it
   * by sending Enter. Gives up after a few seconds if no prompt appears.
   */
  private dismissTrustPrompt(sessionId: string, tmuxSessionName: string): void {
    let attempts = 0;
    const maxAttempts = 15; // 15 × 500ms = 7.5s max wait
    const interval = setInterval(() => {
      attempts++;
      if (attempts > maxAttempts || !this.sessions.has(sessionId)) {
        clearInterval(interval);
        return;
      }

      try {
        const pane = execSync(`tmux capture-pane -p -t ${tmuxSessionName}`, { encoding: 'utf-8' });
        if (pane.includes('Yes, I trust this folder')) {
          console.log(`[SessionManager] Dismissing trust prompt for session ${sessionId}`);
          execSync(`tmux send-keys -t ${tmuxSessionName} Enter`, { stdio: 'ignore' });
          clearInterval(interval);
        }
      } catch {
        // tmux session may not be ready yet
      }
    }, 500);
  }

  /**
   * Wait until Claude is ready for input by polling the tmux pane.
   * Resolves when the prompt appears (or on timeout — best-effort).
   */
  async waitForReady(sessionId: string): Promise<void> {
    const maxAttempts = 30; // 30 × 500ms = 15s
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const pane = execSync(`tmux capture-pane -p -t afk-${sessionId}`, { encoding: 'utf-8' });
        if (pane.includes('❯') && !pane.includes('Yes, I trust this folder')) {
          return;
        }
      } catch {
        // tmux session may not be ready yet
      }
      await new Promise(r => setTimeout(r, 500));
    }
    // Timeout — resolve anyway (Claude will buffer input)
  }

  capturePane(sessionId: string): string {
    try {
      return execSync(`tmux capture-pane -p -t afk-${sessionId}`, { encoding: 'utf-8' });
    } catch (err) {
      throw new Error(`Failed to capture pane for session ${sessionId}`);
    }
  }

  getAllSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      projectDir: s.projectDir,
      status: s.status,
      startedAt: s.startedAt,
    }));
  }

  private async handleSessionMessage(socket: Socket, message: any): Promise<void> {
    switch (message.type) {
      case 'session_start': {
        // Validate shared secret
        if (!message.secret || message.secret !== this.sharedSecret) {
          socket.write(JSON.stringify({ type: 'error', message: 'Authentication failed: invalid secret' }) + '\n');
          return;
        }

        // Snapshot existing JSONL files before creating session
        const initialFileStats = await this.snapshotJsonlFiles(message.projectDir);

        const session: InternalSession = {
          id: message.id,
          name: message.name || message.command?.join(' ') || 'Session',
          cwd: message.cwd,
          projectDir: message.projectDir,
          socket,
          status: 'running',
          jsonlOffset: 0,
          resumed: false,
          startedAt: new Date(),
          slugFound: false,
          lastTodosHash: '',
          inPlanMode: false,
          initialFileStats,
        };

        this.sessions.set(message.id, session);
        console.log(`[SessionManager] Session started: ${message.id} - ${session.name}`);
        console.log(`[SessionManager] Snapshot: ${initialFileStats.size} existing JSONL files`);

        this.events.onSessionStart({
          id: session.id,
          name: session.name,
          cwd: session.cwd,
          projectDir: session.projectDir,
          status: session.status,
          startedAt: session.startedAt,
        });

        this.startWatching(session);
        break;
      }

      case 'session_end': {
        const session = this.sessions.get(message.sessionId);
        if (session) {
          console.log(`[SessionManager] Session ended: ${message.sessionId}`);
          this.stopWatching(session);
          this.sessions.delete(message.sessionId);
          this.events.onSessionEnd(message.sessionId);
        }
        break;
      }
    }
  }

  private async snapshotJsonlFiles(projectDir: string): Promise<Map<string, number>> {
    const stats = new Map<string, number>();
    try {
      const files = await readdir(projectDir);
      for (const f of files) {
        if (f.endsWith('.jsonl') && !f.startsWith('agent-')) {
          const path = `${projectDir}/${f}`;
          const fileStat = await stat(path);
          stats.set(path, fileStat.mtimeMs);
        }
      }
    } catch {
      // Directory might not exist yet
    }
    return stats;
  }

  private async hasConversationMessages(path: string): Promise<boolean> {
    try {
      const content = await readFile(path, 'utf-8');
      // Check if file contains actual conversation messages (not just metadata)
      return content.includes('"type":"user"') || content.includes('"type":"assistant"');
    } catch {
      return false;
    }
  }

  private async findActiveJsonlFile(session: InternalSession): Promise<string | null> {
    try {
      const files = await readdir(session.projectDir);
      const jsonlFiles = files.filter((f) => f.endsWith('.jsonl') && !f.startsWith('agent-'));

      const allPaths = jsonlFiles
        .map((f) => `${session.projectDir}/${f}`)
        .filter((path) => !this.claimedFiles.has(path));

      if (allPaths.length === 0) return null;

      // Get current file stats
      const fileStats = await Promise.all(
        allPaths.map(async (path) => {
          const fileStat = await stat(path);
          return { path, mtime: fileStat.mtimeMs };
        })
      );

      // Sort by mtime descending - prefer most recently modified
      fileStats.sort((a, b) => b.mtime - a.mtime);

      // Look for files that are either:
      // 1. Modified since our snapshot (for --continue case) - check first!
      // 2. New (didn't exist in our snapshot)
      // Only consider files with actual conversation messages
      for (const { path, mtime } of fileStats) {
        const initialMtime = session.initialFileStats.get(path);

        if (initialMtime !== undefined && mtime > initialMtime) {
          // Existing file that was modified after session start (--continue case)
          if (await this.hasConversationMessages(path)) {
            // Re-check claimedFiles after the async gap — another session may
            // have claimed this file while we were awaiting I/O above.
            if (this.claimedFiles.has(path)) continue;
            // Claim atomically before returning to prevent races
            this.claimedFiles.add(path);
            console.log(`[SessionManager] Session ${session.id}: claimed modified JSONL (--continue): ${path}`);
            return path;
          }
        }
      }

      // Then check new files
      for (const { path } of fileStats) {
        const initialMtime = session.initialFileStats.get(path);

        if (initialMtime === undefined) {
          // New file that didn't exist when session started
          if (await this.hasConversationMessages(path)) {
            // Re-check after async gap
            if (this.claimedFiles.has(path)) continue;
            // Claim atomically before returning to prevent races
            this.claimedFiles.add(path);
            console.log(`[SessionManager] Session ${session.id}: claimed new JSONL: ${path}`);
            return path;
          }
        }
      }

      // No valid conversation file found yet
      return null;
    } catch {
      return null;
    }
  }

  private async processJsonlUpdates(session: InternalSession): Promise<void> {
    if (!session.watchedFile) return;

    try {
      const content = await readFile(session.watchedFile, 'utf-8');

      // Skip content we've already processed
      if (content.length <= session.jsonlOffset) return;
      const newContent = content.slice(session.jsonlOffset);
      session.jsonlOffset = content.length;

      const lines = newContent.split('\n').filter(Boolean);

      for (const line of lines) {

        // Extract session name (slug)
        if (!session.slugFound) {
          const slug = this.extractSlug(line);
          if (slug) {
            session.slugFound = true;
            session.name = slug;
            console.log(`[SessionManager] Session ${session.id} name: ${slug}`);
            this.events.onSessionUpdate(session.id, slug);
          }
        }

        // Extract todos
        const todos = this.extractTodos(line);
        if (todos) {
          const todosHash = hash(JSON.stringify(todos));
          if (todosHash !== session.lastTodosHash) {
            session.lastTodosHash = todosHash;
            this.events.onTodos(session.id, todos);
          }
        }

        // Detect plan mode changes
        const planModeStatus = this.detectPlanMode(line);
        if (planModeStatus !== null && planModeStatus !== session.inPlanMode) {
          session.inPlanMode = planModeStatus;
          console.log(`[SessionManager] Session ${session.id} plan mode: ${planModeStatus}`);
          this.events.onPlanModeChange(session.id, planModeStatus);
        }

        // Extract tool calls from assistant messages
        const toolCalls = this.extractToolCalls(line);
        for (const tool of toolCalls) {
          this.events.onToolCall(session.id, tool);

          // Detect AskUserQuestion: render questions in chat, then send Escape
          // to dismiss the TUI form. Claude falls back to asking as plain text.
          if (tool.name === 'AskUserQuestion' && Array.isArray(tool.input?.questions)) {
            this.events.onAskUserQuestion(session.id, tool.input.questions);
            // Delay to ensure the TUI form is rendered before we dismiss it
            setTimeout(() => {
              this.sendInput(session.id, '\x1b', true);
            }, 500);
          }
        }

        // Extract tool results from user messages
        const toolResults = this.extractToolResults(line);
        for (const result of toolResults) {
          this.events.onToolResult(session.id, result);
        }

        // Parse and forward messages
        const parsed = this.parseJsonlLine(line);
        if (parsed) {
          this.events.onMessage(session.id, parsed.role, parsed.content);
        }
      }
    } catch (err) {
      console.error('[SessionManager] Error processing JSONL:', err);
    }
  }

  private async startWatching(session: InternalSession): Promise<void> {
    const jsonlFile = await this.findActiveJsonlFile(session);

    if (jsonlFile) {
      session.watchedFile = jsonlFile;
      console.log(`[SessionManager] Session ${session.id}: watching ${jsonlFile}`);

      if (session.resumed) {
        // For resumed sessions, skip existing content to avoid replaying history.
        // Extract the slug from the existing content first so the channel gets named.
        const existingContent = await readFile(jsonlFile, 'utf-8');
        session.jsonlOffset = existingContent.length;
        const slug = await this.extractSlugFromFile(jsonlFile);
        if (slug) {
          session.slugFound = true;
          session.name = slug;
          this.events.onSessionUpdate(session.id, slug);
        }
      } else {
        await this.processJsonlUpdates(session);
      }
    } else {
      console.log(`[SessionManager] Session ${session.id}: waiting for JSONL in ${session.projectDir}`);
    }

    // Watch directory for changes - create it if it doesn't exist yet
    // (Claude Code creates this directory lazily on first conversation activity)
    try {
      await mkdir(session.projectDir, { recursive: true });
      session.watcher = watch(session.projectDir, { recursive: false }, async (_, filename) => {
        if (!filename?.endsWith('.jsonl')) return;
        if (filename.startsWith('agent-')) return;

        if (!session.watchedFile) {
          // Re-check after the guard — another callback may have set it
          const newFile = await this.findActiveJsonlFile(session);
          if (newFile && !session.watchedFile) {
            session.watchedFile = newFile;
            console.log(`[SessionManager] Session ${session.id}: watching ${newFile}`);
          }
        }

        const filePath = `${session.projectDir}/${filename}`;
        if (session.watchedFile && filePath === session.watchedFile) {
          await this.processJsonlUpdates(session);
        }
      });
    } catch (err) {
      console.error('[SessionManager] Error setting up watcher:', err);
    }

    // Poll as backup
    const pollInterval = setInterval(async () => {
      if (!this.sessions.has(session.id)) {
        clearInterval(pollInterval);
        return;
      }

      if (!session.watchedFile) {
        const newFile = await this.findActiveJsonlFile(session);
        if (newFile && !session.watchedFile) {
          session.watchedFile = newFile;
          console.log(`[SessionManager] Session ${session.id}: watching ${newFile} (poll)`);
        }
      }

      if (session.watchedFile) {
        await this.processJsonlUpdates(session);

        // Check if Claude rotated to a new JSONL file (e.g. after compaction/interrupt).
        // Look for an unclaimed file with the same slug.
        if (session.slugFound) {
          const successor = await this.findSuccessorFile(session);
          if (successor) {
            console.log(`[SessionManager] Session ${session.id}: Claude rotated JSONL, switching to ${successor}`);
            session.previousWatchedFiles.add(session.watchedFile);
            this.claimedFiles.delete(session.watchedFile);
            session.watchedFile = successor;
            session.jsonlOffset = 0;
            await this.processJsonlUpdates(session);
          }
        }
      }
    }, 1000);
  }

  private async extractSlugFromFile(path: string): Promise<string | null> {
    try {
      const content = await readFile(path, 'utf-8');
      for (const line of content.split('\n')) {
        if (!line) continue;
        try {
          const data = JSON.parse(line);
          if (data.slug && typeof data.slug === 'string') {
            return data.slug;
          }
        } catch {
          continue;
        }
      }
    } catch {}
    return null;
  }

  /**
   * Look for a newer unclaimed JSONL file in the same project dir that has
   * the same slug as the current watched file. This handles the case where
   * Claude Code rotates to a new JSONL mid-session (compaction, interrupt).
   */
  private async findSuccessorFile(session: InternalSession): Promise<string | null> {
    if (!session.watchedFile) return null;

    try {
      const files = await readdir(session.projectDir);
      const candidates = files
        .filter((f) => f.endsWith('.jsonl') && !f.startsWith('agent-'))
        .map((f) => `${session.projectDir}/${f}`)
        .filter((path) => path !== session.watchedFile && !this.claimedFiles.has(path) && !session.previousWatchedFiles.has(path));

      for (const path of candidates) {
        const slug = await this.extractSlugFromFile(path);
        if (slug && slug === session.name) {
          this.claimedFiles.add(path);
          return path;
        }
      }
    } catch {}

    return null;
  }

  private stopWatching(session: InternalSession): void {
    if (session.watcher) {
      session.watcher.close();
    }
    if (session.watchedFile) {
      this.claimedFiles.delete(session.watchedFile);
    }
  }

  private detectPlanMode(line: string): boolean | null {
    try {
      const data = JSON.parse(line);
      if (data.type !== 'user') return null;

      const content = data.message?.content;
      if (typeof content !== 'string') return null;

      // Check for plan mode activation
      if (content.includes('<system-reminder>') && content.includes('Plan mode is active')) {
        return true;
      }

      // Check for plan mode exit (ExitPlanMode was called)
      if (content.includes('Exited Plan Mode') || content.includes('exited plan mode')) {
        return false;
      }

      return null;
    } catch {
      return null;
    }
  }

  private extractToolCalls(line: string): ToolCallInfo[] {
    try {
      const data = JSON.parse(line);
      if (data.type !== 'assistant') return [];

      const content = data.message?.content;
      if (!Array.isArray(content)) return [];

      const tools: ToolCallInfo[] = [];
      for (const block of content) {
        if (block.type === 'tool_use' && block.id && block.name) {
          tools.push({
            id: block.id,
            name: block.name,
            input: block.input || {},
          });
        }
      }
      return tools;
    } catch {
      return [];
    }
  }

  private extractToolResults(line: string): ToolResultInfo[] {
    try {
      const data = JSON.parse(line);
      if (data.type !== 'user') return [];

      const content = data.message?.content;
      if (!Array.isArray(content)) return [];

      const results: ToolResultInfo[] = [];
      for (const block of content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          // Content can be string or array of text blocks
          let text = '';
          if (typeof block.content === 'string') {
            text = block.content;
          } else if (Array.isArray(block.content)) {
            text = block.content
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.text)
              .join('\n');
          }

          results.push({
            toolUseId: block.tool_use_id,
            content: text,
            isError: block.is_error === true,
          });
        }
      }
      return results;
    } catch {
      return [];
    }
  }

  private extractSlug(line: string): string | null {
    try {
      const data = JSON.parse(line);
      if (data.slug && typeof data.slug === 'string') {
        return data.slug;
      }
      return null;
    } catch {
      return null;
    }
  }

  private extractTodos(line: string): TodoItem[] | null {
    try {
      const data = JSON.parse(line);
      if (data.todos && Array.isArray(data.todos) && data.todos.length > 0) {
        return data.todos.map((t: any) => ({
          content: t.content || '',
          status: t.status || 'pending',
          activeForm: t.activeForm,
        }));
      }
      return null;
    } catch {
      return null;
    }
  }

  private parseJsonlLine(line: string): ChatMessage | null {
    try {
      const data = JSON.parse(line);

      if (data.type !== 'user' && data.type !== 'assistant') return null;
      if (data.isMeta || data.subtype) return null;

      const message = data.message;
      if (!message || !message.role) return null;

      let content = '';
      if (typeof message.content === 'string') {
        content = message.content;
      } else if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === 'text' && block.text) {
            content += block.text;
          }
        }
      }

      if (!content.trim()) return null;

      return {
        role: message.role as 'user' | 'assistant',
        content: content.trim(),
        timestamp: data.timestamp || new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }
}
