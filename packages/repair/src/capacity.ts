import { lstat, realpath, statfs } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { RepairError } from './model.ts';

// Three retained phases, each with up to 512 MiB of files and a snapshot,
// plus 1 GiB for archives, build output and host headroom. This is a preflight,
// not a filesystem quota or a guarantee against concurrent external writers.
export const REPAIR_MIN_FREE_BYTES = 4n * 1024n ** 3n;

/** For a not-yet-created destination only; existing paths retain strict probes. */
export async function assertRepairDestinationCapacity(destination: string, requiredBytes: bigint): Promise<void> {
  if (resolve(destination) !== destination) throw new RepairError('REPAIR_DISK_CAPACITY_UNKNOWN');
  let ancestor = destination;
  for (;;) {
    try {
      const entry = await lstat(ancestor);
      if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(ancestor) !== ancestor) throw new Error('Invalid destination');
      break;
    } catch (error) {
      // Only absent directories permit walking upward. Permission, I/O and
      // non-directory failures must not select a different filesystem.
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT' || dirname(ancestor) === ancestor) {
        throw new RepairError('REPAIR_DISK_CAPACITY_UNKNOWN');
      }
      ancestor = dirname(ancestor);
    }
  }
  await assertRepairDiskCapacity([ancestor], requiredBytes);
}

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
