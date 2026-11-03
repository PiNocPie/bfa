import type { BfaErrorCode, BfaErrorShape } from "./types.js";

export class BfaError extends Error implements BfaErrorShape {
  readonly code: BfaErrorCode;
  readonly next_action: BfaErrorShape["next_action"];
  readonly retry_after_s?: number;
  readonly resets_at?: string;
  readonly fallback_listing_id?: string;
  readonly details?: Record<string, unknown>;

  constructor(shape: BfaErrorShape) {
    super(shape.message);
    this.name = "BfaError";
    this.code = shape.code;
    this.next_action = shape.next_action;
    this.retry_after_s = shape.retry_after_s;
    this.resets_at = shape.resets_at;
    this.fallback_listing_id = shape.fallback_listing_id;
    this.details = shape.details;
  }

  toJSON(): BfaErrorShape {
    return {
      code: this.code,
      message: this.message,
      next_action: this.next_action,
      ...(this.retry_after_s !== undefined && { retry_after_s: this.retry_after_s }),
      ...(this.resets_at !== undefined && { resets_at: this.resets_at }),
      ...(this.fallback_listing_id !== undefined && { fallback_listing_id: this.fallback_listing_id }),
      ...(this.details !== undefined && { details: this.details }),
    };
  }
}

export function toErrorShape(err: unknown): BfaErrorShape {
  if (err instanceof BfaError) return err.toJSON();
  const message = err instanceof Error ? err.message : String(err);
  return { code: "provider_error", message, next_action: "use_fallback" };
}
