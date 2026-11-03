import type { NenErrorCode, NenErrorShape } from "./types.js";

export class NenError extends Error implements NenErrorShape {
  readonly code: NenErrorCode;
  readonly next_action: NenErrorShape["next_action"];
  readonly retry_after_s?: number;
  readonly fallback_listing_id?: string;
  readonly details?: Record<string, unknown>;

  constructor(shape: NenErrorShape) {
    super(shape.message);
    this.name = "NenError";
    this.code = shape.code;
    this.next_action = shape.next_action;
    this.retry_after_s = shape.retry_after_s;
    this.fallback_listing_id = shape.fallback_listing_id;
    this.details = shape.details;
  }

  toJSON(): NenErrorShape {
    return {
      code: this.code,
      message: this.message,
      next_action: this.next_action,
      ...(this.retry_after_s !== undefined && { retry_after_s: this.retry_after_s }),
      ...(this.fallback_listing_id !== undefined && { fallback_listing_id: this.fallback_listing_id }),
      ...(this.details !== undefined && { details: this.details }),
    };
  }
}

export function toErrorShape(err: unknown): NenErrorShape {
  if (err instanceof NenError) return err.toJSON();
  const message = err instanceof Error ? err.message : String(err);
  return { code: "provider_error", message, next_action: "use_fallback" };
}
