import { statfs } from 'node:fs/promises';
import { RepairError } from './model.ts';

// Three retained phases, each with up to 512 MiB of files and a snapshot,
// plus 1 GiB for archives, build output and host headroom. This is a preflight,
// not a filesystem quota or a guarantee against concurrent external writers.
export const REPAIR_MIN_FREE_BYTES = 4n * 1024n ** 3n;

export async function assertRepairDiskCapacity(paths: readonly string[], requiredBytes = REPAIR_MIN_FREE_BYTES): Promise<void> {
  if (!paths.length || requiredBytes <= 0n) throw new RepairError('REPAIR_DISK_CAPACITY_UNKNOWN');
  for (const path of new Set(paths)) {
    let available: bigint;
    try {
      const usage = await statfs(path, { bigint: true });
      if (typeof usage.bavail !== 'bigint' || typeof usage.bsize !== 'bigint' || usage.bavail < 0n || usage.bsize <= 0n) throw new Error('Invalid capacity');
      available = usage.bavail * usage.bsize;
    } catch {
      throw new RepairError('REPAIR_DISK_CAPACITY_UNKNOWN');
    }
    if (available < requiredBytes) throw new RepairError('REPAIR_DISK_CAPACITY_INSUFFICIENT');
  }
}
