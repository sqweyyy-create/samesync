import { describe, expect, it } from 'vitest';
import { memoryLogger } from '../support/fixtures';

describe('logger redaction', () => {
  it('replaces sensitive fields with [redacted]', () => {
    const { logger, lines } = memoryLogger();
    logger.info(
      {
        authorization: 'tma secret-init-data',
        headers: { authorization: 'tma secret-init-data' },
        initData: 'secret-init-data',
        botToken: 'secret-token',
        user: { username: 'secret_username', birthDate: '2010-01-01', text: 'secret message' },
        payload: 'secret-payload',
        userId: 'internal-id-is-fine',
      },
      'event',
    );
    const line = lines().join('\n');
    expect(line).not.toMatch(/secret/);
    expect(line).toContain('[redacted]');
    expect(line).toContain('internal-id-is-fine');
  });
});
