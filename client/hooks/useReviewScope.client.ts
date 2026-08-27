import { useCallback, useEffect, useMemo, useState } from "react";
import { usePaseo, useWorkspace } from "@getpaseo/plugin";
import type { ReviewScope } from "../../review.shared";
import {
  projectKeyOf,
  type ProjectIdentity,
  type WorkspaceEntry,
} from "../tools.client";

/**
 * Review scope state: the project/workspace selection, the Git comparison
 * scope (working/staged/branch/commits), the refs and the path filter.
 * Owns the workspace registry loading and the selection actions that drive
 * the snapshot cwd.
 */
export function useReviewScope(workspaceId: string, setActionError: (message: string | null) => void) {
  const paseo = usePaseo();
  const workspace = useWorkspace(workspaceId, ({ directory, name, status, projectId, projectDisplayName, projectRootPath }) => ({
    directory,
    name,
    status,
    projectId,
    projectDisplayName,
    projectRootPath,
  }));
  const [scope, setScope] = useState<ReviewScope>("working");
  const [baseRef, setBaseRef] = useState("HEAD~1");
  const [headRef, setHeadRef] = useState("HEAD");
  const [filePath, setFilePath] = useState("");
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [workspaceEntries, setWorkspaceEntries] = useState<WorkspaceEntry[]>([]);
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false);

  const reviewCwd = selectedCwd ?? workspace?.directory ?? null;
  const defaultProjectId = useMemo(() => {
    const match = workspaceEntries.find((entry) => entry.id === workspaceId)
      ?? workspaceEntries.find((entry) => entry.workspaceDirectory === workspace?.directory)
      ?? null;
    return match ? projectKeyOf(match) : null;
  }, [workspace?.directory, workspaceEntries, workspaceId]);
  const projectGroups = useMemo(() => {
    const map = new Map<string, { projectId: string; displayName: string; rootPath?: string; entries: WorkspaceEntry[] }>();
    for (const entry of workspaceEntries) {
      const projectId = projectKeyOf(entry);
      let group = map.get(projectId);
      if (!group) {
        group = { projectId, displayName: entry.projectDisplayName || entry.name, entries: [] };
        map.set(projectId, group);
      }
      group.entries.push(entry);
      if (!group.rootPath && entry.projectRootPath) group.rootPath = entry.projectRootPath;
    }
    return Array.from(map.values());
  }, [workspaceEntries]);
  // Identity of the panel's own workspace, used when the workspace list failed
  // to load (or is still empty): Save comment, project selection, display name
  // and root path all fall back to it instead of silently giving up.
  const workspaceProjectGroup = useMemo((): ProjectIdentity | null => {
    if (!workspace) return null;
    return {
      projectId: workspace.projectId || workspaceId,
      displayName: workspace.projectDisplayName || workspace.name,
      rootPath: workspace.projectRootPath || workspace.directory || undefined,
    };
  }, [workspace, workspaceId]);
  const effectiveProjectId = selectedProject ?? defaultProjectId ?? projectGroups[0]?.projectId ?? workspaceProjectGroup?.projectId ?? workspaceId;
  const selectedProjectGroup = projectGroups.find((group) => group.projectId === effectiveProjectId) ?? projectGroups[0] ?? null;
  // The group to present/annotate: list-derived when available, otherwise the
  // panel workspace's own project identity (so a failed list never blocks Save).
  const projectIdentity = selectedProjectGroup ?? workspaceProjectGroup;
  const projectOptions = useMemo(() => projectGroups.map((group) => ({ value: group.projectId, label: group.displayName })), [projectGroups]);
  const workspaceOptions = useMemo(() => (selectedProjectGroup?.entries ?? []).map((entry) => ({ value: entry.id, label: entry.name })), [selectedProjectGroup]);
  const selectedWorkspaceEntry = selectedProjectGroup?.entries.find((entry) =>
    (selectedCwd === null && entry.id === workspaceId) || entry.workspaceDirectory === reviewCwd,
  ) ?? null;
  const selectedWorkspaceId = selectedWorkspaceEntry?.id ?? workspaceId;
  const workspaceValue = selectedWorkspaceEntry?.id ?? "";
  // Bring an explicitly chosen workspace to the Paseo foreground. Only user
  // selections call this — list initialization and first render never
  // force-open. On failure the existing error area shows the reason; the
  // foreground switch is never silently pretended to have happened.
  const bringToForeground = useCallback(async (cwd: string) => {
    try {
      await paseo.workspaces.open({ cwd });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [paseo.workspaces]);
  const selectProject = useCallback((projectId: string) => {
    setSelectedProject(projectId);
    const group = projectGroups.find((candidate) => candidate.projectId === projectId);
    const first = group?.entries[0];
    if (first?.workspaceDirectory) {
      // Selecting a project auto-selects its first workspace and brings it to
      // the foreground; snapshot cwd, agent filtering, saved metadata and the
      // batch processing agent all follow this workspace afterwards.
      setSelectedCwd(first.workspaceDirectory);
      void bringToForeground(first.workspaceDirectory);
    }
  }, [bringToForeground, projectGroups]);
  const selectWorkspace = useCallback((workspaceId: string) => {
    const entry = selectedProjectGroup?.entries.find((candidate) => candidate.id === workspaceId);
    if (!entry) return;
    setSelectedProject(selectedProjectGroup?.projectId ?? null);
    const directory = entry.workspaceDirectory ?? null;
    setSelectedCwd(directory);
    if (directory) void bringToForeground(directory);
  }, [bringToForeground, selectedProjectGroup]);
  const loadWorkspaces = useCallback(async () => {
    try {
      const result = await paseo.workspaces.list();
      setWorkspaceEntries(result.entries
        .filter((entry: WorkspaceEntry) => Boolean(entry.workspaceDirectory))
        .map((entry: WorkspaceEntry) => ({
          id: entry.id,
          name: entry.name,
          workspaceDirectory: entry.workspaceDirectory,
          workspaceKind: entry.workspaceKind,
          status: entry.status,
          projectDisplayName: entry.projectDisplayName,
          projectId: entry.projectId,
          projectRootPath: entry.projectRootPath,
        })));
    } catch {
      // Keep the previously loaded list when a reload fails; when the list has
      // never loaded, project/workspace identity falls back to the panel
      // workspace so saving comments still works without the list.
    } finally {
      // Distinguish "list still loading" from "list loaded but empty": the
      // no-context empty state must not flash while the first fetch is in
      // flight, and must offer an action once the list is known to be empty.
      setWorkspacesLoaded(true);
    }
  }, [paseo.workspaces]);

  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);
  useEffect(() => {
    // Materialize the panel workspace's project once the list first loads;
    // later manual switches (selectedProject !== null) always win.
    if (selectedProject !== null || projectGroups.length === 0) return;
    const entry = workspaceEntries.find((candidate) => candidate.id === workspaceId)
      ?? workspaceEntries.find((candidate) => candidate.workspaceDirectory === workspace?.directory)
      ?? null;
    if (entry) setSelectedProject(projectKeyOf(entry));
  }, [projectGroups, selectedProject, workspace?.directory, workspaceEntries, workspaceId]);

  return {
    workspace,
    scope,
    setScope,
    baseRef,
    setBaseRef,
    headRef,
    setHeadRef,
    filePath,
    setFilePath,
    reviewCwd,
    workspaceEntries,
    workspacesLoaded,
    loadWorkspaces,
    selectProject,
    selectWorkspace,
    effectiveProjectId,
    projectIdentity,
    projectOptions,
    workspaceOptions,
    selectedWorkspaceId,
    selectedWorkspaceEntry,
    workspaceValue,
  };
}
