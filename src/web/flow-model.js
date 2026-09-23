/* Classic script: no module fetch (the HTTP guard rejects any Origin header).
 * Pure page-local projection, not a workflow graph or dependency engine.
 */
/** @param {import('../inspection.js').Inspection} snapshot */
// Called by ui.js after this classic script loads.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function executionMap(snapshot) {
  const actions = new Map(snapshot.actions.map((a) => [a.id, a]));
  const ids = new Set([
    ...actions.keys(),
    ...snapshot.invocations.map((i) => i.action),
  ]);
  const cards = [...ids].map((id) => {
    const invocations = snapshot.invocations
      .filter((i) => i.action === id)
      .sort((a, b) => a.turn - b.turn || a.id.localeCompare(b.id));
    let knownUsd = null;
    let unresolved = 0;
    for (const invocation of invocations) {
      /** @type {import('../types.js').Accounting | null} */
      let accounting = null;
      try {
        accounting = JSON.parse(invocation.accounting ?? "null");
      } catch {
        /* Untrusted retained JSON. */
      }
      const amounts = [
        accounting?.usd,
        ...(accounting?.additional ?? []).map((c) => c.usd),
      ];
      for (const amount of amounts) {
        if (typeof amount === "number" && Number.isFinite(amount))
          knownUsd = (knownUsd ?? 0) + amount;
      }
      if (
        !accounting ||
        accounting.status !== "complete" ||
        amounts.some((a) => a == null)
      )
        unresolved++;
    }
    const slash = id.lastIndexOf("/");
    return {
      id,
      scope: slash < 0 ? null : id.slice(0, slash),
      label: slash < 0 ? id : id.slice(slash + 1),
      action: actions.get(id),
      invocations,
      kinds: [...new Set(invocations.map((i) => i.kind))],
      knownUsd,
      unresolved,
    };
  });
  /** @type {Map<string | null, typeof cards>} */
  const lanes = new Map();
  for (const card of cards) {
    if (!lanes.has(card.scope)) lanes.set(card.scope, []);
    lanes.get(card.scope)?.push(card);
  }
  /** @type {Map<string, import('../inspection.js').Inspection['invocations']>} */
  const sessions = new Map();
  for (const invocation of snapshot.invocations) {
    if (invocation.session === null) continue;
    if (!sessions.has(invocation.session)) sessions.set(invocation.session, []);
    sessions.get(invocation.session)?.push(invocation);
  }
  return { cards, lanes, sessions };
}
