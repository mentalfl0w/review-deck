import type { PluginWorkspacePanelProps } from "@getpaseo/plugin";
import type { ProjectReviewComment, ReviewScope, ReviewSnapshot } from "../review.shared";
import type { StringKey } from "./i18n.client";

export type SelectedHunk = ReviewSnapshot["files"][number]["hunks"][number];
export type Severity = SelectedHunk["findings"][number]["severity"];
export type AgentInfo = {
  id: string;
  provider?: string;
  model?: string | null;
  title?: string | null;
};
export type AgentFeedbackState = {
  phase: "idle" | "sending" | "sent" | "error";
  message?: string;
};
export type AgentEntry = {
  id: string;
  workspaceId: string | null;
  cwd?: string;
  status?: string;
  provider?: string;
  model?: string | null;
  title?: string | null;
};
export type WorkspaceEntry = {
  id: string;
  name: string;
  workspaceDirectory?: string;
  workspaceKind: string;
  status: string;
  projectDisplayName: string;
  projectId?: string;
  projectRootPath?: string;
};
/** Stable project grouping key: prefer the workspace's projectId, fall back to its display name. */
export function projectKeyOf(entry: WorkspaceEntry): string {
  return entry.projectId ?? entry.projectDisplayName;
}
export type ReviewDecision = {
  hunkId: string;
  decision: "reviewed" | "commented";
  comment?: string;
  savedAt: string;
};
export type SavedReviewSummary = {
  targetFingerprint: string;
  cwd?: string;
  scope?: ReviewScope;
  decisionCount: number;
  commentCount: number;
  lastSavedAt: string;
};
export type FileCommentDraft = {
  body: string;
  anchorHunkId: string;
  originalHunkId: string | null;
  dirty: boolean;
};
export type PanelTheme = PluginWorkspacePanelProps["theme"];
export type PanelLayout = PluginWorkspacePanelProps["layout"];
export type DiffMode = "split" | "unified";

export const scopeKeys: Array<{ value: ReviewScope; key: StringKey }> = [
  { value: "working", key: "scopeWorking" },
  { value: "staged", key: "scopeStaged" },
  { value: "branch", key: "scopeBranch" },
  { value: "commits", key: "scopeCommits" },
];
export const scopeDescKeys: Record<ReviewScope, StringKey> = {
  working: "scopeWorkingDesc",
  staged: "scopeStagedDesc",
  branch: "scopeBranchDesc",
  commits: "scopeCommitsDesc",
};
export const scopeLabelKeys: Record<ReviewScope, StringKey> = {
  working: "scopeWorking",
  staged: "scopeStaged",
  branch: "scopeBranch",
  commits: "scopeCommits",
};

export const diffModeKeys: Array<{ value: DiffMode; key: StringKey }> = [
  { value: "split", key: "diffModeSplit" },
  { value: "unified", key: "diffModeUnified" },
];

export const severityLabelKeys: Record<Severity, StringKey> = {
  critical: "severityCritical",
  high: "severityHigh",
  medium: "severityMedium",
  low: "severityLow",
  informational: "severityInformational",
};

export const statusLabelKeys: Record<string, StringKey> = {
  idle: "statusIdle",
  running: "statusRunning",
  failed: "statusFailed",
  archiving: "statusArchiving",
};

export const severityOrder: Severity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "informational",
];

export function severityColor(severity: Severity, theme: PanelTheme): string {
  if (severity === "critical" || severity === "high") return theme.colors.statusDanger;
  if (severity === "medium") return theme.colors.accent;
  return theme.colors.foregroundMuted;
}

export function maxSeverity(hunk: SelectedHunk): Severity {
  return severityOrder.find((severity) => hunk.findings.some((finding) => finding.severity === severity)) ?? "informational";
}

/** Convert a #rrggbb / #rgb theme color into an rgba() string with the given alpha. */
export function withAlpha(hex: string, alpha: number): string {
  const match = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!match) return hex;
  const short = match[1];
  const full = short.length === 3 ? short.split("").map((char) => char + char).join("") : short;
  const red = parseInt(full.slice(0, 2), 16);
  const green = parseInt(full.slice(2, 4), 16);
  const blue = parseInt(full.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

export type ReviewFile = ReviewSnapshot["files"][number];
export type Finding = SelectedHunk["findings"][number];
export type ProjectIdentity = { projectId: string; displayName: string; rootPath?: string };
export type FileCommentEntry = { hunk: SelectedHunk; decision: ReviewDecision };
export type AgentFeedbackMap = Record<string, AgentFeedbackState>;
export type CommentDraftsMap = Record<string, FileCommentDraft>;
export type ProjectCommentsByTarget = Array<{
  cwd: string;
  scope: ReviewScope;
  targetFingerprint: string;
  files: Array<{ filePath: string; comments: ProjectReviewComment[] }>;
}>;
export type ViewMode = "diff" | "blockFile" | "fullChanges";

export const viewModeKeys: Array<{ value: ViewMode; key: StringKey }> = [
  { value: "diff", key: "diffViewMode" },
  { value: "blockFile", key: "blockFileViewMode" },
  { value: "fullChanges", key: "fullChangesViewMode" },
];

export type FileViewRow = { kind: "context" | "add" | "del"; text: string; hunkId: string | null; oldLine?: number | null; newLine?: number | null };

export type FileViewResult = { binary: boolean; truncated: boolean; rows: FileViewRow[] };
