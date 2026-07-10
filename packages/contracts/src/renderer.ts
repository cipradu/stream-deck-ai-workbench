import type { DisplayState } from "./display-states.js";
import type { SeverityState } from "./severity.js";

/**
 * Renderer input: presentation-only display model handed to key renderers.
 * Carries no SDK types, no raw values needing further policy decisions, and
 * no sensitive identifiers.
 */
export interface RendererInput {
  /** Preformatted center value text. */
  readonly valueText: string;
  /** Drives text/percentage/progress color consistently; `not-evaluated` keeps the green base color. */
  readonly severity: SeverityState;
  readonly displayState: DisplayState;
  /** Staleness marker, independent of severity: retained values must be visibly stale. */
  readonly stale: boolean;
  /**
   * Progress bar fill basis (0..100). Omitted when no safe denominator
   * exists — the renderer must not fabricate a bar. For Usage this is always
   * percent used, even when the center text shows remaining.
   */
  readonly progressPercent?: number;
}
