/**
 * Verification Terminal invocation (v2.0).
 *
 * A run is typed into an interactive shell terminal owned by the workspace:
 * the service creates the shell (this module says which one), writes ONE line
 * containing the structured executable + argv, and sends Enter. The line is
 * built by quoting every token for that shell, so no argument can become shell
 * syntax:
 *
 * - POSIX: every token is wrapped in single quotes with `'` written as `'\''`.
 *   Inside single quotes a POSIX shell performs no expansion at all, so `$`,
 *   backticks, `;`, `|`, globs, and spaces stay part of one literal argv entry.
 * - PowerShell: every token is wrapped in single quotes with `'` written as
 *   `''`, and the line starts with the call operator `&`, so an executable path
 *   is invoked with the literal arguments that follow it.
 *
 * The shell echoes the line and stays open after the command finishes, so the
 * user can read the output and close the terminal. Nothing here prints a
 * marker, reads an exit code, or claims the command succeeded.
 */
import type { VerificationCommand } from "../../shared/review";

/** The interactive shell terminal one run types its command into. */
export type VerificationShell = {
  /** Program the terminal spawns: an interactive shell, never the verified command. */
  command: string;
  args: string[];
  /** Which quoting dialect `formatVerificationInvocation` uses for this shell. */
  family: "posix" | "powershell";
};

/**
 * The shell a verification terminal runs on the given platform. Both shells
 * are interactive: they keep running after the command finishes, so the
 * terminal stays available for inspection until the user closes it.
 */
export function verificationShell(platform: NodeJS.Platform): VerificationShell {
  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: ["-NoLogo", "-NoProfile"],
      family: "powershell",
    };
  }
  return { command: "/bin/sh", args: ["-i"], family: "posix" };
}

/**
 * One token as a POSIX shell word. Single quotes make the shell treat the
 * token literally; the only escape needed is the single quote itself, which is
 * written as `'\''` (close quote, escaped quote, reopen quote).
 */
export function quotePosixToken(token: string): string {
  return `'${token.replaceAll("'", "'\\''")}'`;
}

/**
 * One token as a PowerShell single-quoted string: literal except that an
 * embedded single quote doubles. `& 'program' 'arg'` then invokes the program
 * with exactly those arguments.
 */
export function quotePowerShellToken(token: string): string {
  return `'${token.replaceAll("'", "''")}'`;
}

/** The exact line typed into a POSIX shell for one structured command. */
export function formatPosixInvocation(command: VerificationCommand): string {
  return [command.executable, ...command.args].map(quotePosixToken).join(" ");
}

/** The exact line typed into a PowerShell terminal for one structured command. */
export function formatPowerShellInvocation(command: VerificationCommand): string {
  return `& ${[command.executable, ...command.args].map(quotePowerShellToken).join(" ")}`;
}

/** The exact line typed into the shell terminal for this platform. */
export function formatVerificationInvocation(
  command: VerificationCommand,
  platform: NodeJS.Platform,
): string {
  return verificationShell(platform).family === "powershell"
    ? formatPowerShellInvocation(command)
    : formatPosixInvocation(command);
}
