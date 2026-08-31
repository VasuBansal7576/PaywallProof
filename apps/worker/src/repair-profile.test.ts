import { describe, expect, it } from 'vitest';
import { repairProfileFromEnvironment } from './repair-profile.ts';

describe('repair profile selection', () => {
  it('enables the bundled reference evaluator only for the unmodified target defaults', () => {
    expect(repairProfileFromEnvironment({})).toBe('reference_v1');
  });

  it.each([
    ['TARGET_ID', 'another-target'],
    ['TARGET_ORIGIN', 'http://127.0.0.1:3002'],
    ['PROJECT_REPOSITORY', 'owner/another-repository'],
  ])('does not let reference_v1 trust an overridden %s', (key, value) => {
    expect(
      repairProfileFromEnvironment({
        [key]: value,
        REPAIR_PROFILE: 'reference_v1',
      }),
    ).toBe('disabled');
  });

  it.each(['TARGET_ID', 'TARGET_ORIGIN', 'PROJECT_REPOSITORY'])(
    'treats an empty %s as an untrusted override',
    (key) => {
      expect(
        repairProfileFromEnvironment({
          [key]: '',
          REPAIR_PROFILE: 'reference_v1',
        }),
      ).toBe('disabled');
    },
  );

  it('accepts explicit environment values that exactly match the bundled target', () => {
    expect(
      repairProfileFromEnvironment({
        TARGET_ID: 'reference',
        TARGET_ORIGIN: 'http://127.0.0.1:3001',
        PROJECT_REPOSITORY: 'VasuBansal7576/PaywallProof',
        REPAIR_PROFILE: 'reference_v1',
      }),
    ).toBe('reference_v1');
  });

  it('preserves an explicit disabled profile', () => {
    expect(
      repairProfileFromEnvironment({
        TARGET_ORIGIN: 'http://127.0.0.1:3001',
        REPAIR_PROFILE: 'disabled',
      }),
    ).toBe('disabled');
  });

  it.each(['', 'custom'])('rejects an unknown explicit repair profile: %s', (profile) => {
    expect(() => repairProfileFromEnvironment({ REPAIR_PROFILE: profile })).toThrow();
  });
});
