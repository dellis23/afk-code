import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, writeFile, rm, stat } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { readFileSync } from 'fs';

const TEST_DIR = join(tmpdir(), `afk-code-perms-test-${process.pid}`);

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe('file permissions for credential storage', () => {
  it('should create config directory with mode 0o700 (owner-only access)', async () => {
    await mkdir(TEST_DIR, { recursive: true, mode: 0o700 });

    const dirStat = await stat(TEST_DIR);
    const mode = dirStat.mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('should create config files with mode 0o600 (owner read/write only)', async () => {
    await mkdir(TEST_DIR, { recursive: true, mode: 0o700 });

    const testFile = join(TEST_DIR, 'test.env');
    await writeFile(testFile, 'SECRET_TOKEN=abc123\n', { mode: 0o600 });

    const fileStat = await stat(testFile);
    const mode = fileStat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('source files use restrictive permissions for mkdir calls', () => {
    const files = [
      join(__dirname, '..', 'discord.ts'),
      join(__dirname, '..', 'slack.ts'),
      join(__dirname, '..', 'telegram.ts'),
    ];

    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      expect(content).toContain('mode: 0o700');
      expect(content).not.toMatch(/mkdir\(CONFIG_DIR,\s*\{\s*recursive:\s*true\s*\}\)/);
    }
  });

  it('source files use restrictive permissions for writeFile calls', () => {
    const files = [
      { path: join(__dirname, '..', 'discord.ts'), configVar: 'DISCORD_CONFIG_FILE' },
      { path: join(__dirname, '..', 'slack.ts'), configVar: 'SLACK_CONFIG_FILE' },
      { path: join(__dirname, '..', 'telegram.ts'), configVar: 'TELEGRAM_CONFIG_FILE' },
    ];

    for (const { path: file } of files) {
      const content = readFileSync(file, 'utf-8');
      expect(content).toContain('mode: 0o600');
      expect(content).not.toMatch(/writeFile\([A-Z_]+,\s*envContent\s*\)/);
    }
  });
});
