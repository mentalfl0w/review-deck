/**
 * Verification run lifecycle (v2.0).
 *
 * The state machine is pure and never a verdict: given what a poll could
 * observe about the run's workspace terminal, it returns the end state. A
 * terminal that is gone is `closed`; a workspace that cannot be observed is
 * `unavailable`; a run whose workspace binding moved is `error`. Captured
 * output never changes a state — it is only ever copied into a bounded
 * transient tail.
 */
import {
  VERIFICATION_OUTPUT_TAIL_MAX_CHARACTERS,
  VERIFICATION_OUTPUT_TAIL_LINE_MAX_LENGTH,
  VERIFICATION_OUTPUT_TAIL_MAX_LINES,
  type ReviewLocale,
  type VerificationFailure,
  type VerificationFailureCode,
} from "../../shared/review";

/** Terminal runs are kept this long (in the run store) unless pruned sooner. */
export const VERIFICATION_RUN_TTL_MS = 24 * 60 * 60_000;

/** A run that is no longer `open`, plus the reason its status stopped being open. */
export type VerificationRunCompletion =
  | { status: "closed"; failureCode: "terminal_closed" }
  | { status: "unavailable"; failureCode: "terminal_unavailable" }
  | { status: "error"; failureCode: "invalid_binding" };

/**
 * What one poll observed about the run's workspace terminal:
 *
 * - `terminal` — the terminal was listed; `lines` is its captured tail, or null
 *   when the capture failed (the terminal still exists either way).
 * - `missing` — the listing succeeded and the terminal is not in it.
 * - `unobservable` — the workspace or its terminal list could not be read, so
 *   existence is unknown.
 * - `invalid_binding` — the workspace no longer resolves to the run's project
 *   and directory.
 */
export type VerificationRunObservation =
  | { kind: "terminal"; lines: readonly string[] | null }
  | { kind: "missing" }
  | { kind: "unobservable" }
  | { kind: "invalid_binding" };

/**
 * The end state of a run whose terminal was not observed (missing, or its
 * workspace unreadable/rebound). Captured output never participates: it cannot
 * turn a missing terminal into a success or a present terminal into a failure.
 */
export function verificationRunCompletion(
  observation: Exclude<VerificationRunObservation, { kind: "terminal" }>,
): VerificationRunCompletion {
  switch (observation.kind) {
    case "missing":
      return { status: "closed", failureCode: "terminal_closed" };
    case "unobservable":
      return { status: "unavailable", failureCode: "terminal_unavailable" };
    case "invalid_binding":
      return { status: "error", failureCode: "invalid_binding" };
  }
}

/**
 * The bounded, transient copy of a terminal tail that one RPC response may
 * carry: at most `VERIFICATION_OUTPUT_TAIL_MAX_LINES` lines, each truncated to
 * `VERIFICATION_OUTPUT_TAIL_LINE_MAX_LENGTH` characters, and at most
 * `VERIFICATION_OUTPUT_TAIL_MAX_CHARACTERS` characters in total (the newest
 * lines win). Nothing here is stored.
 */
export function boundedVerificationOutputTail(lines: readonly string[]): string[] {
  const truncated = lines
    .slice(-VERIFICATION_OUTPUT_TAIL_MAX_LINES)
    .map((line) =>
      line.length > VERIFICATION_OUTPUT_TAIL_LINE_MAX_LENGTH
        ? `${line.slice(0, VERIFICATION_OUTPUT_TAIL_LINE_MAX_LENGTH - 1)}…`
        : line,
    );
  const kept: string[] = [];
  let characters = 0;
  for (let index = truncated.length - 1; index >= 0; index -= 1) {
    const line = truncated[index] ?? "";
    const cost = line.length + 1;
    if (kept.length > 0 && characters + cost > VERIFICATION_OUTPUT_TAIL_MAX_CHARACTERS) break;
    kept.unshift(line);
    characters += cost;
  }
  return kept;
}

/**
 * The localized, user-facing reason a run stopped being open. It never carries
 * terminal output and never states or implies whether the command succeeded —
 * Review Deck does not determine that in v2.0.
 */
export function verificationFailure(code: VerificationFailureCode, locale: ReviewLocale): VerificationFailure {
  if (locale === "zh") {
    switch (code) {
      case "terminal_closed":
        return {
          code,
          message: "验证终端已关闭。终端输出仅供查看，Review Deck 不会判断命令是否成功。",
        };
      case "terminal_unavailable":
        return {
          code,
          message: "无法确认验证终端是否仍存在（工作区暂时不可用）。Review Deck 不会判断命令是否成功。",
        };
      case "invalid_binding":
        return {
          code,
          message: "该验证运行已不再匹配当前工作区，请重新开始。",
        };
    }
  }
  switch (code) {
    case "terminal_closed":
      return {
        code,
        message: "The verification terminal is closed. Its output was shown for inspection; Review Deck does not determine whether the command succeeded.",
      };
    case "terminal_unavailable":
      return {
        code,
        message: "Whether the verification terminal still exists could not be determined (the workspace is unavailable). Review Deck does not determine whether the command succeeded.",
      };
    case "invalid_binding":
      return {
        code,
        message: "The verification run no longer matches this workspace; start it again.",
      };
  }
}
