export class ConfigError extends Error {}

export function getUserId(): string {
  const id = import.meta.env.VITE_AXIS_USER;
  if (typeof id !== "string" || !/^usr_[a-z0-9]{2,32}$/.test(id)) {
    throw new ConfigError("VITE_AXIS_USER must match ^usr_[a-z0-9]{2,32}$");
  }
  return id;
}
