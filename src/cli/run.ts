import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';
import { readFile } from 'fs/promises';
import { createConnection, type Socket } from 'net';
import * as pty from 'node-pty';
import { sanitizePtyInput, isRawControlSequence } from '../utils/sanitize.js';

const AFK_CODE_DIR = join(homedir(), '.afk-code');
const DAEMON_SOCKET = join(AFK_CODE_DIR, 'daemon.sock');
const DAEMON_SECRET_PATH = join(AFK_CODE_DIR, 'daemon.secret');

// Get Claude's project directory for the current working directory
function getClaudeProjectDir(cwd: string): string {
  // Claude encodes paths by replacing / with -
  const encodedPath = cwd.replace(/\//g, '-');
  return `${homedir()}/.claude/projects/${encodedPath}`;
}

// Read the shared secret for daemon authentication
async function readDaemonSecret(): Promise<string | null> {
  try {
    const secret = await readFile(DAEMON_SECRET_PATH, 'utf-8');
    return secret.trim();
  } catch {
    return null;
  }
}

// Connect to daemon and maintain bidirectional communication
function connectToDaemon(
  sessionId: string,
  projectDir: string,
  cwd: string,
  command: string[],
  secret: string,
  onInput: (text: string) => void
): Promise<{ close: () => void } | null> {
  return new Promise((resolve) => {
    const socket = createConnection(DAEMON_SOCKET);
    let messageBuffer = '';

    socket.on('connect', () => {
      // Tell daemon about this session (include secret for authentication)
      socket.write(JSON.stringify({
        type: 'session_start',
        id: sessionId,
        projectDir,
        cwd,
        command,
        name: command.join(' '),
        secret,
      }) + '\n');

      resolve({
        close: () => {
          socket.write(JSON.stringify({ type: 'session_end', sessionId }) + '\n');
          socket.end();
        },
      });
    });

    socket.on('data', (data) => {
      messageBuffer += data.toString();

      const lines = messageBuffer.split('\n');
      messageBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'input' && msg.text) {
            // Defense-in-depth: sanitize input before writing to PTY,
            // unless it's a raw control sequence (escape sequences, single control chars)
            const text = isRawControlSequence(msg.text) ? msg.text : sanitizePtyInput(msg.text);
            onInput(text);
          }
        } catch {}
      }
    });

    socket.on('error', (error) => {
      // Daemon not running - that's okay, run without it
      resolve(null);
    });
  });
}

export async function run(command: string[]): Promise<void> {
  const sessionId = randomUUID().slice(0, 8);
  const cwd = process.cwd();
  const projectDir = getClaudeProjectDir(cwd);

  // Show loading spinner while starting
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIndex = 0;
  let spinnerInterval: ReturnType<typeof setInterval> | null = setInterval(() => {
    process.stdout.write(`\r${spinnerFrames[spinnerIndex]} Starting...`);
    spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
  }, 80);

  const stopSpinner = () => {
    if (spinnerInterval) {
      clearInterval(spinnerInterval);
      spinnerInterval = null;
      // Clear the spinner line
      process.stdout.write('\r\x1b[K');
    }
  };

  // Use node-pty for full terminal features + remote input
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  const ptyProcess = pty.spawn(command[0], command.slice(1), {
    name: process.env.TERM || 'xterm-256color',
    cols,
    rows,
    cwd,
    env: process.env as Record<string, string>,
  });

  // Read daemon secret for authentication
  const secret = await readDaemonSecret();

  const daemon = secret ? await connectToDaemon(
    sessionId,
    projectDir,
    cwd,
    command,
    secret,
    (text) => {
      ptyProcess.write(text);
    }
  ) : null;

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  ptyProcess.onData((data: string) => {
    stopSpinner();
    process.stdout.write(data);
  });

  const onStdinData = (data: Buffer) => {
    ptyProcess.write(data.toString());
  };
  process.stdin.on('data', onStdinData);

  process.stdout.on('resize', () => {
    ptyProcess.resize(process.stdout.columns || 80, process.stdout.rows || 24);
  });

  await new Promise<void>((resolve) => {
    ptyProcess.onExit(() => {
      // Clean up stdin
      process.stdin.removeListener('data', onStdinData);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      if (typeof process.stdin.unref === 'function') {
        process.stdin.unref();
      }

      daemon?.close();
      resolve();
    });
  });
}
