import { describe, it, expect } from 'vitest';
import { buildClaudeArgs, engineEnvOverrides } from '../src/cli/CliProcessManager';

const base = { claudePath: 'claude', cwd: '/p' };
const args = (autoCompact?: string): string[] => buildClaudeArgs({ ...base, autoCompact }, () => undefined);

describe('per-conversation auto-compact', () => {
  it('passes a token window as --autocompact', () => {
    const a = args('200000');
    expect(a[a.indexOf('--autocompact') + 1]).toBe('200000');
  });

  it('adds nothing for auto (the CLI decides) or when unset', () => {
    expect(args('auto')).not.toContain('--autocompact');
    expect(args(undefined)).not.toContain('--autocompact');
  });

  it('never turns text into a flag value', () => {
    expect(args('200000; rm -rf')).not.toContain('--autocompact');
  });

  it('turns auto-compact off through the environment, not a flag', () => {
    expect(args('off')).not.toContain('--autocompact');
    expect(engineEnvOverrides({ ...base, autoCompact: 'off' }).DISABLE_AUTO_COMPACT).toBe('1');
    expect(engineEnvOverrides({ ...base, autoCompact: '200000' }).DISABLE_AUTO_COMPACT).toBeUndefined();
  });
});
