import { describe, expect, it } from 'vitest';
import { repairProfileFromEnvironment } from './repair-profile.ts';

describe('repair profile selection', () => {
  it('enables the bundled reference evaluator only for the unmodified target defaults', () => {
    expect(repairProfileFromEnvironment({})).toBe('reference_v1');
  });

  it.each(['TARGET_ID', 'TARGET_ORIGIN', 'PROJECT_REPOSITORY'])(
    'fails closed when %s overrides the target',
    (key) => {
      expect(repairProfileFromEnvironment({ [key]: 'custom' })).toBe('disabled');
    },
  );

  it('allows only an explicit recognized profile override', () => {
    expect(
      repairProfileFromEnvironment({
        TARGET_ORIGIN: 'http://127.0.0.1:3002',
        REPAIR_PROFILE: 'disabled',
      }),
    ).toBe('disabled');
    expect(() => repairProfileFromEnvironment({ REPAIR_PROFILE: 'custom' })).toThrow();
  });
});
