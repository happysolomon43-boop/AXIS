import { getUserId } from "../identity";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message = code,
    public readonly details: unknown = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type ErrorEnvelope = { error?: { code?: unknown; message?: unknown; details?: unknown } };

export async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const headers = { "X-Axis-User": getUserId() };
  const options: RequestInit = { method, headers };
  if (method === "POST" && body !== undefined) {
    options.headers = { ...headers, "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(`/api${path}`, options);
  } catch (error) {
    throw new ApiError(0, "network", error instanceof Error ? error.message : String(error));
  }

  const { status } = response;
  if (response.ok) {
    try {
      return await response.json() as T;
    } catch {
      throw new ApiError(status, "unreadable");
    }
  }

  let envelope: ErrorEnvelope | null = null;
  try {
    envelope = await response.json() as ErrorEnvelope | null;
  } catch {
    throw new ApiError(status, "unreadable", "Unreadable error response");
  }
  const failure = envelope?.error;
  if (typeof failure?.code === "string" && typeof failure.message === "string") {
    throw new ApiError(status, failure.code, failure.message, failure.details ?? null);
  }
  throw new ApiError(status, "unreadable", "Unreadable error response");
}
