import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';

/** Repair-only recovery, never approval or provider-operation redispatch. */
export function isUnexecutedRuntimeFailure(
  turn: TrueForgeApi.Turn,
  events: TrueForgeApi.SessionEvent[],
): boolean {
  if (turn.state.status !== 'error') return false;
  let completed = false;
  for (const event of events) {
    if (event.type === 'turn.done') {
      if (event.state.status !== 'error') return false;
      completed = true;
    } else if (event.type === 'model.message') {
      if (event.toolCalls?.length) return false;
    } else if (event.type !== 'turn.created') return false;
  }
  return completed;
}
