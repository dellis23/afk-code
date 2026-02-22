import { homedir } from 'os';

/**
 * Get Claude's project directory for a given working directory.
 * Claude encodes paths by replacing / with -
 */
export function getClaudeProjectDir(cwd: string): string {
  const encodedPath = cwd.replace(/\//g, '-');
  return `${homedir()}/.claude/projects/${encodedPath}`;
}
