import { homedir } from 'os';
import { realpathSync } from 'fs';

/**
 * Get Claude's project directory for a given working directory.
 * Claude encodes paths by replacing / with -
 * Resolves symlinks since Claude uses the real path.
 */
export function getClaudeProjectDir(cwd: string): string {
  let resolved = cwd;
  try {
    resolved = realpathSync(cwd);
  } catch {
    // If resolution fails, use the original path
  }
  const encodedPath = resolved.replace(/\//g, '-');
  return `${homedir()}/.claude/projects/${encodedPath}`;
}
