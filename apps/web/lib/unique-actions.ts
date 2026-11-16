/** Protect the customer UI from repeated catalog actions (e.g. duplicate
 * create_lead entries in a published catalog). Preserve server order and
 * existing authorization behavior; this function never submits actions.
 */
export function uniqueActionsByKey<T extends { actionKey: string }>(actions: readonly T[]): T[] {
  const seen = new Set<string>();
  return actions.filter(action => {
    if (seen.has(action.actionKey)) return false;
    seen.add(action.actionKey);
    return true;
  });
}
