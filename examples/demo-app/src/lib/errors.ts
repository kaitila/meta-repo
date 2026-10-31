// Errors that are safe to show. A SafeError's message goes to the client as is; any
// other error is reported as "internal error", and only its class name is logged, so a
// connection string or a row from a failed query never reaches a response or a log.

export class SafeError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "SafeError";
  }
}

/** What may be shown about an error: its message if safe, a fixed text otherwise. */
export function publicMessage(e: unknown): { message: string; status: number } {
  if (e instanceof SafeError) return { message: e.message, status: e.status };
  return { message: "internal error", status: 500 };
}

/** A one-line description for logs that never includes an unknown error's text. */
export function logLine(e: unknown): string {
  if (e instanceof SafeError) return `${e.status} ${e.message}`;
  return `unexpected ${e instanceof Error ? e.name : typeof e}`;
}
