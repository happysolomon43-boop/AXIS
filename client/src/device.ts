const key = "axis.lastSeriesId";

export function getLastSeriesId(): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function setLastSeriesId(id: string): void {
  try {
    localStorage.setItem(key, id);
  } catch {
    // Opening a Book also works when the browser disallows storage.
  }
}
