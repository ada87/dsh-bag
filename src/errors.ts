/** Engine-level failure with a stable machine code. */
export class SyncError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'SyncError'
  }
}

/** HTTP failure carrying a status and a machine code. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
