type FailureEvent = "request_failed" | "database_pool_failed" | "database_rollback_failed" |
  "startup_failed" | "shutdown_failed" | "migration_failed";

export function failureFields(event: FailureEvent, error: unknown) {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  // Check the PostgreSQL error shape before treating its code as SQLSTATE.
  const sqlstate = typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) && error instanceof Error && "severity" in error
    ? code : undefined;
  return { event, error_class: sqlstate ? "postgres" : "unexpected", ...(sqlstate ? { sqlstate } : {}) };
}

export function reportFailure(event: FailureEvent, error: unknown): void {
  console.error(JSON.stringify(failureFields(event, error)));
}
