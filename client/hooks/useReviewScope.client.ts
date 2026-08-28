import { useMemo, useState } from "react";
import { useWorkspace } from "@getpaseo/plugin";
import type { ReviewScope } from "../../review.shared";
import type { ProjectIdentity } from "../tools.client";

/**
 * Review scope state: the bound workspace's project identity and directory,
 * the Git comparison scope (working/staged/branch/commits), the refs and the
 * path filter. The panel is strictly bound to its workspaceId — every value is
 * derived from useWorkspace(workspaceId) and there is no registry loading,
 * selection state or foreground switching; the panel can never switch to a
 * sibling workspace.
 */
export function useReviewScope(workspaceId: string) {
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

  const reviewCwd = workspace?.directory ?? null;
  // Identity of the bound workspace: project id, display name and root path all
  // come from the workspace snapshot; the workspace id is the last-resort
  // project id so comment saving always has a key.
  const projectIdentity = useMemo((): ProjectIdentity | null => {
    if (!workspace) return null;
    return {
      projectId: workspace.projectId || workspaceId,
      displayName: workspace.projectDisplayName || workspace.name,
      rootPath: workspace.projectRootPath || workspace.directory || undefined,
    };
  }, [workspace, workspaceId]);
  const effectiveProjectId = projectIdentity?.projectId ?? workspaceId;

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
    effectiveProjectId,
    projectIdentity,
    selectedWorkspaceId: workspaceId,
  };
}
