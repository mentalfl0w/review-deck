import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { extname } from "node:path";
import type {
  canSubmitProjectReviewGroup as CanSubmitProjectReviewGroup,
  groupProjectReviewComments as GroupProjectReviewComments,
} from "../client/project-review-workspaces";
import type { AgentEntry } from "../client/tools";
import type { ProjectReviewComment } from "../shared/review";
import type { ActiveReviewBatch } from "../shared/review-batch";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && extname(specifier) === "") {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});
const requireFromRepo = createRequire(import.meta.url);
const loadedProjectWorkspaceModule = requireFromRepo("../client/project-review-workspaces.ts") as {
  groupProjectReviewComments: typeof GroupProjectReviewComments;
  canSubmitProjectReviewGroup: typeof CanSubmitProjectReviewGroup;
};
const groupProjectReviewComments = loadedProjectWorkspaceModule.groupProjectReviewComments;
const canSubmitProjectReviewGroup = loadedProjectWorkspaceModule.canSubmitProjectReviewGroup;

const comment = (id: string, cwd: string, workspaceId?: string): ProjectReviewComment => ({
  id,
  projectId: "project-1",
  ...(workspaceId ? { workspaceId } : {}),
  targetFingerprint: `target-${id}`,
  hunkId: `hunk-${id}`,
  hunkFingerprint: `fingerprint-${id}`,
  filePath: `src/${id}.ts`,
  hunkHeader: "@@ -1 +1 @@",
  hunkPatch: "-old\n+new",
  cwd,
  scope: "working",
  comment: `Please fix ${id}`,
  savedAt: "2026-09-30T12:00:00.000Z",
});

const agent = (id: string, workspaceId: string, cwd: string, archived = false): AgentEntry => ({
  id,
  workspaceId,
  cwd,
  status: "idle",
  provider: "omp",
  model: "model-a",
  title: id,
  archived,
});

const agents = [
  agent("agent-a1", "workspace-a", "/repo/worktree-a"),
  agent("agent-a2", "workspace-a", "/repo/worktree-a"),
  agent("agent-a-archived", "workspace-a", "/repo/worktree-a", true),
  agent("agent-b", "workspace-b", "/repo/worktree-b"),
];
const workspaceDirectoryOwners = [
  { workspaceId: "workspace-a", directory: "/repo/worktree-a" },
  { workspaceId: "workspace-b", directory: "/repo/worktree-b" },
];

const comments = [
  comment("a-1", "/repo/worktree-a", "workspace-a"),
  comment("a-2", "/repo/worktree-a", "workspace-a"),
  comment("b-1", "/repo/worktree-b", "workspace-b"),
];

const grouped = groupProjectReviewComments({
  comments,
  batches: [],
  agents,
  workspaceDirectoryOwners,
  selectedAgentByWorkspace: {},
});
assert.equal(grouped.length, 2);
assert.deepEqual(grouped.map((group) => group.workspaceId), ["workspace-a", "workspace-b"]);
assert.deepEqual(grouped[0]?.comments.map((row) => row.id), ["a-1", "a-2"]);
assert.deepEqual(grouped[1]?.comments.map((row) => row.id), ["b-1"]);
assert.deepEqual(grouped[0]?.eligibleAgents.map((entry) => entry.id), ["agent-a1", "agent-a2"]);
assert.equal(grouped[0]?.selectedAgentId, "", "multiple candidates require explicit selection");
assert.equal(grouped[1]?.selectedAgentId, "agent-b", "a unique candidate is selected automatically");

const preferred = groupProjectReviewComments({
  comments,
  batches: [],
  agents,
  workspaceDirectoryOwners,
  selectedAgentByWorkspace: {},
  preferredAgentId: "agent-a2",
});
assert.equal(preferred.find((group) => group.workspaceId === "workspace-a")?.selectedAgentId, "agent-a2");

const explicit = groupProjectReviewComments({
  comments,
  batches: [],
  agents,
  workspaceDirectoryOwners,
  selectedAgentByWorkspace: { "workspace:workspace-a": "agent-a1" },
  preferredAgentId: "agent-a2",
});
assert.equal(explicit.find((group) => group.workspaceId === "workspace-a")?.selectedAgentId, "agent-a1");

const legacyCwdComment = comment("legacy", "/repo/worktree-b/");
const legacyGroup = groupProjectReviewComments({
  comments: [legacyCwdComment],
  batches: [],
  agents,
  workspaceDirectoryOwners,
  selectedAgentByWorkspace: {},
});
assert.equal(legacyGroup[0]?.workspaceId, "workspace-b", "a legacy comment binds only when cwd identifies one workspace");
assert.equal(legacyGroup[0]?.selectedAgentId, "agent-b");

const ambiguousLegacy = groupProjectReviewComments({
  comments: [comment("legacy-shared", "/repo/shared")],
  batches: [],
  // Only one eligible Agent exists, but two workspace records own the cwd.
  agents: [agent("shared-a", "workspace-a", "/repo/shared")],
  workspaceDirectoryOwners: [
    { workspaceId: "workspace-a", directory: "/repo/shared" },
    { workspaceId: "workspace-b", directory: "/repo/shared" },
  ],
  selectedAgentByWorkspace: {},
});
assert.equal(ambiguousLegacy[0]?.workspaceId, null);
const unverifiedLegacy = groupProjectReviewComments({
  comments: [legacyCwdComment],
  batches: [],
  agents,
  workspaceDirectoryOwners: [],
  selectedAgentByWorkspace: {},
});
assert.equal(unverifiedLegacy[0]?.workspaceId, null, "legacy rows remain unassigned when the workspace list is unavailable");
assert.deepEqual(ambiguousLegacy[0]?.eligibleAgents, [], "ambiguous legacy workspace ownership fails closed");

const activeBatch: ActiveReviewBatch = {
  id: "batch-a",
  workspaceId: "workspace-a",
  agentId: "agent-a1",
  commentIds: ["old-comment"],
  status: "running",
};
const activeGroup = groupProjectReviewComments({
  comments: [comment("new-comment", "/repo/worktree-a", "workspace-a")],
  batches: [activeBatch],
  agents,
  workspaceDirectoryOwners,
  selectedAgentByWorkspace: {},
});
assert.equal(activeGroup[0]?.activeBatch?.id, "batch-a");
assert.deepEqual(activeGroup[0]?.comments.map((row) => row.id), ["new-comment"]);

const activeOnlyGroup = groupProjectReviewComments({
  comments: [],
  batches: [activeBatch],
  agents,
  selectedAgentByWorkspace: {},
  workspaceDirectoryOwners,
});
assert.equal(activeOnlyGroup.length, 1);
assert.equal(activeOnlyGroup[0]?.cwd, "/repo/worktree-a");
assert.equal(activeOnlyGroup[0]?.activeBatch?.status, "running");

const noAgent = groupProjectReviewComments({
  comments: [comment("orphan", "/repo/worktree-orphan", "workspace-orphan")],
  batches: [],
  agents,
  selectedAgentByWorkspace: {},
  workspaceDirectoryOwners,
});
assert.equal(noAgent[0]?.workspaceId, "workspace-orphan");
assert.deepEqual(noAgent[0]?.eligibleAgents, []);
assert.equal(noAgent[0]?.comments[0]?.id, "orphan", "comments without an eligible Agent stay in the queue group");

const runningGroup = groupProjectReviewComments({
  comments: [comment("busy-comment", "/repo/worktree-a", "workspace-a")],
  batches: [],
  agents: [{ ...agent("agent-running", "workspace-a", "/repo/worktree-a"), status: "running" }],
  workspaceDirectoryOwners,
  selectedAgentByWorkspace: {},
});
assert.equal(runningGroup[0]?.selectedAgentId, "agent-running", "busy Agents stay visible in the workspace queue");
assert.equal(canSubmitProjectReviewGroup(runningGroup[0]!), false, "a running Agent cannot receive the queue batch");

const idleGroup = groupProjectReviewComments({
  comments: [comment("idle-comment", "/repo/worktree-a", "workspace-a")],
  batches: [],
  agents: [agent("agent-idle", "workspace-a", "/repo/worktree-a")],
  workspaceDirectoryOwners,
  selectedAgentByWorkspace: {},
});
assert.equal(canSubmitProjectReviewGroup(idleGroup[0]!), true, "an idle Agent can receive the queue batch");
console.log("Project workspace batch grouping: all assertions passed");
