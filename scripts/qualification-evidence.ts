// Pinned beta source: packages/core/src/session/runner/publish-llm-event.ts
// at 106629aa118086be7def6123241a9bf056ba77b6. Tool.Success.executed is
// tool.providerExecuted, NOT a generic "the tool ran" flag. Native local
// toolExecution publishes success with executed:false after obtaining content.
export function isOpenCodeLocalToolSuccess(data: unknown): boolean {
  if (data === null || typeof data !== "object" || Array.isArray(data))
    return false;
  const event = data as Record<string, unknown>;
  return (
    event.nativeType === "session.tool.success" &&
    event.executed === false &&
    typeof event.id === "string" &&
    event.id.length > 0
  );
}
