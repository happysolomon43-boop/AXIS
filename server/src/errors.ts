export type ErrorCode =
  | "auth_required"
  | "validation_failed"
  | "not_found"
  | "payload_too_large"
  | "unsupported_media_type"
  | "conflict"
  | "snapshot_conflict"
  | "not_in_book"
  | "internal";

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = "AppError";
  }
}
