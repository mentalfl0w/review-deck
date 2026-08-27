import {
  type PluginWorkspacePanelProps,
  usePaseo,
  useRpc,
  useWorkspace,
} from "@getpaseo/plugin";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  clearAllReviewStates,
  clearHunkState,
  clearProjectReviewComments,
  clearReviewState,
  explainHunk,
  explainHunkAi,
  getReviewState,
  getSnapshot,
  hunkDecision,
  listProjectReviewComments,
  listReviewStates,
  processProjectReview,
  rejectHunk,
  runReview,
  type ExplainHunkResult,
  type ExplainHunkAiResult,
  type ProcessProjectReviewResult,
  type ProjectReviewComment,
  type ProjectReviewSummary,
  type ReviewScope,
  type ReviewSections,
  type ReviewSnapshot,
} from "./review.shared";

type Locale = "zh" | "en";
function detectLocale(): Locale {
  try {
    // Strategy 1: works in browser/webview and Hermes/Node/Bun.
    const intl = typeof Intl !== "undefined" && Intl.DateTimeFormat ? Intl.DateTimeFormat().resolvedOptions().locale : "";
    if (intl.startsWith("zh")) return "zh";
    // Strategy 2: browser global on web platform.
    const nav = typeof navigator !== "undefined" ? navigator.language ?? "" : "";
    if (nav.startsWith("zh")) return "zh";
    // Strategy 3: native modules on iOS/Android.
    try {
      const nm = require("react-native");
      const loc = nm?.NativeModules?.SettingsManager?.settings?.AppleLocale
        ?? nm?.NativeModules?.I18nManager?.localeIdentifier ?? "";
      if (loc.startsWith("zh")) return "zh";
    } catch { /* native bridge unavailable */ }
  } catch { /* Intl unavailable */ }
  return "en";
}
const STRINGS = {
  zh: {
    panelTitle: "评审台",
    reviewScope: "评审范围",
    reviewRoute: "评审路线",
    changeDetail: "变更详情",
    analysis: "分析结果",
    comment: "评论",
    agentActions: "Agent 协作",
    scopeCardDesc: "先选项目和工作区，再选择要比较的 Git 改动范围",
    routeCardDesc: "按优先级排序，点击查看变更块详情",
    detailCardDesc: "查看 diff、标记已评审或拒绝",
    analysisCardDesc: "来自规则检查和 AI 的结论及建议",
    commentCardDesc: "给自己或 Agent 的备注",
    agentCardDesc: "委托 AI 评审或修改指定的代码变更块",
    markReviewed: "标记已评审",
    explainHunk: "解释变更",
    rejectHunk: "拒绝变更",
    saveComment: "保存评论",
    refresh: "刷新",
    refreshing: "刷新中…",
    reviewWithAgent: "AI 评审 {agentId}",
    reviseWithAgent: "AI 修改 {agentId}",
    showAgentActions: "展开 Agent 操作",
    hideAgentActions: "收起 Agent 操作",
    markReviewedHint: "仅记录在插件中",
    explainHunkHint: "本地规则分析意图与风险",
    rejectHunkHint: "安全回滚此变更块",
    saveCommentHint: "保存备注到评审记录",
    sendFeedbackLabel: "发送评审意见给 AI",
    sendFeedbackToAgent: "发送给 {agent}",
    sendFeedbackHint: "把评论发给该 Agent，按意见只修改此变更块",
    sendingFeedback: "发送中…",
    feedbackSent: "✓ 已发送",
    feedbackSendFailed: "发送失败",
    refreshHint: "重新读取 Git 快照",
    reviewWithAgentHint: "让 Agent 评审整个 diff",
    reviseWithAgentHint: "让 Agent 修改此变更块",
    agentToggleHint: "显示或隐藏 Agent 委托按钮",
    agentProviderLabel: "Provider",
    agentModelLabel: "模型",
    noAgentModel: "未指定模型",
    pathPlaceholder: "按 repo 相对路径过滤",
    baseRefPlaceholder: "基线分支 · HEAD~1",
    headRefPlaceholder: "目标分支 · HEAD",
    commentPlaceholder: "给自己或 Agent 的备注",
    path: "路径",
    hunkFindings: "变更块发现",
    deterministicExplainLabel: "确定性解释",
    aiExplanationLabel: "AI 解释 · {provider} / {model}",
    aiExplain: "AI 解释",
    aiExplainWithAgent: "AI 解释：{agent}",
    aiExplaining: "AI 解释中…",
    modelConfigHint: "所用模型在 Paseo Agent 设置中配置",
    aiReview: "AI 评审",
    findingsVerified: "已确认事实",
    findingsInference: "AI 推断",
    findingsHuman: "建议人工确认",
    checkSuggestion: "检查：{check}",
    reviewedMark: "✓ 已评审",
    findingCount: "{count} 条发现",
    hunkSummary: "{hunks} 个变更块 · {priority} 个高优先级",
    snapshotSummary: "{files} 个文件 · {hunks} 个变更块 · {priority} 个高优先级",
    agentsAvailable: "{count} 个可用",
    diffOld: "旧",
    diffNew: "新",
    scopeWorking: "未提交改动",
    scopeStaged: "已暂存改动",
    scopeBranch: "分支提交",
    scopeCommits: "提交对比",
    diffModeSplit: "分栏",
    diffModeUnified: "合并",
    severityCritical: "严重",
    severityHigh: "高",
    severityMedium: "中",
    severityLow: "低",
    severityInformational: "信息",
    statusIdle: "空闲",
    statusRunning: "运行中",
    statusFailed: "失败",
    statusArchiving: "归档中",
    staleBanner: "Git 已变更，之前的评审结果已过期。请重新执行解释变更或 AI 评审。",
    analysisStaleText: "已过期 — 请针对当前 Git 状态重新执行解释变更或 AI 评审。",
    loadingWorkspaces: "正在加载工作区…",
    noWorkspacesAvailable: "没有可用工作区。请在 Paseo 中打开一个工作区，然后重试。",
    selectWorkspaceToStart: "从上方选择项目与工作区以开始评审。",
    retry: "重试",
    noHunksInScope: "此范围内没有变更块。",
    noFindings: "此变更块没有自动发现。",
    noAdditionalAnalysis: "没有返回其他分析。",
    analysisHint: "选择一个变更块，使用解释变更或让 Agent 评审以查看分析。",
    noAgents: "此工作区没有可用 Agent。",
    noReviewableHunk: "此范围内没有可评审的文本变更块。",
    noSnapshot: "没有可用的评审快照。",
    readingGitState: "正在读取 Git 状态…",
    preparingSnapshot: "正在准备评审快照…",
    noWorkspaceDirectory: "无工作目录",
    agentFinishedStatus: "评审 Agent 结束，状态：{status}。",
    scopeWorkingDesc: "你正在编辑但尚未提交的改动",
    scopeStagedDesc: "已暂存准备提交的改动",
    scopeBranchDesc: "当前分支相对于基线分支的全部提交",
    scopeCommitsDesc: "对比任意两个提交之间的差异",
    localeToggleLabel: "English",
    scopeLabel: "Diff 来源",
    worktreeHint: "选择要在哪个工作目录里读取 Git",
    projectLabel: "项目",
    workspaceLabel: "工作区",
    selectProject: "选择项目",
    selectWorkspace: "选择工作区",
    closeDropdown: "关闭",
    noWorkspaceOptions: "该项目没有可用工作区",
    reviewStateTitle: "评审状态",
    reviewStateDesc: "人工评审元数据保存在本地文件中，与 Git 完全分离",
    reviewStateLocation: "保存位置：~/.paseo/review-deck/reviews.json",
    reviewStateByTarget: "评审记录按目标指纹（target fingerprint）区分",
    reviewStateNoGit: "保存评论 / 标记已评审只保存人工评审元数据，不会修改 Git",
    reviewStateCurrentSummary: "当前快照：{decisions} 条决定 · {comments} 条评论",
    clearCurrentHunk: "清除当前变更块意见",
    clearCurrentHunkHint: "仅清除当前变更块的已保存决定，不影响 Git",
    clearCurrentReview: "清除本次评审记录",
    clearCurrentReviewHint: "清除当前目标指纹下保存的全部决定",
    manageSavedReviews: "管理已保存评审",
    manageSavedReviewsHint: "查看各目标指纹的评审记录，可逐项清除",
    savedReviewsTitle: "已保存评审",
    savedReviewsEmpty: "没有已保存的评审记录",
    savedReviewsLoading: "加载中…",
    savedReviewsLoadFailed: "加载失败",
    savedReviewRowSummary: "{decisions} 条决定 · {comments} 条评论",
    savedReviewLastSaved: "最后保存：{savedAt}",
    savedReviewScopeLabel: "范围：{scope}",
    savedReviewCwdLabel: "目录：{cwd}",
    clearTarget: "清除",
    clearAllSavedReviews: "清除全部已保存评审",
    clearAllSavedReviewsHint: "删除 reviews.json 中所有目标的评审记录",
    confirmClearAllTitle: "确认清除全部评审记录？",
    confirmClearAllBody: "此操作会删除 reviews.json 中所有目标的评审记录，且不可撤销。",
    cancel: "取消",
    confirm: "确认清除",
    projectCommentsTitle: "项目批注意见",
    projectCommentsDesc: "当前项目的已保存批注，按工作区、范围与文件分组；可一次性提交给 Agent 处理",
    projectCommentsSummary: "{comments} 条批注 · {files} 个文件 · {targets} 个目标",
    projectCommentsProjectName: "项目：{name}",
    projectCommentsRootPath: "根目录：{path}",
    projectCommentsLoading: "正在加载项目批注…",
    projectCommentsRefresh: "刷新批注",
    projectCommentsRefreshHint: "重新读取当前项目的已保存批注",
    projectCommentsEmpty: "此项目还没有已保存的批注。先在变更块上保存评论，再回到这里统一处理。",
    projectFileComments: "{count} 条批注",
    projectCommentSavedAt: "保存于 {savedAt}",
    projectAgentLabel: "当前工作区处理 Agent",
    projectAgentPlaceholder: "选择当前工作区处理 Agent",
    processProjectLabel: "提交批注给当前工作区 Agent 处理",
    processProjectHint: "一次运行处理当前项目全部已保存批注；处理 Agent 仅来自当前工作区，且只修改列出的文件与变更块",
    processProjectNoCommentsHint: "没有可提交的批注",
    processProjectNoAgentHint: "当前工作区没有可用 Agent，批注已保留，处理按钮已禁用",
    executionWorkspace: "执行工作区",
    executionWorkspaceLine: "执行工作区：{name} · {cwd}",
    executionWorkspaceId: "执行 Agent workspace id：{id}",
    processProjectAgentMismatch: "所选 Agent 不属于当前工作区，已拒绝处理",
    processingProject: "处理中…",
    processingProjectHint: "已提交 {count} 条批注，等待 Agent 完成…",
    processResultTitle: "处理结果",
    processResultStatusBad: "Agent 未正常完成，状态：{status}。批注已保留。",
    processResultProviderModel: "Provider：{provider} · 模型：{model}",
    processResultCommentsSent: "本次共提交 {count} 条批注",
    processResultOutcomesTitle: "逐条批注结果",
    processResultOutcomeSummary: "已完成 {completed} 条 · 未完成 {pending} 条",
    processResultOutcomeCompleted: "已完成",
    processResultOutcomeStale: "已过期（目标已变化）",
    processResultOutcomeFailed: "处理失败",
    processResultOutcomeUnresolved: "未解决",
    processResultOutcomeUnknown: "未知",
    processResultOutcomeLine: "批注 {id}：{status}",
    deleteProcessedLabel: "删除已处理批注",
    deleteProcessedHint: "只删除本次已处理完成的 {count} 条批注；过期、失败或未解决的批注保留",
    deletingProcessed: "删除中…",
    processedDeletedNotice: "已删除 {count} 条已处理批注",
    noProjectSelected: "未选择项目",
    fileNavigator: "变更文件",
    fileNavigatorSummary: "{files} 个文件 · {hunks} 个变更块",
    fileStatusSaved: "已保存",
    fileStatusDraft: "草稿",
    fileStatusUncommented: "未批注",
    fileStatusMultiple: "{count} 个独立锚点",
    fileChangeSummary: "{hunks} 个变更块 · +{additions} / -{deletions}",
    fileDetail: "文件详情",
    backToFiles: "返回文件",
    chooseFile: "选择文件",
    currentChangeBlock: "变更块 {current}/{total}",
    previousChangeBlock: "上一个变更块",
    nextChangeBlock: "下一个变更块",
    changeBlockActions: "变更块操作",
    hideChangeBlockActions: "收起变更块操作",
    currentDiff: "当前精确差异",
    showFindings: "展开发现",
    hideFindings: "收起发现",
    findingsSummary: "{count} 条发现",
    fileCommentTitle: "文件批注",
    fileCommentDesc: "默认每个文件一条主批注；保存时仍以当前变更块作为精确内部锚点。",
    fileCommentPlaceholder: "写下对这个文件全部变更的评审意见",
    saveFileComment: "保存并加入项目批注",
    savingFileComment: "保存中…",
    fileCommentSaved: "已加入项目批注",
    fileCommentSavedAt: "保存于 {savedAt}",
    fileCommentAnchor: "内部锚点：{anchor}",
    fileCommentAnchorCurrent: "当前正在查看此锚点",
    fileCommentAnchorDifferent: "批注仍锚定另一变更块；切换查看不会改绑。",
    returnToCommentAnchor: "查看原锚点",
    moveCommentAnchor: "改锚点到当前变更块",
    moveCommentAnchorReady: "保存后将明确改绑到当前变更块",
    otherFileComments: "其他独立批注",
    showOtherFileComments: "显示其他独立批注",
    hideOtherFileComments: "隐藏其他独立批注",
    selectSavedComment: "编辑此批注",
    queueButton: "AI 处理项目批注 {count}",
    more: "更多",
    contextSnapshot: "快照",
    snapshotCurrent: "快照最新",
    snapshotStale: "快照已过期",
    snapshotRefreshing: "正在刷新",
    snapshotGenerated: "生成于 {generatedAt}",
    moreTitle: "更多与管理",
    moreContextTitle: "评审范围与路径",
    moreAgentsTitle: "Agent 协作",
    moreSafetyTitle: "安全状态管理",
    close: "关闭",
    queueNextRun: "处理期间新增的批注不会被本次清理，会保留到下一次提交。",
    queueGroupMeta: "{cwd} · {scope}",
    markReviewedUnavailable: "当前变更块承载文件批注，不能用“已评审”覆盖它。",
    commentEmptyGuidance: "在差异下方记录一条可执行意见，再加入项目队列。",
  },
  en: {
    panelTitle: "Review Deck",
    reviewScope: "Review scope",
    reviewRoute: "Review route",
    changeDetail: "Change detail",
    analysis: "Analysis",
    comment: "Comment",
    agentActions: "Agent actions",
    scopeCardDesc: "Choose a project and workspace, then choose what Git changes to compare",
    routeCardDesc: "Sorted by priority; tap a hunk to inspect",
    detailCardDesc: "View the diff, mark reviewed, or reject",
    analysisCardDesc: "Automated findings and AI analysis for this hunk",
    commentCardDesc: "A note for yourself or the agent",
    agentCardDesc: "Delegate AI review or revision of this hunk",
    markReviewed: "Mark reviewed",
    explainHunk: "Explain hunk",
    rejectHunk: "Reject hunk",
    saveComment: "Save comment",
    refresh: "Refresh",
    refreshing: "Refreshing…",
    reviewWithAgent: "Review with {agentId}",
    reviseWithAgent: "Revise with {agentId}",
    showAgentActions: "Show agent actions",
    hideAgentActions: "Hide agent actions",
    markReviewedHint: "Recorded in the plugin only",
    explainHunkHint: "Local rule-based analysis of intent and risk",
    rejectHunkHint: "Safely reverts this hunk",
    saveCommentHint: "Saves the note to the review record",
    sendFeedbackLabel: "Send feedback to AI",
    sendFeedbackToAgent: "Send to {agent}",
    sendFeedbackHint: "Sends your comment to this agent to revise this hunk only",
    sendingFeedback: "Sending…",
    feedbackSent: "✓ Sent",
    feedbackSendFailed: "Failed to send",
    refreshHint: "Reloads the Git snapshot",
    reviewWithAgentHint: "Asks the agent to review the whole diff",
    reviseWithAgentHint: "Asks the agent to revise this hunk",
    agentToggleHint: "Show or hide agent delegation buttons",
    agentProviderLabel: "Provider",
    agentModelLabel: "Model",
    noAgentModel: "No model set",
    pathPlaceholder: "Filter by repo-relative path",
    baseRefPlaceholder: "Base ref · HEAD~1",
    headRefPlaceholder: "Head ref · HEAD",
    commentPlaceholder: "Note for yourself or the agent",
    path: "Path",
    hunkFindings: "Hunk findings",
    deterministicExplainLabel: "Deterministic explanation",
    aiExplanationLabel: "AI explanation · {provider} / {model}",
    aiExplain: "AI explain",
    aiExplainWithAgent: "AI explain: {agent}",
    aiExplaining: "Explaining…",
    modelConfigHint: "The model is configured in Paseo Agent settings",
    aiReview: "AI review",
    findingsVerified: "Verified facts",
    findingsInference: "AI inference",
    findingsHuman: "Human verification recommended",
    checkSuggestion: "Check: {check}",
    reviewedMark: "✓ reviewed",
    findingCount: "{count} findings",
    hunkSummary: "{hunks} hunks · {priority} priority",
    snapshotSummary: "{files} files · {hunks} hunks · {priority} priority",
    agentsAvailable: "{count} available",
    diffOld: "Old",
    diffNew: "New",
    scopeWorking: "Uncommitted changes",
    scopeStaged: "Staged changes",
    scopeBranch: "Branch commits",
    scopeCommits: "Commit comparison",
    diffModeSplit: "Split",
    diffModeUnified: "Unified",
    severityCritical: "Critical",
    severityHigh: "High",
    severityMedium: "Medium",
    severityLow: "Low",
    severityInformational: "Informational",
    statusIdle: "Idle",
    statusRunning: "Running",
    statusFailed: "Failed",
    statusArchiving: "Archiving",
    staleBanner: "Git changed; the previous review is stale. Re-run Explain hunk or the AI review.",
    analysisStaleText: "Stale — re-run Explain hunk or the AI review for the current Git state.",
    loadingWorkspaces: "Loading workspaces…",
    noWorkspacesAvailable: "No workspaces available. Open a workspace in Paseo, then retry.",
    selectWorkspaceToStart: "Pick a project and workspace above to start reviewing.",
    retry: "Retry",
    noHunksInScope: "No hunks in this scope.",
    noFindings: "No automated findings for this hunk.",
    noAdditionalAnalysis: "No additional analysis returned.",
    analysisHint: "Select a hunk and use Explain hunk, or run a review with an agent, to see analysis.",
    noAgents: "No agents available in this workspace.",
    noReviewableHunk: "No reviewable text hunk exists for this scope.",
    noSnapshot: "No review snapshot available.",
    readingGitState: "Reading Git state…",
    preparingSnapshot: "Preparing review snapshot…",
    noWorkspaceDirectory: "No workspace directory",
    agentFinishedStatus: "Review agent finished with status: {status}.",
    scopeWorkingDesc: "Uncommitted changes you are currently editing",
    scopeStagedDesc: "Changes staged and ready to commit",
    scopeBranchDesc: "All commits on your branch ahead of the base branch",
    scopeCommitsDesc: "Compare any two commits side by side",
    localeToggleLabel: "中文",
    scopeLabel: "Diff source",
    worktreeHint: "Choose which working directory to read Git from",
    projectLabel: "Project",
    workspaceLabel: "Workspace",
    selectProject: "Select project",
    selectWorkspace: "Select workspace",
    closeDropdown: "Close",
    noWorkspaceOptions: "No workspaces available for this project",
    reviewStateTitle: "Review state",
    reviewStateDesc: "Human review metadata is stored in a local file, fully separate from Git",
    reviewStateLocation: "Stored at: ~/.paseo/review-deck/reviews.json",
    reviewStateByTarget: "Review records are keyed by target fingerprint",
    reviewStateNoGit: "Save comment / Mark reviewed only saves human review metadata; it never modifies Git",
    reviewStateCurrentSummary: "Current snapshot: {decisions} decisions · {comments} comments",
    clearCurrentHunk: "Clear current hunk",
    clearCurrentHunkHint: "Clears only the saved decision for the current hunk; Git is unaffected",
    clearCurrentReview: "Clear current review",
    clearCurrentReviewHint: "Clears all saved decisions for the current target fingerprint",
    manageSavedReviews: "Manage saved reviews",
    manageSavedReviewsHint: "View review records per target fingerprint and clear them individually",
    savedReviewsTitle: "Saved reviews",
    savedReviewsEmpty: "No saved review records",
    savedReviewsLoading: "Loading…",
    savedReviewsLoadFailed: "Failed to load",
    savedReviewRowSummary: "{decisions} decisions · {comments} comments",
    savedReviewLastSaved: "Last saved: {savedAt}",
    savedReviewScopeLabel: "Scope: {scope}",
    savedReviewCwdLabel: "Cwd: {cwd}",
    clearTarget: "Clear",
    clearAllSavedReviews: "Clear all saved reviews",
    clearAllSavedReviewsHint: "Removes review records for every target from reviews.json",
    confirmClearAllTitle: "Clear all saved review records?",
    confirmClearAllBody: "This removes review records for every target from reviews.json and cannot be undone.",
    cancel: "Cancel",
    confirm: "Clear all",
    projectCommentsTitle: "Project review comments",
    projectCommentsDesc: "Saved comments for the current project, grouped by workspace, scope, and file; submit them to an agent in one run",
    projectCommentsSummary: "{comments} comments · {files} files · {targets} targets",
    projectCommentsProjectName: "Project: {name}",
    projectCommentsRootPath: "Root: {path}",
    projectCommentsLoading: "Loading project comments…",
    projectCommentsRefresh: "Refresh comments",
    projectCommentsRefreshHint: "Reloads the saved comments of the current project",
    projectCommentsEmpty: "No saved comments for this project yet. Save comments on hunks first, then come back here to process them.",
    projectFileComments: "{count} comments",
    projectCommentSavedAt: "Saved {savedAt}",
    projectAgentLabel: "Processing agent for selected workspace",
    projectAgentPlaceholder: "Select a processing agent of the selected workspace",
    processProjectLabel: "Process comments with the selected workspace agent",
    processProjectHint: "Processes every saved comment of this project in one run, using an agent of the selected workspace; the agent only touches the listed files and hunks",
    processProjectNoCommentsHint: "No comments to process",
    processProjectNoAgentHint: "No agent available in the selected workspace; comments are kept and processing is disabled",
    executionWorkspace: "Execution workspace",
    executionWorkspaceLine: "Execution workspace: {name} · {cwd}",
    executionWorkspaceId: "Executing agent workspace id: {id}",
    processProjectAgentMismatch: "The selected agent is not part of the selected workspace; processing refused",
    processingProject: "Processing…",
    processingProjectHint: "Submitted {count} comments; waiting for the agent…",
    processResultTitle: "Processing result",
    processResultStatusBad: "Agent did not finish cleanly (status: {status}). Comments are kept.",
    processResultProviderModel: "Provider: {provider} · Model: {model}",
    processResultCommentsSent: "{count} comments submitted in this run",
    processResultOutcomesTitle: "Per-comment results",
    processResultOutcomeSummary: "{completed} completed · {pending} pending",
    processResultOutcomeCompleted: "Completed",
    processResultOutcomeStale: "Stale (target changed)",
    processResultOutcomeFailed: "Failed",
    processResultOutcomeUnresolved: "Unresolved",
    processResultOutcomeUnknown: "Unknown",
    processResultOutcomeLine: "Comment {id}: {status}",
    deleteProcessedLabel: "Delete processed comments",
    deleteProcessedHint: "Deletes only the {count} completed comments of this run; stale, failed, and unresolved comments are kept",
    deletingProcessed: "Deleting…",
    processedDeletedNotice: "Deleted {count} processed comments",
    noProjectSelected: "No project selected",
    fileNavigator: "Changed files",
    fileNavigatorSummary: "{files} files · {hunks} change blocks",
    fileStatusSaved: "Saved",
    fileStatusDraft: "Draft",
    fileStatusUncommented: "No comment",
    fileStatusMultiple: "{count} separate anchors",
    fileChangeSummary: "{hunks} change blocks · +{additions} / -{deletions}",
    fileDetail: "File detail",
    backToFiles: "Back to files",
    chooseFile: "Choose file",
    currentChangeBlock: "Change block {current}/{total}",
    previousChangeBlock: "Previous change block",
    nextChangeBlock: "Next change block",
    changeBlockActions: "Change block actions",
    hideChangeBlockActions: "Hide change block actions",
    currentDiff: "Current exact diff",
    showFindings: "Show findings",
    hideFindings: "Hide findings",
    findingsSummary: "{count} findings",
    fileCommentTitle: "File comment",
    fileCommentDesc: "Use one primary comment per file by default. Saving still uses the current change block as the exact internal anchor.",
    fileCommentPlaceholder: "Write one review comment for all changes in this file",
    saveFileComment: "Save and add to project comments",
    savingFileComment: "Saving…",
    fileCommentSaved: "Added to project comments",
    fileCommentSavedAt: "Saved {savedAt}",
    fileCommentAnchor: "Internal anchor: {anchor}",
    fileCommentAnchorCurrent: "You are viewing this anchor",
    fileCommentAnchorDifferent: "This comment remains anchored to another change block; browsing does not rebind it.",
    returnToCommentAnchor: "View saved anchor",
    moveCommentAnchor: "Move anchor to this change block",
    moveCommentAnchorReady: "Saving will explicitly move the anchor to this change block",
    otherFileComments: "Other separate comments",
    showOtherFileComments: "Show other separate comments",
    hideOtherFileComments: "Hide other separate comments",
    selectSavedComment: "Edit this comment",
    queueButton: "Process project comments {count}",
    more: "More",
    contextSnapshot: "Snapshot",
    snapshotCurrent: "Snapshot current",
    snapshotStale: "Snapshot stale",
    snapshotRefreshing: "Refreshing",
    snapshotGenerated: "Generated {generatedAt}",
    moreTitle: "More & management",
    moreContextTitle: "Review scope & path",
    moreAgentsTitle: "Agent collaboration",
    moreSafetyTitle: "Safety state management",
    close: "Close",
    queueNextRun: "Comments added during processing are not cleared by this run; they remain for the next submission.",
    queueGroupMeta: "{cwd} · {scope}",
    markReviewedUnavailable: "This change block anchors the file comment, so Mark reviewed cannot overwrite it.",
    commentEmptyGuidance: "Write one actionable note beneath the diff, then add it to the project queue.",
  },
} as const;
type StringKey = keyof typeof STRINGS.en;
function makeT(locale: Locale) {
  return (key: StringKey, params?: Record<string, string|number>): string => {
    let s: string = (STRINGS[locale] as Record<string,string>)[key] ?? STRINGS.en[key];
    if (params) for (const [k,v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
    return s;
  };
}

type SelectedHunk = ReviewSnapshot["files"][number]["hunks"][number];
type Severity = SelectedHunk["findings"][number]["severity"];
type AgentInfo = {
  id: string;
  provider?: string;
  model?: string | null;
  title?: string | null;
};
type AgentFeedbackState = {
  phase: "idle" | "sending" | "sent" | "error";
  message?: string;
};
type AgentEntry = {
  id: string;
  workspaceId: string | null;
  cwd?: string;
  status?: string;
  provider?: string;
  model?: string | null;
  title?: string | null;
};
type WorkspaceEntry = {
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
function projectKeyOf(entry: WorkspaceEntry): string {
  return entry.projectId ?? entry.projectDisplayName;
}
type ReviewDecision = {
  hunkId: string;
  decision: "reviewed" | "commented";
  comment?: string;
  savedAt: string;
};
type SavedReviewSummary = {
  targetFingerprint: string;
  cwd?: string;
  scope?: ReviewScope;
  decisionCount: number;
  commentCount: number;
  lastSavedAt: string;
};
type FileCommentDraft = {
  body: string;
  anchorHunkId: string;
  originalHunkId: string | null;
  dirty: boolean;
};
type PanelTheme = PluginWorkspacePanelProps["theme"];
type PanelLayout = PluginWorkspacePanelProps["layout"];
type DiffMode = "split" | "unified";

const scopeKeys: Array<{ value: ReviewScope; key: StringKey }> = [
  { value: "working", key: "scopeWorking" },
  { value: "staged", key: "scopeStaged" },
  { value: "branch", key: "scopeBranch" },
  { value: "commits", key: "scopeCommits" },
];
const scopeDescKeys: Record<ReviewScope, StringKey> = {
  working: "scopeWorkingDesc",
  staged: "scopeStagedDesc",
  branch: "scopeBranchDesc",
  commits: "scopeCommitsDesc",
};
const scopeLabelKeys: Record<ReviewScope, StringKey> = {
  working: "scopeWorking",
  staged: "scopeStaged",
  branch: "scopeBranch",
  commits: "scopeCommits",
};

const diffModeKeys: Array<{ value: DiffMode; key: StringKey }> = [
  { value: "split", key: "diffModeSplit" },
  { value: "unified", key: "diffModeUnified" },
];

const severityLabelKeys: Record<Severity, StringKey> = {
  critical: "severityCritical",
  high: "severityHigh",
  medium: "severityMedium",
  low: "severityLow",
  informational: "severityInformational",
};

const outcomeStatusKeys: Record<string, StringKey> = {
  completed: "processResultOutcomeCompleted",
  stale: "processResultOutcomeStale",
  failed: "processResultOutcomeFailed",
  unresolved: "processResultOutcomeUnresolved",
};

const statusLabelKeys: Record<string, StringKey> = {
  idle: "statusIdle",
  running: "statusRunning",
  failed: "statusFailed",
  archiving: "statusArchiving",
};

const severityOrder: Severity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "informational",
];

function severityColor(severity: Severity, theme: PanelTheme): string {
  if (severity === "critical" || severity === "high") return theme.colors.statusDanger;
  if (severity === "medium") return theme.colors.accent;
  return theme.colors.foregroundMuted;
}

function maxSeverity(hunk: SelectedHunk): Severity {
  return severityOrder.find((severity) => hunk.findings.some((finding) => finding.severity === severity)) ?? "informational";
}

/** Convert a #rrggbb / #rgb theme color into an rgba() string with the given alpha. */
function withAlpha(hex: string, alpha: number): string {
  const match = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!match) return hex;
  const short = match[1];
  const full = short.length === 3 ? short.split("").map((char) => char + char).join("") : short;
  const red = parseInt(full.slice(0, 2), 16);
  const green = parseInt(full.slice(2, 4), 16);
  const blue = parseInt(full.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

type DiffLineKind = "add" | "del" | "context";

type SideLine = { kind: DiffLineKind; content: string; lineNo: number };

type DiffPair = { old: SideLine | null; new: SideLine | null };

/**
 * Derive aligned old/new line pairs from the unified hunk body, deterministically.
 * Context lines pair 1:1; a run of deletions followed by a run of additions zips
 * in order; surplus single-side lines keep an empty opposite side.
 */
function derivePairs(hunk: SelectedHunk): DiffPair[] {
  const pairs: DiffPair[] = [];
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  let pendingDel: SideLine[] = [];
  let pendingAdd: SideLine[] = [];
  const flush = () => {
    const count = Math.max(pendingDel.length, pendingAdd.length);
    for (let index = 0; index < count; index++) {
      pairs.push({ old: pendingDel[index] ?? null, new: pendingAdd[index] ?? null });
    }
    pendingDel = [];
    pendingAdd = [];
  };
  for (const line of hunk.lines) {
    if (line.startsWith("+")) {
      pendingAdd.push({ kind: "add", content: line.slice(1), lineNo: newNo });
      newNo += 1;
    } else if (line.startsWith("-")) {
      pendingDel.push({ kind: "del", content: line.slice(1), lineNo: oldNo });
      oldNo += 1;
    } else {
      flush();
      const content = line.startsWith(" ") ? line.slice(1) : line;
      pairs.push({
        old: { kind: "context", content, lineNo: oldNo },
        new: { kind: "context", content, lineNo: newNo },
      });
      oldNo += 1;
      newNo += 1;
    }
  }
  flush();
  return pairs;
}

type UnifiedRow = { sign: "+" | "-" | " "; kind: DiffLineKind; content: string };

/** Flatten aligned pairs back into unified presentation order (- then + per replacement). */
function deriveUnifiedRows(pairs: DiffPair[]): UnifiedRow[] {
  const rows: UnifiedRow[] = [];
  for (const pair of pairs) {
    if (pair.old && pair.new && pair.old.kind === "context") {
      rows.push({ sign: " ", kind: "context", content: pair.old.content });
    } else {
      if (pair.old) rows.push({ sign: "-", kind: "del", content: pair.old.content });
      if (pair.new) rows.push({ sign: "+", kind: "add", content: pair.new.content });
    }
  }
  return rows;
}

/** Split "@@ -a,b +c,d @@" into the range token and the trailing function context, if any. */
function hunkHeaderParts(header: string): { range: string; context: string | null } {
  const second = header.indexOf("@@", 2);
  if (second === -1) return { range: header, context: null };
  const range = header.slice(0, second + 2);
  const context = header.slice(second + 2).trim();
  return { range, context: context.length > 0 ? context : null };
}


function SeverityBadge({ severity, label, theme, compact = false }: {
  severity: Severity;
  label: string;
  theme: PanelTheme;
  compact?: boolean;
}) {
  const color = severityColor(severity, theme);
  return (
    <View style={{ backgroundColor: withAlpha(color, 0.13), borderRadius: 999, paddingHorizontal: compact ? 6 : 7, paddingVertical: 1.5, alignSelf: "flex-start" }}>
      <Text style={{ color, fontSize: compact ? 9 : 10, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.4, lineHeight: compact ? 12 : 13 }}>{label}</Text>
    </View>
  );
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

function ActionButton({ label, hint, onPress, variant, theme, layout, disabled = false, stretch = false }: {
  label: string;
  hint?: string;
  onPress: () => void;
  variant: ButtonVariant;
  theme: PanelTheme;
  layout: PanelLayout;
  disabled?: boolean;
  stretch?: boolean;
}) {
  const c = theme.colors;
  const compact = layout.compact;
  const button = {
    primary: {
      backgroundColor: c.accent,
      paddingVertical: 8,
      paddingHorizontal: compact ? 12 : 14,
      minHeight: compact ? 40 : 36,
    },
    secondary: {
      borderWidth: 1,
      borderColor: withAlpha(c.accent, 0.5),
      paddingVertical: 8,
      paddingHorizontal: compact ? 12 : 14,
      minHeight: compact ? 40 : 36,
    },
    ghost: {
      borderWidth: 1,
      borderColor: withAlpha(c.foregroundMuted, 0.35),
      paddingVertical: 8,
      paddingHorizontal: compact ? 10 : 12,
      minHeight: compact ? 40 : 36,
    },
    danger: {
      borderWidth: 1,
      borderColor: withAlpha(c.statusDanger, 0.55),
      paddingVertical: 8,
      paddingHorizontal: compact ? 12 : 14,
      minHeight: compact ? 40 : 36,
    },
  } as const;
  const text = {
    primary: { color: c.accentForeground, fontSize: 12.5, fontWeight: "700" as const },
    secondary: { color: c.accent, fontSize: 12.5, fontWeight: "600" as const },
    ghost: { color: c.foregroundMuted, fontSize: 12, fontWeight: "600" as const },
    danger: { color: c.statusDanger, fontSize: 12.5, fontWeight: "600" as const },
  };
  return (
    <View style={{ gap: hint ? 3 : 0, alignItems: stretch ? "stretch" : "flex-start", alignSelf: stretch ? "stretch" : undefined }}>
      <Pressable
        accessibilityRole="button"
        disabled={disabled}
        onPress={onPress}
        style={[
          { borderRadius: 7, justifyContent: "center", alignItems: "center", alignSelf: stretch ? "stretch" : "flex-start" },
          button[variant],
          disabled ? { opacity: 0.45 } : null,
        ]}
      >
        <Text style={text[variant]}>{label}</Text>
      </Pressable>
      {hint ? (
        <Text style={{ color: c.foregroundMuted, fontSize: compact ? 10 : 10.5, lineHeight: compact ? 14 : 15, maxWidth: stretch ? undefined : 280 }}>{hint}</Text>
      ) : null}
    </View>
  );
}

function Segmented<T extends string>({ options, value, onChange, theme, layout, stretch = false }: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  theme: PanelTheme;
  layout: PanelLayout;
  stretch?: boolean;
}) {
  return (
    <View style={{ alignSelf: stretch ? "stretch" : undefined, flexDirection: "row", borderWidth: 1, borderColor: withAlpha(theme.colors.foregroundMuted, 0.3), borderRadius: 8, padding: 2, gap: 2 }}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            style={{ flex: stretch ? 1 : undefined, borderRadius: 6, paddingVertical: layout.compact ? 4 : 5, paddingHorizontal: layout.compact ? 8 : 10, backgroundColor: active ? theme.colors.accent : undefined }}
          >
            <Text style={{ color: active ? theme.colors.accentForeground : theme.colors.foregroundMuted, fontSize: layout.compact ? 11 : 12, fontWeight: "600", textAlign: stretch ? "center" : undefined }}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Full-row select control: a bordered field that opens a centered modal list.
 * Value selection is a real picker interaction, not a row of chips.
 */
function DropdownSelect({ label, value, options, onChange, placeholder, closeLabel, theme, layout }: {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
  placeholder: string;
  closeLabel: string;
  theme: PanelTheme;
  layout: PanelLayout;
}) {
  const c = theme.colors;
  const compact = layout.compact;
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value) ?? null;
  // Semi-transparent, theme-derived backdrop that dims the content behind the card.
  const backdrop = withAlpha(c.foreground, 0.45);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        onPress={() => setOpen(true)}
        style={{
          minHeight: 38,
          flexDirection: "row",
          alignItems: "center",
          gap: compact ? 6 : 8,
          borderWidth: 1,
          borderColor: withAlpha(c.foregroundMuted, 0.3),
          borderRadius: 7,
          paddingHorizontal: compact ? 10 : 12,
          paddingVertical: compact ? 7 : 8,
          backgroundColor: withAlpha(c.foreground, 0.03),
        }}
      >
        <Text
          numberOfLines={1}
          style={{ flexShrink: 1, color: c.foregroundMuted, fontSize: compact ? 10 : 11, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5 }}
        >
          {label}
        </Text>
        <View style={{ flex: 1, minWidth: 0 }} />
        <Text
          numberOfLines={1}
          style={{ flexShrink: 1, color: selected ? c.foreground : c.foregroundMuted, fontSize: compact ? 12 : 13, fontWeight: selected ? "600" : "400" }}
        >
          {selected?.label ?? value ?? placeholder}
        </Text>
        <Text style={{ color: c.foregroundMuted, fontSize: compact ? 11 : 12 }}>▾</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable
          style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: compact ? 12 : 24, backgroundColor: backdrop }}
          onPress={() => setOpen(false)}
        >
          <Pressable
            onPress={(event) => event.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: compact ? undefined : 520,
              maxHeight: compact ? "92%" : "80%",
              borderRadius: 12,
              borderWidth: 1,
              borderColor: withAlpha(c.foregroundMuted, 0.25),
              backgroundColor: c.surface0,
              padding: compact ? 12 : 16,
              gap: compact ? 8 : 10,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text numberOfLines={1} style={{ flex: 1, color: c.foreground, fontSize: compact ? 13 : 15, fontWeight: "700" }}>{label}</Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => setOpen(false)}
                style={{ borderWidth: 1, borderColor: withAlpha(c.foregroundMuted, 0.35), borderRadius: 999, paddingHorizontal: compact ? 8 : 10, paddingVertical: compact ? 3 : 4 }}
              >
                <Text style={{ color: c.foregroundMuted, fontSize: compact ? 10.5 : 11.5, fontWeight: "600" }}>{closeLabel}</Text>
              </Pressable>
            </View>
            {options.length > 0 ? (
              <ScrollView style={{ maxHeight: compact ? 360 : 420 }} contentContainerStyle={{ gap: 2, paddingVertical: 2 }}>
                {options.map((option) => {
                  const active = option.value === value;
                  return (
                    <Pressable
                      key={option.value}
                      accessibilityRole="button"
                      onPress={() => {
                        onChange(option.value);
                        setOpen(false);
                      }}
                      style={{
                        minHeight: 40,
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 8,
                        borderRadius: 7,
                        paddingHorizontal: compact ? 10 : 12,
                        paddingVertical: compact ? 6 : 8,
                        backgroundColor: active ? c.accent : undefined,
                      }}
                    >
                      <Text numberOfLines={2} style={{ flex: 1, color: active ? c.accentForeground : c.foreground, fontSize: compact ? 12.5 : 13.5, fontWeight: active ? "600" : "400" }}>
                        {option.label}
                      </Text>
                      {active ? (
                        <Text style={{ color: c.accentForeground, fontSize: compact ? 12 : 13, fontWeight: "700" }}>✓</Text>
                      ) : null}
                    </Pressable>
                  );
                })}
              </ScrollView>
            ) : (
              <Text style={{ color: c.foregroundMuted, fontSize: compact ? 12 : 13, lineHeight: 18, paddingVertical: 6 }}>{placeholder}</Text>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

export function ReviewDeckPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const paseo = usePaseo();
  const workspace = useWorkspace(workspaceId, ({ directory, name, status, projectId, projectDisplayName, projectRootPath }) => ({
    directory,
    name,
    status,
    projectId,
    projectDisplayName,
    projectRootPath,
  }));
  const snapshotRpc = useRpc(getSnapshot);
  const stateRpc = useRpc(getReviewState);
  const explainRpc = useRpc(explainHunk);
  const explainHunkAiRpc = useRpc(explainHunkAi);
  const decisionRpc = useRpc(hunkDecision);
  const rejectRpc = useRpc(rejectHunk);
  const runReviewRpc = useRpc(runReview);
  const clearHunkRpc = useRpc(clearHunkState);
  const clearReviewRpc = useRpc(clearReviewState);
  const listStatesRpc = useRpc(listReviewStates);
  const clearAllRpc = useRpc(clearAllReviewStates);
  const listProjectCommentsRpc = useRpc(listProjectReviewComments);
  const processProjectCommentsRpc = useRpc(processProjectReview);
  const clearProjectCommentsRpc = useRpc(clearProjectReviewComments);
  const [manualLocale, setManualLocale] = useState<Locale | null>(null);
  const locale = manualLocale ?? detectLocale();
  const t = useMemo(() => makeT(locale), [locale]);

  const [scope, setScope] = useState<ReviewScope>("working");
  const [baseRef, setBaseRef] = useState("HEAD~1");
  const [headRef, setHeadRef] = useState("HEAD");
  const [filePath, setFilePath] = useState("");
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [workspaceEntries, setWorkspaceEntries] = useState<WorkspaceEntry[]>([]);
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false);
  const [allAgents, setAllAgents] = useState<AgentEntry[]>([]);
  const [selectedProcessAgent, setSelectedProcessAgent] = useState("");
  const [projectComments, setProjectComments] = useState<ProjectReviewSummary | null>(null);
  const [projectCommentsLoading, setProjectCommentsLoading] = useState(false);
  const [projectCommentsError, setProjectCommentsError] = useState<string | null>(null);
  const [processingProject, setProcessingProject] = useState(false);
  const [processResult, setProcessResult] = useState<ProcessProjectReviewResult | null>(null);
  const [processError, setProcessError] = useState<string | null>(null);
  const [deletingProcessed, setDeletingProcessed] = useState(false);
  const [projectNotice, setProjectNotice] = useState<string | null>(null);
  const projectRunRef = useRef(0);
  const projectCommentsRequestRef = useRef(0);
  const [snapshot, setSnapshot] = useState<ReviewSnapshot | null>(null);
  const [selectedHunkId, setSelectedHunkId] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<ReviewDecision[]>([]);
  const [fileCommentDrafts, setFileCommentDrafts] = useState<Record<string, FileCommentDraft>>({});
  const [commentSaving, setCommentSaving] = useState(false);
  const [commentNotice, setCommentNotice] = useState<string | null>(null);
  const [explanation, setExplanation] = useState<ExplainHunkResult | null>(null);
  const [aiExplanation, setAiExplanation] = useState<ExplainHunkAiResult | null>(null);
  const [aiExplainBusy, setAiExplainBusy] = useState<string | null>(null);
  const [agentReview, setAgentReview] = useState<string | null>(null);
  const [agentSections, setAgentSections] = useState<ReviewSections | null>(null);
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [diffMode, setDiffMode] = useState<DiffMode>(layout.compact ? "unified" : "split");
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [agentFeedback, setAgentFeedback] = useState<Record<string, AgentFeedbackState>>({});
  const [queueOpen, setQueueOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [findingsOpen, setFindingsOpen] = useState(false);
  const [otherCommentsOpen, setOtherCommentsOpen] = useState(false);
  const [compactFilesOpen, setCompactFilesOpen] = useState(layout.compact);
  const [manageOpen, setManageOpen] = useState(false);
  const [savedReviews, setSavedReviews] = useState<SavedReviewSummary[] | null>(null);
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [stateError, setStateError] = useState<string | null>(null);

  const targetFingerprintRef = useRef<string | null>(null);
  // Monotonic guard for the snapshot pipeline: any refresh or watcher that
  // starts later supersedes earlier in-flight responses, so a slow response
  // from a previous project/workspace can never overwrite the current one.
  const snapshotRunRef = useRef(0);

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
  const workspaceProjectGroup = useMemo(() => {
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
  const selected = useMemo(() => {
    if (!snapshot || !selectedHunkId) return null;
    return snapshot.files.flatMap((file) => file.hunks).find((hunk) => hunk.id === selectedHunkId) ?? null;
  }, [selectedHunkId, snapshot]);
  const selectedFile = useMemo(() => {
    if (!snapshot || !selected) return null;
    return snapshot.files.find((file) => file.hunks.some((hunk) => hunk.id === selected.id)) ?? null;
  }, [selected, snapshot]);
  const selectedFileComments = useMemo(() => {
    if (!selectedFile) return [];
    return selectedFile.hunks.flatMap((hunk) => {
      const decision = decisions.find((candidate) => candidate.hunkId === hunk.id && Boolean(candidate.comment));
      return decision?.comment ? [{ hunk, decision }] : [];
    }).sort((left, right) => right.decision.savedAt.localeCompare(left.decision.savedAt));
  }, [decisions, selectedFile]);
  const mainFileComment = selectedFileComments[0] ?? null;
  const activeCommentKey = snapshot && selectedFile ? `${snapshot.targetFingerprint}\u0000${selectedFile.path}` : null;
  const defaultCommentBody = mainFileComment?.decision.comment ?? "";
  const defaultCommentAnchorId = mainFileComment?.hunk.id ?? selected?.id ?? "";
  const activeCommentDraft = activeCommentKey ? fileCommentDrafts[activeCommentKey] : undefined;
  const commentBody = activeCommentDraft?.body ?? defaultCommentBody;
  const commentAnchorHunkId = activeCommentDraft?.anchorHunkId ?? defaultCommentAnchorId;
  const originalCommentHunkId = activeCommentDraft?.originalHunkId ?? mainFileComment?.hunk.id ?? null;
  const setCommentBody = useCallback((body: string) => {
    if (!activeCommentKey || !defaultCommentAnchorId) return;
    setFileCommentDrafts((current) => ({
      ...current,
      [activeCommentKey]: {
        body,
        anchorHunkId: current[activeCommentKey]?.anchorHunkId ?? defaultCommentAnchorId,
        originalHunkId: current[activeCommentKey]?.originalHunkId ?? mainFileComment?.hunk.id ?? null,
        dirty: true,
      },
    }));
    setCommentNotice(null);
  }, [activeCommentKey, defaultCommentAnchorId, mainFileComment?.hunk.id]);

  const scopeOptions = useMemo(() => scopeKeys.map((option) => ({ value: option.value, label: t(option.key) })), [t]);
  const diffModeOptions = useMemo(() => diffModeKeys.map((option) => ({ value: option.value, label: t(option.key) })), [t]);

  const refresh = useCallback(async () => {
    if (!reviewCwd) return;
    const run = ++snapshotRunRef.current;
    setLoading(true);
    setActionError(null);
    try {
      const next = await snapshotRpc({
        cwd: reviewCwd,
        scope,
        ...(scope === "commits" ? { baseRef, headRef } : {}),
        ...(filePath.trim() ? { filePath: filePath.trim() } : {}),
      });
      const nextState = await stateRpc({ targetFingerprint: next.targetFingerprint });
      // A newer refresh or the polling watcher superseded this response
      // (project/workspace switch): never land another target's snapshot.
      if (run !== snapshotRunRef.current) return;
      const previousFingerprint = targetFingerprintRef.current;
      targetFingerprintRef.current = next.targetFingerprint;
      // Keep the previous explanation/AI review visible, but flag it when the
      // Git target changed underneath it (scope, worktree, file, or refs).
      setStale(previousFingerprint !== null && previousFingerprint !== next.targetFingerprint);
      setSnapshot(next);
      setDecisions(nextState.decisions);
      setSelectedHunkId((current) => next.files.flatMap((file) => file.hunks).some((hunk) => hunk.id === current)
        ? current
        : next.files[0]?.hunks[0]?.id ?? null);
    } catch (error) {
      if (run !== snapshotRunRef.current) return;
      setSnapshot(null);
      setDecisions([]);
      setSelectedHunkId(null);
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [baseRef, filePath, headRef, reviewCwd, scope, snapshotRpc, stateRpc]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!reviewCwd || !snapshot) return;
    let active = true;
    const timer = setInterval(async () => {
      try {
        const next = await snapshotRpc({
          cwd: reviewCwd,
          scope,
          ...(scope === "commits" ? { baseRef, headRef } : {}),
          ...(filePath.trim() ? { filePath: filePath.trim() } : {}),
        });
        if (!active || next.targetFingerprint === snapshot.targetFingerprint) return;
        const nextState = await stateRpc({ targetFingerprint: next.targetFingerprint });
        if (!active) return;
        // The watcher just observed newer state: supersede any in-flight
        // manual refresh so its older response cannot overwrite this snapshot.
        snapshotRunRef.current += 1;
        targetFingerprintRef.current = next.targetFingerprint;
        setSnapshot(next);
        setDecisions(nextState.decisions);
        setSelectedHunkId((current) => next.files.flatMap((file) => file.hunks).some((hunk) => hunk.id === current)
          ? current
          : next.files[0]?.hunks[0]?.id ?? null);
        setStale(true);
      } catch {
        // Manual refresh remains available when a transient Git read fails.
      }
    }, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [baseRef, filePath, headRef, reviewCwd, scope, snapshot, snapshotRpc, stateRpc]);

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

  const loadAgents = useCallback(async () => {
    try {
      const result = await paseo.agents.list();
      const matching = result.entries.filter((agent: AgentEntry) =>
        (!agent.status || agent.status === "idle" || agent.status === "running"),
      );
      setAllAgents(matching.map((agent: AgentEntry) => ({
        id: agent.id,
        workspaceId: agent.workspaceId,
        cwd: agent.cwd,
        status: agent.status,
        provider: agent.provider,
        model: agent.model,
        title: agent.title,
      })));
    } catch {
      setAllAgents([]);
    }
  }, [paseo.agents]);
  // Workspace-scoped agents for the single-hunk flows (unchanged semantics).
  const agents = useMemo(() => allAgents
    .filter((agent) => agent.workspaceId === selectedWorkspaceId || agent.cwd === reviewCwd)
    .map(({ id, provider, model, title }): AgentInfo => ({ id, provider, model, title })),
  [allAgents, reviewCwd, selectedWorkspaceId]);
  // Project-scoped processing agents: ONLY idle/running agents of the currently
  // selected workspace (the top workspace selector). Exact workspaceId match
  // wins; agents without a workspace id are admitted only when their cwd is
  // exactly the selected workspace directory. Agents of sibling workspaces
  // that share this project must never appear here.
  const projectAgents = useMemo(() => allAgents
    .filter((agent) => {
      if (agent.workspaceId) return agent.workspaceId === selectedWorkspaceId;
      const cwd = agent.cwd ?? "";
      if (!cwd || !reviewCwd) return false;
      const trim = (value: string) => {
        let out = value;
        while (out.length > 1 && (out.endsWith("/") || out.endsWith("\\"))) out = out.slice(0, -1);
        return out;
      };
      return trim(cwd) === trim(reviewCwd);
    })
    .map(({ id, provider, model, title }): AgentInfo => ({ id, provider, model, title })),
  [allAgents, reviewCwd, selectedWorkspaceId]);
  const projectAgentOptions = useMemo(() => projectAgents.map((agent) => ({
    value: agent.id,
    label: `${agent.title ?? agent.id} · ${agent.provider ?? "?"} / ${agent.model ?? t("noAgentModel")}`,
  })), [projectAgents, t]);
  useEffect(() => {
    setSelectedProcessAgent((current) =>
      projectAgents.some((agent) => agent.id === current) ? current : (projectAgents[0]?.id ?? ""));
  }, [projectAgents]);

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

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  const refreshProjectComments = useCallback(async (projectId: string = effectiveProjectId) => {
    // Bind this request to the project it was started for; a project switch or
    // a newer refresh supersedes it, so stale success/failure never lands.
    const requestId = ++projectCommentsRequestRef.current;
    if (!projectId) {
      setProjectComments(null);
      setProjectCommentsLoading(false);
      setProjectCommentsError(null);
      return;
    }
    setProjectCommentsLoading(true);
    setProjectCommentsError(null);
    try {
      const result = await listProjectCommentsRpc({ projectId });
      if (requestId !== projectCommentsRequestRef.current) return;
      setProjectComments(result.project);
    } catch (error) {
      if (requestId !== projectCommentsRequestRef.current) return;
      setProjectCommentsError(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestId === projectCommentsRequestRef.current) setProjectCommentsLoading(false);
    }
  }, [effectiveProjectId, listProjectCommentsRpc]);

  useEffect(() => {
    // Processing results, notices and loaded comments belong to one project:
    // drop them immediately on switch so project A's comments are never shown
    // while project B loads (the card shows the loading state instead).
    // Invalidate the previous project's request token BEFORE starting the
    // refresh: React runs effects in declaration order, and a cleanup effect
    // declared after the refresh would supersede the fresh token and drop the
    // just-started request. Merging them guarantees the invalidation wins and
    // the refresh (whose own `++projectCommentsRequestRef` binds to the newest
    // token) actually lands.
    projectRunRef.current += 1;
    projectCommentsRequestRef.current += 1;
    setProcessResult(null);
    setProcessError(null);
    setProjectNotice(null);
    setProcessingProject(false);
    setDeletingProcessed(false);
    setProjectComments(null);
    setProjectCommentsError(null);
    setProjectCommentsLoading(false);
    void refreshProjectComments();
  }, [effectiveProjectId, refreshProjectComments]);
  // A workspace switch must never carry the previous workspace's batch run
  // state into the new context: results, errors, notices and in-flight flags
  // belong to the run they were produced in. The project queue itself survives
  // (it is the project's single entry and groups every workspace's comments by
  // target); a stale run of another workspace is refused by the agent binding
  // check in processProject and re-validated on the server.
  useEffect(() => {
    projectRunRef.current += 1;
    setProcessResult(null);
    setProcessError(null);
    setProjectNotice(null);
    setProcessingProject(false);
    setDeletingProcessed(false);
  }, [selectedWorkspaceId]);


  const selectHunk = useCallback((hunkId: string) => {
    // Selecting a hunk discards analysis that belonged to the previous hunk.
    setSelectedHunkId(hunkId);
    setExplanation(null);
    setAiExplanation(null);
    setAgentReview(null);
    setAgentSections(null);
    setStale(false);
    setAgentFeedback({});
    setAiExplainBusy(null);
    setFindingsOpen(false);
    setOtherCommentsOpen(false);
    setCommentNotice(null);
  }, []);

  const markReviewed = useCallback(async () => {
    if (!reviewCwd || !snapshot || !selected || !effectiveProjectId || selectedFileComments.some((comment) => comment.hunk.id === selected.id)) return;
    try {
      const result = await decisionRpc({
        projectId: effectiveProjectId,
        cwd: reviewCwd,
        targetFingerprint: snapshot.targetFingerprint,
        hunkId: selected.id,
        hunkFingerprint: selected.fingerprint,
        filePath: selected.filePath,
        hunkHeader: selected.header,
        hunkPatch: selected.patch,
        decision: "reviewed",
        scope,
        ...(projectIdentity?.displayName ? { projectName: projectIdentity.displayName } : {}),
        ...(projectIdentity?.rootPath ? { projectRootPath: projectIdentity.rootPath } : {}),
        ...(selectedWorkspaceId ? { workspaceId: selectedWorkspaceId } : {}),
        ...(scope === "commits" ? { baseRef, headRef } : {}),
      });
      setDecisions((current) => [
        ...current.filter((decision) => decision.hunkId !== selected.id),
        { hunkId: selected.id, decision: "reviewed", savedAt: result.savedAt },
      ]);
      void refreshProjectComments();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [baseRef, decisionRpc, effectiveProjectId, headRef, projectIdentity, refreshProjectComments, reviewCwd, scope, selected, selectedFileComments, selectedWorkspaceId, snapshot]);

  const saveComment = useCallback(async () => {
    const comment = commentBody.trim();
    if (!reviewCwd || !snapshot || !selected || !activeCommentKey || comment.length === 0 || !effectiveProjectId) return;
    // Browsing another change block never silently rebinds a file comment.
    // The user must either return to its anchor or explicitly arm a move.
    if (commentAnchorHunkId !== selected.id) return;
    setCommentSaving(true);
    setActionError(null);
    setCommentNotice(null);
    try {
      const result = await decisionRpc({
        projectId: effectiveProjectId,
        cwd: reviewCwd,
        targetFingerprint: snapshot.targetFingerprint,
        hunkId: selected.id,
        hunkFingerprint: selected.fingerprint,
        filePath: selected.filePath,
        hunkHeader: selected.header,
        hunkPatch: selected.patch,
        decision: "commented",
        comment,
        scope,
        ...(projectIdentity?.displayName ? { projectName: projectIdentity.displayName } : {}),
        ...(projectIdentity?.rootPath ? { projectRootPath: projectIdentity.rootPath } : {}),
        ...(selectedWorkspaceId ? { workspaceId: selectedWorkspaceId } : {}),
        ...(scope === "commits" ? { baseRef, headRef } : {}),
      });
      // Moving an anchor is an explicit two-step cutover: persist the new exact
      // anchor first, then clear only the old anchored decision. A failed clear
      // leaves both recoverable and is reconciled from persisted state below.
      if (originalCommentHunkId && originalCommentHunkId !== selected.id) {
        await clearHunkRpc({
          targetFingerprint: snapshot.targetFingerprint,
          hunkId: originalCommentHunkId,
        });
      }
      setDecisions((current) => [
        ...current.filter((decision) => decision.hunkId !== selected.id && decision.hunkId !== originalCommentHunkId),
        { hunkId: selected.id, decision: "commented", comment, savedAt: result.savedAt },
      ]);
      setFileCommentDrafts((current) => ({
        ...current,
        [activeCommentKey]: {
          body: comment,
          anchorHunkId: selected.id,
          originalHunkId: selected.id,
          dirty: false,
        },
      }));
      setCommentNotice(t("fileCommentSaved"));
      void refreshProjectComments();
    } catch (error) {
      try {
        const persisted = await stateRpc({ targetFingerprint: snapshot.targetFingerprint });
        setDecisions(persisted.decisions);
      } catch {
        // Keep the recoverable draft when persisted-state reconciliation fails.
      }
      void refreshProjectComments();
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setCommentSaving(false);
    }
  }, [activeCommentKey, baseRef, clearHunkRpc, commentAnchorHunkId, commentBody, decisionRpc, effectiveProjectId, headRef, originalCommentHunkId, projectIdentity, refreshProjectComments, reviewCwd, scope, selected, selectedWorkspaceId, snapshot, stateRpc, t]);

  const clearCurrentHunk = useCallback(async () => {
    if (!snapshot || !selected) return;
    try {
      setActionError(null);
      await clearHunkRpc({ targetFingerprint: snapshot.targetFingerprint, hunkId: selected.id });
      setDecisions((current) => current.filter((decision) => decision.hunkId !== selected.id));
      if (activeCommentKey && (commentAnchorHunkId === selected.id || originalCommentHunkId === selected.id)) {
        setFileCommentDrafts((current) => {
          const next = { ...current };
          delete next[activeCommentKey];
          return next;
        });
        setCommentNotice(null);
      }
      void refreshProjectComments();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [activeCommentKey, clearHunkRpc, commentAnchorHunkId, originalCommentHunkId, refreshProjectComments, selected, snapshot]);

  const clearCurrentReview = useCallback(async () => {
    if (!snapshot) return;
    try {
      setActionError(null);
      await clearReviewRpc({ targetFingerprint: snapshot.targetFingerprint });
      setDecisions([]);
      setFileCommentDrafts((current) => Object.fromEntries(
        Object.entries(current).filter(([key, draft]) =>
          !key.startsWith(`${snapshot.targetFingerprint}\u0000`) || draft.dirty),
      ));
      setCommentNotice(null);
      void refreshProjectComments();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [clearReviewRpc, refreshProjectComments, snapshot]);

  const reloadSavedReviews = useCallback(async () => {
    try {
      const result = await listStatesRpc({});
      setSavedReviews(result.reviews);
      setStateError(null);
    } catch (error) {
      setStateError(error instanceof Error ? error.message : String(error));
    }
  }, [listStatesRpc]);

  const openManage = useCallback(() => {
    setManageOpen(true);
    setConfirmClearAll(false);
    setStateError(null);
    void reloadSavedReviews();
  }, [reloadSavedReviews]);

  const clearSavedTarget = useCallback(async (targetFingerprint: string) => {
    try {
      await clearReviewRpc({ targetFingerprint });
      setSavedReviews((current) => (current ?? []).filter((review) => review.targetFingerprint !== targetFingerprint));
      setFileCommentDrafts((current) => Object.fromEntries(
        Object.entries(current).filter(([key, draft]) =>
          !key.startsWith(`${targetFingerprint}\u0000`) || draft.dirty),
      ));
      if (snapshot?.targetFingerprint === targetFingerprint) {
        setDecisions([]);
        setCommentNotice(null);
      }
      void refreshProjectComments();
    } catch (error) {
      setStateError(error instanceof Error ? error.message : String(error));
    }
  }, [clearReviewRpc, refreshProjectComments, snapshot?.targetFingerprint]);

  const clearAllSaved = useCallback(async () => {
    try {
      await clearAllRpc({});
      setSavedReviews([]);
      setConfirmClearAll(false);
      setStateError(null);
      setDecisions([]);
      setFileCommentDrafts((current) => Object.fromEntries(
        Object.entries(current).filter(([, draft]) => draft.dirty),
      ));
      setCommentNotice(null);
      void refreshProjectComments();
    } catch (error) {
      setStateError(error instanceof Error ? error.message : String(error));
    }
  }, [clearAllRpc, refreshProjectComments]);

  const explainSelected = useCallback(async () => {
    if (!reviewCwd || !selected) return;
    try {
      setActionError(null);
      const result = await explainRpc({
        cwd: reviewCwd,
        scope,
        ...(scope === "commits" ? { baseRef, headRef } : {}),
        ...(filePath.trim() ? { filePath: filePath.trim() } : {}),
        hunkId: selected.id,
      });
      setExplanation(result);
      setFindingsOpen(true);
      setStale(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [baseRef, explainRpc, filePath, headRef, reviewCwd, scope, selected]);
  const explainWithAgent = useCallback(async (agentId: string) => {
    if (!reviewCwd || !selected) return;
    setActionError(null);
    setAiExplainBusy(agentId);
    try {
      const result = await explainHunkAiRpc({
        cwd: reviewCwd,
        scope,
        ...(scope === "commits" ? { baseRef, headRef } : {}),
        ...(filePath.trim() ? { filePath: filePath.trim() } : {}),
        hunkId: selected.id,
        agentId,
      });
      setAiExplanation(result);
      setFindingsOpen(true);
      setStale(false);
      if (result.status !== "idle") setActionError(t("agentFinishedStatus", { status: result.status }));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setAiExplainBusy(null);
    }
  }, [baseRef, explainHunkAiRpc, filePath, headRef, reviewCwd, scope, selected, t]);

  const rejectSelected = useCallback(async () => {
    if (!reviewCwd || !snapshot || !selected) return;
    try {
      setActionError(null);
      await rejectRpc({
        cwd: reviewCwd,
        scope,
        ...(scope === "commits" ? { baseRef, headRef } : {}),
        ...(filePath.trim() ? { filePath: filePath.trim() } : {}),
        expectedTargetFingerprint: snapshot.targetFingerprint,
        hunkId: selected.id,
        expectedHunkFingerprint: selected.fingerprint,
      });
      await refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [baseRef, filePath, headRef, refresh, rejectRpc, reviewCwd, scope, selected, snapshot]);

  const sendRevision = useCallback(async (agentId: string) => {
    if (!selected) return;
    const prompt = explanation?.revisionPrompt ?? [
      `Revise only ${selected.id} in ${selected.filePath}.`,
      `Review snapshot fingerprint: ${snapshot?.targetFingerprint ?? "unknown"}.`,
      `Hunk fingerprint: ${selected.fingerprint}.`,
      "Do not modify unrelated files or hunks.",
      "Stop and report if the current target no longer matches the fingerprint.",
    ].join("\n");
    try {
      setActionError(null);
      await paseo.agents.ref(agentId).send(prompt);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [explanation?.revisionPrompt, paseo.agents, selected, snapshot?.targetFingerprint]);
  const sendFeedbackToAgent = useCallback(async (agent: AgentInfo) => {
    if (!selected || !snapshot) return;
    const comment = commentBody.trim();
    if (!comment) return;
    const diff = `${selected.header}\n${selected.lines.join("\n")}`;
    const prompt = [
      `Revise only ${selected.id} in ${selected.filePath} according to the review feedback below.`,
      `Hunk header: ${selected.header}`,
      `Exact hunk diff:\n${diff}`,
      `Review snapshot fingerprint: ${snapshot.targetFingerprint}.`,
      `Hunk fingerprint: ${selected.fingerprint}.`,
      "Check both fingerprints before modifying; stop and report if they no longer match.",
      "Do not modify unrelated files or hunks.",
      "Do not change code outside this hunk.",
      `Review feedback:\n${comment}`,
    ].join("\n");
    setAgentFeedback((current) => ({ ...current, [agent.id]: { phase: "sending" } }));
    try {
      await paseo.agents.ref(agent.id).send(prompt);
      setAgentFeedback((current) => ({ ...current, [agent.id]: { phase: "sent" } }));
    } catch (error) {
      setAgentFeedback((current) => ({
        ...current,
        [agent.id]: { phase: "error", message: error instanceof Error ? error.message : String(error) },
      }));
    }
  }, [commentBody, paseo.agents, selected, snapshot]);

  const runAgentReview = useCallback(async (agentId: string) => {
    if (!reviewCwd) return;
    try {
      setActionError(null);
      const result = await runReviewRpc({
        cwd: reviewCwd,
        scope,
        ...(scope === "commits" ? { baseRef, headRef } : {}),
        ...(filePath.trim() ? { filePath: filePath.trim() } : {}),
        agentId,
      });
      setAgentReview(result.review);
      setAgentSections(result.sections);
      setFindingsOpen(true);
      setStale(false);
      if (result.status !== "idle") setActionError(t("agentFinishedStatus", { status: result.status }));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [baseRef, filePath, headRef, reviewCwd, runReviewRpc, scope, t]);

  const processProject = useCallback(async () => {
    if (!effectiveProjectId || !selectedProcessAgent) return;
    // The loaded comments must belong to the current project and must be fully
    // loaded; never process another project's list or a still-loading one.
    if (projectComments === null || projectCommentsLoading || projectComments.projectId !== effectiveProjectId) return;
    if (projectComments.commentCount === 0) return;
    if (!reviewCwd) return;
    // The agent must belong to the currently selected workspace; a stale
    // selection (workspace switched underneath the dropdown) is refused here,
    // and the server re-validates the same binding before any run.
    if (!projectAgents.some((agent) => agent.id === selectedProcessAgent)) {
      setProcessError(t("processProjectAgentMismatch"));
      return;
    }
    const run = projectRunRef.current + 1;
    projectRunRef.current = run;
    setProcessingProject(true);
    setProcessError(null);
    setProjectNotice(null);
    setProcessResult(null);
    try {
      const result = await processProjectCommentsRpc({
        projectId: effectiveProjectId,
        agentId: selectedProcessAgent,
        workspaceId: selectedWorkspaceId,
        workspaceCwd: reviewCwd,
      });
      // A project switch or a newer run superseded this one; drop the stale result.
      if (run !== projectRunRef.current) return;
      setProcessResult(result);
      void refreshProjectComments();
    } catch (error) {
      if (run !== projectRunRef.current) return;
      setProcessError(error instanceof Error ? error.message : String(error));
    } finally {
      // Only the run that started the indicator may clear it: a superseded run
      // must not stop the newer run's spinner.
      if (run === projectRunRef.current) setProcessingProject(false);
    }
  }, [effectiveProjectId, processProjectCommentsRpc, projectAgents, projectComments, projectCommentsLoading, refreshProjectComments, reviewCwd, selectedProcessAgent, selectedWorkspaceId, t]);

  const deleteProcessed = useCallback(async () => {
    const run = projectRunRef.current;
    if (!effectiveProjectId || !processResult || processResult.status !== "idle") return;
    // Only comments explicitly completed by the agent are deletable; stale,
    // failed and unresolved ones must survive and stay visible.
    if (processResult.completedCommentIds.length === 0) return;
    setDeletingProcessed(true);
    setProcessError(null);
    setProjectNotice(null);
    try {
      const result = await clearProjectCommentsRpc({
        projectId: effectiveProjectId,
        commentIds: processResult.completedCommentIds,
      });
      if (run !== projectRunRef.current) return;
      setProcessResult(null);
      setProjectNotice(t("processedDeletedNotice", { count: result.cleared }));
      void refreshProjectComments();
    } catch (error) {
      if (run !== projectRunRef.current) return;
      setProcessError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeletingProcessed(false);
    }
  }, [clearProjectCommentsRpc, effectiveProjectId, processResult, refreshProjectComments, t]);
  const editSavedFileComment = useCallback((hunkId: string) => {
    if (!activeCommentKey) return;
    const saved = selectedFileComments.find((comment) => comment.hunk.id === hunkId);
    if (!saved?.decision.comment) return;
    selectHunk(saved.hunk.id);
    setFileCommentDrafts((current) => ({
      ...current,
      [activeCommentKey]: {
        body: saved.decision.comment ?? "",
        anchorHunkId: saved.hunk.id,
        originalHunkId: saved.hunk.id,
        dirty: false,
      },
    }));
  }, [activeCommentKey, selectHunk, selectedFileComments]);

  const moveCommentAnchorToSelected = useCallback(() => {
    if (!activeCommentKey || !selected) return;
    setFileCommentDrafts((current) => ({
      ...current,
      [activeCommentKey]: {
        body: current[activeCommentKey]?.body ?? defaultCommentBody,
        anchorHunkId: selected.id,
        originalHunkId: current[activeCommentKey]?.originalHunkId ?? mainFileComment?.hunk.id ?? null,
        dirty: true,
      },
    }));
    setCommentNotice(null);
  }, [activeCommentKey, defaultCommentBody, mainFileComment?.hunk.id, selected]);

  const openProjectQueue = useCallback(() => {
    setQueueOpen(true);
    void refreshProjectComments();
  }, [refreshProjectComments]);


  const canProcessProject = Boolean(effectiveProjectId) &&
    projectComments !== null &&
    projectComments.projectId === effectiveProjectId &&
    !projectCommentsLoading &&
    projectComments.commentCount > 0 &&
    projectAgents.length > 0 &&
    !processingProject;
  const canDeleteProcessed = processResult !== null &&
    processResult.status === "idle" &&
    processResult.projectId === effectiveProjectId &&
    processResult.completedCommentIds.length > 0 &&
    !deletingProcessed &&
    !processingProject;
  const commentsByTarget = useMemo(() => {
    const targets = new Map<string, {
      cwd: string;
      scope: ReviewScope;
      targetFingerprint: string;
      files: Map<string, { filePath: string; comments: ProjectReviewComment[] }>;
    }>();
    for (const comment of projectComments?.comments ?? []) {
      const targetKey = `${comment.cwd}\u0000${comment.scope}\u0000${comment.targetFingerprint}`;
      const target = targets.get(targetKey) ?? {
        cwd: comment.cwd,
        scope: comment.scope,
        targetFingerprint: comment.targetFingerprint,
        files: new Map<string, { filePath: string; comments: ProjectReviewComment[] }>(),
      };
      const file = target.files.get(comment.filePath) ?? { filePath: comment.filePath, comments: [] };
      file.comments.push(comment);
      target.files.set(comment.filePath, file);
      targets.set(targetKey, target);
    }
    return Array.from(targets.values(), (target) => ({
      ...target,
      files: Array.from(target.files.values()),
    }));
  }, [projectComments]);

  const selectedFindings = selected?.findings ?? [];
  const verifiedFindings = selectedFindings.filter((finding) => finding.evidenceKind === "verified_fact");
  const inferenceFindings = selectedFindings.filter((finding) => finding.evidenceKind === "ai_inference");
  const humanFindings = selectedFindings.filter((finding) => finding.evidenceKind === "human_verification_recommended");
  const agentHasSections = Boolean(
    agentSections &&
    (agentSections.verifiedFacts.length > 0 ||
      agentSections.aiInference.length > 0 ||
      agentSections.humanVerificationRecommended.length > 0),
  );
  const selectedPairs = useMemo(() => (selected ? derivePairs(selected) : []), [selected]);
  const unifiedRows = useMemo(() => deriveUnifiedRows(selectedPairs), [selectedPairs]);
  const effectiveDiffMode: DiffMode = layout.compact ? "unified" : diffMode;
  const selectedMeta = selected
    ? (selected as SelectedHunk & { functionHint?: string; language?: string })
    : null;
  const selectedHeader = selected ? hunkHeaderParts(selected.header) : null;
  const activeWorkspaceName = selectedWorkspaceEntry?.name ?? workspace?.name ?? "";
  const activeWorkspaceStatus = selectedWorkspaceEntry?.status ?? workspace?.status ?? "";
  const statusText = activeWorkspaceStatus
    ? (statusLabelKeys[activeWorkspaceStatus] ? t(statusLabelKeys[activeWorkspaceStatus]) : activeWorkspaceStatus)
    : "";
  const selectedHunkIndex = selectedFile && selected
    ? selectedFile.hunks.findIndex((hunk) => hunk.id === selected.id)
    : -1;
  const commentAnchorHunk = selectedFile?.hunks.find((hunk) => hunk.id === commentAnchorHunkId) ?? null;
  const commentAnchorHeader = commentAnchorHunk ? hunkHeaderParts(commentAnchorHunk.header) : null;
  const activeSavedComment = selectedFileComments.find((comment) => comment.hunk.id === originalCommentHunkId) ?? mainFileComment;
  const otherSavedComments = selectedFileComments.filter((comment) => comment.hunk.id !== activeSavedComment?.hunk.id);
  const commentAnchorIsCurrent = Boolean(selected && commentAnchorHunkId === selected.id);
  const commentAnchorMoveArmed = Boolean(
    selected &&
    originalCommentHunkId &&
    originalCommentHunkId !== selected.id &&
    commentAnchorHunkId === selected.id,
  );
  const currentHunkHasComment = Boolean(selected && selectedFileComments.some((comment) => comment.hunk.id === selected.id));
  const selectedFileSeverity: Severity = selectedFile
    ? severityOrder.find((severity) => selectedFile.hunks.some((hunk) => maxSeverity(hunk) === severity)) ?? "informational"
    : "informational";
  const projectCommentCount = projectComments?.commentCount ?? 0;

  const styles = useMemo(() => {
    const c = theme.colors;
    const compact = layout.compact;
    const space = compact ? 8 : 12;
    const controlHeight = compact ? 40 : 36;
    return {
      root: { flex: 1, backgroundColor: c.surface0 },
      content: { padding: compact ? 8 : 16, gap: space },
      contextBar: {
        gap: 8,
        paddingBottom: 12,
        backgroundColor: c.surface0,
        borderBottomWidth: 1,
        borderBottomColor: withAlpha(c.foregroundMuted, 0.18),
      },
      contextTop: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
      contextActions: { marginLeft: "auto", flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
      contextMeta: { flexDirection: "row", alignItems: "stretch", gap: compact ? 8 : 16, flexWrap: "wrap" },
      contextSelector: { minWidth: compact ? 160 : 220, flexGrow: 1 },
      contextItem: { minWidth: compact ? 120 : 148, gap: 2 },
      contextLabel: { color: c.foregroundMuted, fontSize: 10, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5 },
      contextValue: { color: c.foreground, fontSize: compact ? 11.5 : 12.5, lineHeight: compact ? 16 : 18, fontWeight: "600" },
      title: { color: c.foreground, fontSize: compact ? 19 : 24, lineHeight: compact ? 24 : 30, fontWeight: "800", letterSpacing: -0.3 },
      statusPill: { backgroundColor: withAlpha(c.accent, 0.1), borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
      statusPillDanger: { backgroundColor: withAlpha(c.statusDanger, 0.1) },
      statusPillText: { color: c.accent, fontSize: 10, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.4 },
      statusPillTextDanger: { color: c.statusDanger },
      topButton: {
        minHeight: controlHeight,
        borderWidth: 1,
        borderColor: withAlpha(c.foregroundMuted, 0.3),
        borderRadius: 8,
        paddingHorizontal: compact ? 10 : 12,
        justifyContent: "center",
        alignItems: "center",
      },
      queueButton: { borderColor: withAlpha(c.accent, 0.55), backgroundColor: withAlpha(c.accent, 0.06) },
      topButtonText: { color: c.foregroundMuted, fontSize: 11.5, fontWeight: "600" },
      queueButtonText: { color: c.accent, fontSize: 11.5, fontWeight: "700" },
      staleStrip: { backgroundColor: withAlpha(c.accent, 0.08), borderLeftWidth: 2, borderLeftColor: c.accent, borderRadius: 4, paddingVertical: 8, paddingHorizontal: 10 },
      staleStripText: { color: c.accent, fontSize: 11.5, fontWeight: "600", lineHeight: 16 },
      errorCard: { backgroundColor: withAlpha(c.statusDanger, 0.07), borderWidth: 1, borderColor: withAlpha(c.statusDanger, 0.32), borderRadius: 8, padding: 10 },
      errorText: { color: c.statusDanger, fontSize: 12, lineHeight: 17 },
      workbench: {
        flexDirection: "row",
        alignItems: "stretch",
        borderWidth: 1,
        borderColor: withAlpha(c.foregroundMuted, 0.18),
        borderRadius: 10,
        overflow: "hidden",
        minHeight: 520,
      },
      fileNavigator: {
        width: compact ? "100%" : 304,
        flexShrink: compact ? 1 : 0,
        backgroundColor: withAlpha(c.foreground, 0.018),
        borderRightWidth: compact ? 0 : 1,
        borderRightColor: withAlpha(c.foregroundMuted, 0.18),
      },
      navigatorHeader: { gap: 3, padding: compact ? 12 : 16, borderBottomWidth: 1, borderBottomColor: withAlpha(c.foregroundMuted, 0.16) },
      sectionEyebrow: { color: c.foregroundMuted, fontSize: 10.5, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5 },
      sectionTitle: { color: c.foreground, fontSize: compact ? 14 : 16, lineHeight: compact ? 19 : 22, fontWeight: "700" },
      sectionSummary: { color: c.foregroundMuted, fontSize: 11, lineHeight: 15 },
      fileList: { paddingVertical: 4 },
      fileRow: { minHeight: compact ? 64 : 68, paddingHorizontal: compact ? 12 : 14, paddingVertical: 10, gap: 5, borderBottomWidth: 1, borderBottomColor: withAlpha(c.foregroundMuted, 0.12) },
      fileRowActive: { backgroundColor: withAlpha(c.accent, 0.08), borderLeftWidth: 3, borderLeftColor: c.accent, paddingLeft: compact ? 9 : 11 },
      fileRowTop: { flexDirection: "row", alignItems: "center", gap: 6 },
      filePath: { flex: 1, color: c.foreground, fontSize: compact ? 12.5 : 13, lineHeight: 18, fontWeight: "600" },
      fileMeta: { color: c.foregroundMuted, fontSize: 10.5, lineHeight: 15 },
      fileStatus: { color: c.foregroundMuted, fontSize: 10.5, fontWeight: "600" },
      fileStatusAccent: { color: c.accent },
      detailCanvas: { flex: 1, minWidth: 0, backgroundColor: c.surface0 },
      detailInner: { padding: compact ? 12 : 18, gap: compact ? 12 : 16 },
      backRow: { flexDirection: "row", alignItems: "center", gap: 8 },
      fileHeader: { gap: 6, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: withAlpha(c.foregroundMuted, 0.16) },
      fileHeaderTop: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
      fileHeaderPath: { flex: 1, minWidth: 180, color: c.foreground, fontSize: compact ? 16 : 19, lineHeight: compact ? 22 : 25, fontWeight: "700", letterSpacing: -0.15 },
      tagRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
      tagPill: { fontFamily: "monospace", fontSize: 10, color: c.accent, backgroundColor: withAlpha(c.accent, 0.09), borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, flexShrink: 1, overflow: "hidden" },
      blockToolbar: { gap: 8, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: withAlpha(c.foregroundMuted, 0.14) },
      blockNavigation: { flexDirection: "row", alignItems: "center", gap: 8 },
      blockPosition: { flex: 1, minWidth: 120, alignItems: "center", gap: 2 },
      blockPositionText: { color: c.foreground, fontSize: 12, fontWeight: "700" },
      blockRangeText: { color: c.foregroundMuted, fontFamily: "monospace", fontSize: 10.5 },
      diffHeaderStrip: { backgroundColor: withAlpha(c.accent, 0.07), borderRadius: 6, paddingVertical: 6, paddingHorizontal: 8, flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
      diffHeaderRange: { fontFamily: "monospace", color: c.foreground, fontSize: compact ? 10.5 : 11 },
      diffHeaderContext: { fontFamily: "monospace", color: c.accent, fontSize: compact ? 10.5 : 11, fontWeight: "600" },
      diffBox: { borderWidth: 1, borderColor: withAlpha(c.foregroundMuted, 0.16), borderRadius: 8, overflow: "hidden" },
      diffColHeader: { paddingVertical: 6, paddingHorizontal: 8, backgroundColor: withAlpha(c.foreground, 0.025), borderBottomWidth: 1, borderBottomColor: withAlpha(c.foregroundMuted, 0.16) },
      diffColHeaderText: { color: c.foregroundMuted, fontSize: 9.5, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.6 },
      diffRow: { flexDirection: "row", alignItems: "stretch" },
      diffRowDivider: { borderBottomWidth: 1, borderBottomColor: withAlpha(c.foregroundMuted, 0.07) },
      diffRowAdd: { backgroundColor: withAlpha(c.accent, 0.07) },
      diffRowDel: { backgroundColor: withAlpha(c.statusDanger, 0.07) },
      diffCell: { flex: 1, paddingVertical: 1 },
      diffCellLeft: { borderRightWidth: 1, borderRightColor: withAlpha(c.foregroundMuted, 0.16) },
      diffCellAdd: { backgroundColor: withAlpha(c.accent, 0.08) },
      diffCellDel: { backgroundColor: withAlpha(c.statusDanger, 0.08) },
      diffCellContext: { backgroundColor: withAlpha(c.foreground, 0.015) },
      diffCellEmpty: { backgroundColor: withAlpha(c.foreground, 0.01) },
      diffCellInner: { flexDirection: "row", alignItems: "flex-start" },
      diffLineNo: { fontFamily: "monospace", fontSize: compact ? 9 : 10, color: c.foregroundMuted, width: 38, textAlign: "right", paddingRight: 6, lineHeight: compact ? 15 : 17, paddingTop: 1 },
      diffCode: { fontFamily: "monospace", fontSize: compact ? 10.5 : 11.5, lineHeight: compact ? 15 : 17, color: c.foreground, paddingRight: 6, flexShrink: 1 },
      diffSign: { width: 16, fontFamily: "monospace", fontWeight: "700", fontSize: compact ? 10.5 : 11.5, lineHeight: compact ? 15 : 17, textAlign: "center" },
      diffSignAdd: { color: c.accent },
      diffSignDel: { color: c.statusDanger },
      diffSignContext: { color: c.foregroundMuted },
      actionRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
      secondaryActions: { gap: 10, paddingVertical: 10 },
      body: { color: c.foreground, fontSize: compact ? 12 : 13, lineHeight: compact ? 17 : 19 },
      muted: { color: c.foregroundMuted, fontSize: compact ? 12 : 13, lineHeight: compact ? 17 : 19 },
      label: { color: c.foregroundMuted, fontSize: compact ? 10 : 11, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5 },
      scopeDesc: { color: c.foregroundMuted, fontSize: compact ? 11 : 12, lineHeight: 16 },
      group: { gap: 4 },
      groupLabel: { color: c.foregroundMuted, fontSize: 11, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.4 },
      analysis: { gap: 10 },
      analysisBlock: { gap: 8 },
      findingsDisclosure: { minHeight: controlHeight, flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, borderTopWidth: 1, borderBottomWidth: 1, borderColor: withAlpha(c.foregroundMuted, 0.14) },
      findingsContent: { gap: 10, paddingVertical: 10 },
      analysisStale: { borderLeftWidth: 2, borderLeftColor: c.accent, backgroundColor: withAlpha(c.accent, 0.06), padding: 8 },
      analysisStaleText: { color: c.accent, fontSize: 11.5, fontWeight: "600", lineHeight: 16 },
      bulletRow: { flexDirection: "row", gap: 6, alignItems: "flex-start" },
      bulletDot: { color: c.foregroundMuted, fontSize: 12, lineHeight: 19 },
      bulletContent: { flex: 1, gap: 2 },
      rawReview: { fontFamily: "monospace", fontSize: 11.5, lineHeight: 17, color: c.foreground, borderLeftWidth: 2, borderLeftColor: withAlpha(c.foregroundMuted, 0.32), paddingLeft: 10 },
      reviewDock: { gap: 10, padding: compact ? 12 : 16, backgroundColor: withAlpha(c.accent, 0.045), borderTopWidth: 2, borderTopColor: withAlpha(c.accent, 0.55), borderBottomWidth: 1, borderBottomColor: withAlpha(c.foregroundMuted, 0.14) },
      dockHeader: { flexDirection: "row", alignItems: "flex-start", gap: 8, flexWrap: "wrap" },
      dockTitleWrap: { flex: 1, minWidth: 180, gap: 3 },
      savedBody: { gap: 4, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: withAlpha(c.foregroundMuted, 0.14) },
      inputRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
      input: { minHeight: controlHeight, borderWidth: 1, borderColor: withAlpha(c.foregroundMuted, 0.3), borderRadius: 7, paddingHorizontal: 10, paddingVertical: 8, color: c.foreground, fontSize: compact ? 12 : 13, backgroundColor: withAlpha(c.foreground, 0.02) },
      inputFlex: { flex: 1, minWidth: 140 },
      commentInput: { minHeight: 104, textAlignVertical: "top", paddingTop: 10 },
      anchorRow: { gap: 5, paddingVertical: 4 },
      anchorMeta: { color: c.foregroundMuted, fontFamily: "monospace", fontSize: 10.5, lineHeight: 15 },
      statusText: { color: c.accent, fontSize: 11, lineHeight: 15, fontWeight: "600" },
      otherCommentRow: { gap: 5, paddingVertical: 8, borderTopWidth: 1, borderTopColor: withAlpha(c.foregroundMuted, 0.14) },
      modalBackdrop: { flex: 1, backgroundColor: withAlpha(c.foreground, 0.45) },
      drawerBackdrop: { flex: 1, alignItems: compact ? "stretch" : "flex-end", backgroundColor: withAlpha(c.foreground, 0.45) },
      drawer: { width: "100%", maxWidth: compact ? undefined : 640, height: "100%", backgroundColor: c.surface0, borderLeftWidth: compact ? 0 : 1, borderLeftColor: withAlpha(c.foregroundMuted, 0.22) },
      centeredModalWrap: { flex: 1, justifyContent: "center", alignItems: "center", padding: compact ? 8 : 24, backgroundColor: withAlpha(c.foreground, 0.45) },
      centeredModal: { width: "100%", maxWidth: compact ? undefined : 680, maxHeight: compact ? "96%" : "88%", backgroundColor: c.surface0, borderWidth: 1, borderColor: withAlpha(c.foregroundMuted, 0.22), borderRadius: compact ? 10 : 12, overflow: "hidden" },
      modalHeader: { minHeight: compact ? 52 : 56, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: compact ? 12 : 16, borderBottomWidth: 1, borderBottomColor: withAlpha(c.foregroundMuted, 0.16) },
      modalTitle: { flex: 1, color: c.foreground, fontSize: compact ? 15 : 17, lineHeight: compact ? 20 : 23, fontWeight: "700" },
      modalBody: { padding: compact ? 12 : 16, gap: 16 },
      modalSection: { gap: 10, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: withAlpha(c.foregroundMuted, 0.14) },
      queueIdentity: { gap: 3 },
      queueGroup: { gap: 8, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: withAlpha(c.foregroundMuted, 0.14) },
      queueFile: { gap: 6, paddingTop: 8, paddingLeft: compact ? 8 : 12 },
      queueComment: { gap: 3, paddingLeft: 10, borderLeftWidth: 2, borderLeftColor: withAlpha(c.accent, 0.35) },
      queueOutcome: { gap: 3, paddingVertical: 6 },
      agentRow: { gap: 6, paddingVertical: 10, borderTopWidth: 1, borderTopColor: withAlpha(c.foregroundMuted, 0.14) },
      routeFile: { color: c.foreground, fontSize: compact ? 12 : 12.5, fontWeight: "600" },
      routeMeta: { color: c.foregroundMuted, fontSize: compact ? 10.5 : 11, lineHeight: 15 },
      feedbackSent: { color: c.accent, fontSize: 11, lineHeight: 15, fontWeight: "600" },
      feedbackError: { color: c.statusDanger, fontSize: 11, lineHeight: 15 },
      emptyState: { gap: 8, paddingVertical: 24 },
      loadingTrack: { height: 2, borderRadius: 1, backgroundColor: withAlpha(c.accent, 0.12), overflow: "hidden", width: "60%", alignSelf: "center" },
      loadingFill: { width: "45%", height: 2, borderRadius: 1, backgroundColor: withAlpha(c.accent, 0.55) },
      empty: { color: c.foregroundMuted, fontSize: compact ? 12.5 : 14, paddingVertical: compact ? 16 : 24, textAlign: "center" },
    } as const;
  }, [layout.compact, theme]);

  const renderStringGroup = (label: string, items: readonly string[]) => {
    if (items.length === 0) return null;
    return (
      <View style={styles.group}>
        <Text style={styles.groupLabel}>{label}</Text>
        {items.map((item, index) => (
          <View key={index} style={styles.bulletRow}>
            <Text style={styles.bulletDot}>•</Text>
            <Text style={styles.body}>{item}</Text>
          </View>
        ))}
      </View>
    );
  };

  const renderFindingGroup = (label: string, findings: SelectedHunk["findings"]) => {
    if (findings.length === 0) return null;
    return (
      <View style={styles.group}>
        <Text style={styles.groupLabel}>{label}</Text>
        {findings.map((finding) => (
          <View key={finding.id} style={styles.bulletRow}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: severityColor(finding.severity, theme), marginTop: 6 }} />
            <View style={styles.bulletContent}>
              <Text style={[styles.body, { fontWeight: "600" }]}>{finding.summary}</Text>
              <Text style={styles.muted}>{finding.detail}</Text>
              {finding.suggestedCheck ? <Text style={styles.muted}>{t("checkSuggestion", { check: finding.suggestedCheck })}</Text> : null}
            </View>
          </View>
        ))}
      </View>
    );
  };

  const renderSplitDiff = (pairs: DiffPair[]) => (
    <View style={styles.diffBox}>
      <View style={{ flexDirection: "row" }}>
        <View style={[styles.diffColHeader, styles.diffCellLeft, { flex: 1 }]}>
          <Text style={styles.diffColHeaderText}>{t("diffOld")}</Text>
        </View>
        <View style={[styles.diffColHeader, { flex: 1 }]}>
          <Text style={styles.diffColHeaderText}>{t("diffNew")}</Text>
        </View>
      </View>
      {pairs.map((pair, index) => {
        const last = index === pairs.length - 1;
        return (
          <View key={index} style={[styles.diffRow, last ? null : styles.diffRowDivider]}>
            <View style={[
              styles.diffCell,
              styles.diffCellLeft,
              pair.old === null ? styles.diffCellEmpty : pair.old.kind === "del" ? styles.diffCellDel : pair.old.kind === "add" ? styles.diffCellAdd : styles.diffCellContext,
            ]}>
              {pair.old ? (
                <View style={styles.diffCellInner}>
                  <Text style={styles.diffLineNo}>{pair.old.lineNo}</Text>
                  <Text selectable style={styles.diffCode}>{pair.old.content || "\u00A0"}</Text>
                </View>
              ) : null}
            </View>
            <View style={[
              styles.diffCell,
              pair.new === null ? styles.diffCellEmpty : pair.new.kind === "add" ? styles.diffCellAdd : pair.new.kind === "del" ? styles.diffCellDel : styles.diffCellContext,
            ]}>
              {pair.new ? (
                <View style={styles.diffCellInner}>
                  <Text style={styles.diffLineNo}>{pair.new.lineNo}</Text>
                  <Text selectable style={styles.diffCode}>{pair.new.content || "\u00A0"}</Text>
                </View>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );

  const renderUnifiedDiff = (rows: UnifiedRow[]) => (
    <View style={styles.diffBox}>
      {rows.map((row, index) => (
        <View key={index} style={[
          styles.diffRow,
          index === rows.length - 1 ? null : styles.diffRowDivider,
          row.kind === "add" ? styles.diffRowAdd : row.kind === "del" ? styles.diffRowDel : null,
        ]}>
          <Text style={[styles.diffSign, row.sign === "+" ? styles.diffSignAdd : row.sign === "-" ? styles.diffSignDel : styles.diffSignContext]}>{row.sign}</Text>
          <Text selectable style={styles.diffCode}>{row.content || "\u00A0"}</Text>
        </View>
      ))}
    </View>
  );

  if (!workspace) {
    // No live workspace context for this panel: never fake one. While the list
    // is empty (still loading, or loaded and genuinely empty) show an
    // actionable state instead of a dead-end; once entries are available the
    // full deck below renders the project → workspace dropdowns, and an
    // explicit selection opens the workspace in the Paseo foreground and
    // starts the review against it.
    if (workspaceEntries.length === 0) {
      return (
        <View style={styles.root}>
          <View style={styles.contextBar}>
            <View style={styles.contextTop}>
              <Text style={styles.title}>{t("panelTitle")}</Text>
            </View>
          </View>
          <View style={styles.emptyState}>
            {workspacesLoaded ? (
              <>
                <Text style={styles.empty}>{t("noWorkspacesAvailable")}</Text>
                <ActionButton
                  variant="secondary"
                  label={t("retry")}
                  onPress={() => void loadWorkspaces()}
                  theme={theme}
                  layout={layout}
                />
              </>
            ) : (
              <Text style={styles.empty}>{t("loadingWorkspaces")}</Text>
            )}
          </View>
        </View>
      );
    }
    // Entries are available: fall through to the full deck so the user can pick
    // a project/workspace from the dropdowns above; selection opens it.
  }

  const analysisStale = stale && (explanation !== null || aiExplanation !== null || agentReview !== null);

  const fileNavigator = snapshot ? (
    <View style={styles.fileNavigator}>
      <View style={styles.navigatorHeader}>
        <Text style={styles.sectionEyebrow}>{t("fileNavigator")}</Text>
        <Text style={styles.sectionSummary}>
          {t("fileNavigatorSummary", { files: snapshot.files.length, hunks: snapshot.totalHunks })}
        </Text>
      </View>
      <View style={styles.fileList}>
        {snapshot.files.length === 0 ? (
          <Text style={styles.empty}>{t("noHunksInScope")}</Text>
        ) : snapshot.files.map((file) => {
          const severity = severityOrder.find((candidate) => file.hunks.some((hunk) => maxSeverity(hunk) === candidate)) ?? "informational";
          const savedComments = file.hunks.filter((hunk) => decisions.some((decision) => decision.hunkId === hunk.id && Boolean(decision.comment)));
          const draft = fileCommentDrafts[`${snapshot.targetFingerprint}\u0000${file.path}`];
          const statusKey: StringKey = draft?.dirty
            ? "fileStatusDraft"
            : savedComments.length > 0
              ? "fileStatusSaved"
              : "fileStatusUncommented";
          const statusSymbol = draft?.dirty ? "•" : savedComments.length > 0 ? "✓" : "—";
          const active = selectedFile?.path === file.path;
          return (
            <Pressable
              accessibilityRole="button"
              key={file.path}
              onPress={() => {
                const nextHunk = active ? selected ?? file.hunks[0] : file.hunks[0];
                if (nextHunk) selectHunk(nextHunk.id);
                setCompactFilesOpen(false);
              }}
              style={[styles.fileRow, active ? styles.fileRowActive : null]}
            >
              <View style={styles.fileRowTop}>
                <Text numberOfLines={1} ellipsizeMode="middle" style={styles.filePath}>{file.path}</Text>
                <SeverityBadge severity={severity} label={t(severityLabelKeys[severity])} theme={theme} compact />
              </View>
              <Text style={styles.fileMeta}>
                {t("fileChangeSummary", { hunks: file.hunks.length, additions: file.additions, deletions: file.deletions })}
              </Text>
              <View style={styles.fileRowTop}>
                <Text style={[styles.fileStatus, draft?.dirty || savedComments.length > 0 ? styles.fileStatusAccent : null]}>
                  {statusSymbol} {t(statusKey)}
                </Text>
                {savedComments.length > 1 ? (
                  <Text style={styles.fileMeta}>{t("fileStatusMultiple", { count: savedComments.length })}</Text>
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  ) : null;

  const fileDetail = selected && selectedFile ? (
    <View style={styles.detailCanvas}>
      <View style={styles.detailInner}>
        {layout.compact ? (
          <View style={styles.backRow}>
            <Pressable accessibilityRole="button" onPress={() => setCompactFilesOpen(true)} style={styles.topButton}>
              <Text style={styles.topButtonText}>‹ {t("backToFiles")}</Text>
            </Pressable>
          </View>
        ) : null}

        <View style={styles.fileHeader}>
          <View style={styles.fileHeaderTop}>
            <View style={{ flex: 1, minWidth: 180, gap: 3 }}>
              <Text style={styles.sectionEyebrow}>{t("fileDetail")}</Text>
              <Text selectable numberOfLines={2} ellipsizeMode="middle" style={styles.fileHeaderPath}>{selectedFile.path}</Text>
            </View>
            <SeverityBadge
              severity={selectedFileSeverity}
              label={t(severityLabelKeys[selectedFileSeverity])}
              theme={theme}
              compact={layout.compact}
            />
          </View>
          <Text style={styles.sectionSummary}>
            {t("fileChangeSummary", {
              hunks: selectedFile.hunks.length,
              additions: selectedFile.additions,
              deletions: selectedFile.deletions,
            })}
          </Text>
          {selectedMeta?.functionHint || selectedMeta?.language || selectedFile.language ? (
            <View style={styles.tagRow}>
              {selectedMeta?.language || selectedFile.language ? <Text style={styles.tagPill}>{selectedMeta?.language ?? selectedFile.language}</Text> : null}
              {selectedMeta?.functionHint ? <Text style={styles.tagPill} numberOfLines={1}>{selectedMeta.functionHint}</Text> : null}
            </View>
          ) : null}
        </View>

        <View style={styles.blockToolbar}>
          <View style={styles.fileHeaderTop}>
            <Text style={[styles.sectionEyebrow, { flex: 1 }]}>{t("currentDiff")}</Text>
            {!layout.compact ? (
              <Segmented options={diffModeOptions} value={effectiveDiffMode} onChange={setDiffMode} theme={theme} layout={layout} />
            ) : null}
          </View>
          <View style={styles.blockNavigation}>
            <ActionButton
              variant="ghost"
              label="‹"
              hint={t("previousChangeBlock")}
              disabled={selectedHunkIndex <= 0}
              onPress={() => {
                const previous = selectedFile.hunks[selectedHunkIndex - 1];
                if (previous) selectHunk(previous.id);
              }}
              theme={theme}
              layout={layout}
            />
            <View style={styles.blockPosition}>
              <Text style={styles.blockPositionText}>
                {t("currentChangeBlock", { current: selectedHunkIndex + 1, total: selectedFile.hunks.length })}
              </Text>
              {selectedHeader ? <Text selectable numberOfLines={1} style={styles.blockRangeText}>{selectedHeader.range}</Text> : null}
            </View>
            <ActionButton
              variant="ghost"
              label="›"
              hint={t("nextChangeBlock")}
              disabled={selectedHunkIndex < 0 || selectedHunkIndex >= selectedFile.hunks.length - 1}
              onPress={() => {
                const next = selectedFile.hunks[selectedHunkIndex + 1];
                if (next) selectHunk(next.id);
              }}
              theme={theme}
              layout={layout}
            />
          </View>
          <View style={styles.secondaryActions}>
            <ActionButton
              variant="ghost"
              label={agentsOpen ? t("hideChangeBlockActions") : t("changeBlockActions")}
              onPress={() => setAgentsOpen((open) => !open)}
              theme={theme}
              layout={layout}
            />
            {agentsOpen ? (
              <>
                <View style={styles.actionRow}>
                  <ActionButton
                    variant="secondary"
                    label={t("markReviewed")}
                    hint={currentHunkHasComment ? t("markReviewedUnavailable") : undefined}
                    disabled={currentHunkHasComment}
                    onPress={() => void markReviewed()}
                    theme={theme}
                    layout={layout}
                  />
                  <ActionButton
                    variant="secondary"
                    label={t("explainHunk")}
                    onPress={() => void explainSelected()}
                    theme={theme}
                    layout={layout}
                  />
                  {scope === "working" || scope === "staged" ? (
                    <ActionButton
                      variant="danger"
                      label={t("rejectHunk")}
                      onPress={() => void rejectSelected()}
                      theme={theme}
                      layout={layout}
                    />
                  ) : null}
                </View>
                {agents.length > 0 ? agents.map((agent) => {
                  const feedback = agentFeedback[agent.id] ?? { phase: "idle" as const };
                  return (
                    <View key={agent.id} style={styles.agentRow}>
                      <Text numberOfLines={1} style={styles.routeFile}>{agent.title ?? agent.id}</Text>
                      <Text numberOfLines={1} style={styles.routeMeta}>
                        {agent.provider ?? "?"} · {agent.model ?? t("noAgentModel")}
                      </Text>
                      <View style={styles.actionRow}>
                        <ActionButton
                          variant="secondary"
                          label={aiExplainBusy === agent.id ? t("aiExplaining") : t("aiExplainWithAgent", { agent: agent.title ?? agent.id })}
                          disabled={aiExplainBusy !== null}
                          onPress={() => void explainWithAgent(agent.id)}
                          theme={theme}
                          layout={layout}
                        />
                        <ActionButton
                          variant="ghost"
                          label={t("reviseWithAgent", { agentId: agent.id })}
                          onPress={() => void sendRevision(agent.id)}
                          theme={theme}
                          layout={layout}
                        />
                        <ActionButton
                          variant="ghost"
                          label={feedback.phase === "sending" ? t("sendingFeedback") : t("sendFeedbackToAgent", { agent: agent.title ?? agent.id })}
                          disabled={!commentBody.trim() || !commentAnchorIsCurrent || feedback.phase === "sending"}
                          onPress={() => void sendFeedbackToAgent(agent)}
                          theme={theme}
                          layout={layout}
                        />
                      </View>
                      {feedback.phase === "sent" ? <Text style={styles.feedbackSent}>{t("feedbackSent")}</Text> : null}
                      {feedback.phase === "error" ? <Text style={styles.feedbackError}>{feedback.message ?? t("feedbackSendFailed")}</Text> : null}
                    </View>
                  );
                }) : <Text style={styles.muted}>{t("noAgents")}</Text>}
              </>
            ) : null}
          </View>
          {selectedHeader ? (
            <View style={styles.diffHeaderStrip}>
              <Text selectable style={styles.diffHeaderRange}>{selectedHeader.range}</Text>
              {selectedHeader.context ? <Text selectable style={styles.diffHeaderContext}>{selectedHeader.context}</Text> : null}
            </View>
          ) : null}
        </View>

        {effectiveDiffMode === "split" ? renderSplitDiff(selectedPairs) : renderUnifiedDiff(unifiedRows)}

        <Pressable accessibilityRole="button" onPress={() => setFindingsOpen((open) => !open)} style={styles.findingsDisclosure}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.sectionTitle}>{t("analysis")}</Text>
            <Text style={styles.sectionSummary}>{t("findingsSummary", { count: selectedFindings.length })}</Text>
          </View>
          <Text style={styles.topButtonText}>{findingsOpen ? t("hideFindings") : t("showFindings")} {findingsOpen ? "▴" : "▾"}</Text>
        </Pressable>
        {findingsOpen ? (
          <View style={styles.findingsContent}>
            {analysisStale ? (
              <View style={styles.analysisStale}>
                <Text style={styles.analysisStaleText}>{t("analysisStaleText")}</Text>
              </View>
            ) : null}
            <View style={[styles.analysis, analysisStale ? { opacity: 0.55 } : null]}>
              {selectedFindings.length === 0 ? (
                <Text style={styles.muted}>{t("noFindings")}</Text>
              ) : (
                <>
                  {renderFindingGroup(t("findingsVerified"), verifiedFindings)}
                  {renderFindingGroup(t("findingsInference"), inferenceFindings)}
                  {renderFindingGroup(t("findingsHuman"), humanFindings)}
                </>
              )}
              {explanation ? (
                <View style={styles.analysisBlock}>
                  <Text style={styles.label}>{t("deterministicExplainLabel")}</Text>
                  {renderStringGroup(t("findingsVerified"), explanation.verifiedFacts)}
                  {renderStringGroup(t("findingsInference"), explanation.aiInference)}
                  {renderStringGroup(t("findingsHuman"), explanation.humanVerificationRecommended)}
                  {explanation.verifiedFacts.length === 0 && explanation.aiInference.length === 0 && explanation.humanVerificationRecommended.length === 0 ? (
                    <Text style={styles.muted}>{t("noAdditionalAnalysis")}</Text>
                  ) : null}
                </View>
              ) : null}
              {aiExplanation ? (
                <View style={styles.analysisBlock}>
                  <Text style={styles.label}>{t("aiExplanationLabel", { provider: aiExplanation.provider, model: aiExplanation.model })}</Text>
                  {renderStringGroup(t("findingsVerified"), aiExplanation.verifiedFacts)}
                  {renderStringGroup(t("findingsInference"), aiExplanation.aiInference)}
                  {renderStringGroup(t("findingsHuman"), aiExplanation.humanVerificationRecommended)}
                  {aiExplanation.verifiedFacts.length === 0 && aiExplanation.aiInference.length === 0 && aiExplanation.humanVerificationRecommended.length === 0 ? (
                    <Text style={styles.muted}>{t("noAdditionalAnalysis")}</Text>
                  ) : null}
                </View>
              ) : null}
              {agentReview ? (
                <View style={styles.analysisBlock}>
                  <Text style={styles.label}>{t("aiReview")}</Text>
                  {agentHasSections && agentSections ? (
                    <>
                      {renderStringGroup(t("findingsVerified"), agentSections.verifiedFacts)}
                      {renderStringGroup(t("findingsInference"), agentSections.aiInference)}
                      {renderStringGroup(t("findingsHuman"), agentSections.humanVerificationRecommended)}
                    </>
                  ) : <Text selectable style={styles.rawReview}>{agentReview}</Text>}
                </View>
              ) : null}
              {!explanation && !aiExplanation && !agentReview && selectedFindings.length === 0 ? (
                <Text style={styles.muted}>{t("analysisHint")}</Text>
              ) : null}
            </View>
          </View>
        ) : null}

        <View style={styles.reviewDock}>
          <View style={styles.dockHeader}>
            <View style={styles.dockTitleWrap}>
              <Text style={styles.sectionTitle}>{t("fileCommentTitle")}</Text>
              <Text style={styles.sectionSummary}>{t("fileCommentDesc")}</Text>
            </View>
            <Text style={[styles.fileStatus, activeCommentDraft?.dirty || activeSavedComment ? styles.fileStatusAccent : null]}>
              {activeCommentDraft?.dirty
                ? `• ${t("fileStatusDraft")}`
                : activeSavedComment
                  ? `✓ ${t("fileStatusSaved")}`
                  : `— ${t("fileStatusUncommented")}`}
            </Text>
          </View>

          {activeSavedComment?.decision.comment ? (
            <View style={styles.savedBody}>
              <Text style={styles.label}>{t("fileStatusSaved")}</Text>
              <Text selectable style={styles.body}>{activeSavedComment.decision.comment}</Text>
              <Text style={styles.routeMeta}>{t("fileCommentSavedAt", { savedAt: activeSavedComment.decision.savedAt })}</Text>
              <Text selectable style={styles.anchorMeta}>
                {t("fileCommentAnchor", {
                  anchor: `${activeSavedComment.hunk.id} · ${hunkHeaderParts(activeSavedComment.hunk.header).range}`,
                })}
              </Text>
            </View>
          ) : <Text style={styles.muted}>{t("commentEmptyGuidance")}</Text>}

          <TextInput
            multiline
            value={commentBody}
            onChangeText={setCommentBody}
            placeholder={t("fileCommentPlaceholder")}
            placeholderTextColor={theme.colors.foregroundMuted}
            style={[styles.input, styles.commentInput]}
          />

          <View style={styles.anchorRow}>
            <Text selectable style={styles.anchorMeta}>
              {t("fileCommentAnchor", {
                anchor: commentAnchorHunk
                  ? `${commentAnchorHunk.id} · ${commentAnchorHeader?.range ?? commentAnchorHunk.header}`
                  : selected.id,
              })}
            </Text>
            {commentAnchorIsCurrent ? (
              <Text style={styles.statusText}>
                {commentAnchorMoveArmed ? t("moveCommentAnchorReady") : t("fileCommentAnchorCurrent")}
              </Text>
            ) : (
              <>
                <Text style={styles.muted}>{t("fileCommentAnchorDifferent")}</Text>
                <View style={styles.actionRow}>
                  <ActionButton
                    variant="ghost"
                    label={t("returnToCommentAnchor")}
                    onPress={() => {
                      if (commentAnchorHunkId) selectHunk(commentAnchorHunkId);
                    }}
                    theme={theme}
                    layout={layout}
                  />
                  <ActionButton
                    variant="secondary"
                    label={t("moveCommentAnchor")}
                    onPress={moveCommentAnchorToSelected}
                    theme={theme}
                    layout={layout}
                  />
                </View>
              </>
            )}
          </View>

          {otherSavedComments.length > 0 ? (
            <View style={styles.group}>
              <ActionButton
                variant="ghost"
                label={otherCommentsOpen ? t("hideOtherFileComments") : t("showOtherFileComments")}
                onPress={() => setOtherCommentsOpen((open) => !open)}
                theme={theme}
                layout={layout}
              />
              {otherCommentsOpen ? otherSavedComments.map((comment) => (
                <View key={comment.hunk.id} style={styles.otherCommentRow}>
                  <Text selectable style={styles.body}>{comment.decision.comment}</Text>
                  <Text selectable style={styles.anchorMeta}>
                    {t("fileCommentAnchor", { anchor: `${comment.hunk.id} · ${hunkHeaderParts(comment.hunk.header).range}` })}
                  </Text>
                  <Text style={styles.routeMeta}>{t("fileCommentSavedAt", { savedAt: comment.decision.savedAt })}</Text>
                  <ActionButton
                    variant="ghost"
                    label={t("selectSavedComment")}
                    onPress={() => editSavedFileComment(comment.hunk.id)}
                    theme={theme}
                    layout={layout}
                  />
                </View>
              )) : null}
            </View>
          ) : null}

          <ActionButton
            variant="primary"
            stretch
            disabled={commentSaving || commentBody.trim().length === 0 || !commentAnchorIsCurrent}
            label={commentSaving ? t("savingFileComment") : t("saveFileComment")}
            onPress={() => void saveComment()}
            theme={theme}
            layout={layout}
          />
          {commentNotice ? <Text style={styles.feedbackSent}>✓ {commentNotice}</Text> : null}
        </View>
      </View>
    </View>
  ) : <Text style={styles.empty}>{t("noReviewableHunk")}</Text>;

  return (
    <>
      <ScrollView style={styles.root} contentContainerStyle={styles.content} stickyHeaderIndices={[0]}>
        <View style={styles.contextBar}>
          <View style={styles.contextTop}>
            <Text style={styles.title}>{t("panelTitle")}</Text>
            {activeWorkspaceStatus ? (
              <View style={[styles.statusPill, activeWorkspaceStatus === "failed" ? styles.statusPillDanger : null]}>
                <Text style={[styles.statusPillText, activeWorkspaceStatus === "failed" ? styles.statusPillTextDanger : null]}>{statusText}</Text>
              </View>
            ) : null}
            <View style={styles.contextActions}>
              <Pressable
                accessibilityRole="button"
                onPress={() => setManualLocale(locale === "zh" ? "en" : "zh")}
                style={styles.topButton}
              >
                <Text style={styles.topButtonText}>{t("localeToggleLabel")}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={openProjectQueue} style={[styles.topButton, styles.queueButton]}>
                <Text style={styles.queueButtonText}>{t("queueButton", { count: projectCommentCount })}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={() => setMoreOpen(true)} style={styles.topButton}>
                <Text style={styles.topButtonText}>{t("more")}</Text>
              </Pressable>
            </View>
          </View>
          <View style={styles.contextMeta}>
            {workspaceEntries.length > 0 ? (
              <>
                <View style={styles.contextSelector}>
                  <DropdownSelect
                    label={t("projectLabel")}
                    value={effectiveProjectId}
                    options={projectOptions}
                    onChange={selectProject}
                    placeholder={t("selectProject")}
                    closeLabel={t("closeDropdown")}
                    theme={theme}
                    layout={layout}
                  />
                </View>
                <View style={styles.contextSelector}>
                  <DropdownSelect
                    label={t("workspaceLabel")}
                    value={workspaceValue}
                    options={workspaceOptions}
                    onChange={selectWorkspace}
                    placeholder={t("noWorkspaceOptions")}
                    closeLabel={t("closeDropdown")}
                    theme={theme}
                    layout={layout}
                  />
                </View>
              </>
            ) : (
              <>
                <View style={styles.contextItem}>
                  <Text style={styles.contextLabel}>{t("projectLabel")}</Text>
                  <Text numberOfLines={1} style={styles.contextValue}>
                    {projectIdentity?.displayName ?? effectiveProjectId ?? t("noProjectSelected")}
                  </Text>
                </View>
                <View style={styles.contextItem}>
                  <Text style={styles.contextLabel}>{t("workspaceLabel")}</Text>
                  <Text numberOfLines={1} style={styles.contextValue}>{activeWorkspaceName}</Text>
                </View>
              </>
            )}
            <View style={styles.contextItem}>
              <Text style={styles.contextLabel}>{t("scopeLabel")}</Text>
              <Text style={styles.contextValue}>{t(scopeLabelKeys[scope])}</Text>
            </View>
            <View style={styles.contextItem}>
              <Text style={styles.contextLabel}>{t("contextSnapshot")}</Text>
              <Text style={[styles.contextValue, stale ? { color: theme.colors.accent } : null]}>
                {loading ? t("snapshotRefreshing") : stale ? t("snapshotStale") : t("snapshotCurrent")}
              </Text>
              {snapshot ? <Text numberOfLines={1} style={styles.routeMeta}>{t("snapshotGenerated", { generatedAt: snapshot.generatedAt })}</Text> : null}
            </View>
          </View>
        </View>

        {stale ? (
          <View style={styles.staleStrip}>
            <Text style={styles.staleStripText}>{t("staleBanner")}</Text>
          </View>
        ) : null}
        {actionError ? (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>{actionError}</Text>
          </View>
        ) : null}

        {snapshot ? (
          layout.compact ? (
            compactFilesOpen ? fileNavigator : fileDetail
          ) : (
            <View style={styles.workbench}>
              {fileNavigator}
              {fileDetail}
            </View>
          )
        ) : (
          <View style={styles.emptyState}>
            {loading ? (
              <View style={styles.loadingTrack}>
                <View style={styles.loadingFill} />
              </View>
            ) : null}
            <Text style={styles.empty}>{loading ? t("readingGitState") : reviewCwd ? t("noSnapshot") : t("selectWorkspaceToStart")}</Text>
          </View>
        )}
      </ScrollView>

      <Modal visible={queueOpen} transparent animationType="fade" onRequestClose={() => setQueueOpen(false)}>
        <Pressable style={styles.drawerBackdrop} onPress={() => setQueueOpen(false)}>
          <Pressable onPress={(event) => event.stopPropagation()} style={styles.drawer}>
            <View style={styles.modalHeader}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.modalTitle}>{t("projectCommentsTitle")}</Text>
                <Text style={styles.routeMeta}>
                  {projectComments
                    ? t("projectCommentsSummary", {
                      comments: projectComments.commentCount,
                      files: projectComments.fileCount,
                      targets: projectComments.targetCount,
                    })
                    : t("projectCommentsLoading")}
                </Text>
              </View>
              <Pressable accessibilityRole="button" onPress={() => setQueueOpen(false)} style={styles.topButton}>
                <Text style={styles.topButtonText}>{t("close")}</Text>
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.modalBody}>
              <View style={styles.queueIdentity}>
                <Text selectable numberOfLines={1} style={styles.sectionTitle}>
                  {projectIdentity?.displayName ?? effectiveProjectId ?? t("noProjectSelected")}
                </Text>
                {projectIdentity?.rootPath ? (
                  <Text selectable numberOfLines={1} ellipsizeMode="middle" style={styles.routeMeta}>{projectIdentity.rootPath}</Text>
                ) : null}
              </View>
              <ActionButton
                variant="ghost"
                label={t("projectCommentsRefresh")}
                onPress={() => void refreshProjectComments()}
                theme={theme}
                layout={layout}
              />

              {projectCommentsLoading ? (
                <Text style={styles.muted}>{t("projectCommentsLoading")}</Text>
              ) : projectCommentsError ? (
                <View style={styles.errorCard}><Text style={styles.errorText}>{projectCommentsError}</Text></View>
              ) : !projectComments || projectComments.comments.length === 0 ? (
                <Text style={styles.muted}>{t("projectCommentsEmpty")}</Text>
              ) : (
                <View style={styles.group}>
                  {commentsByTarget.map((target) => (
                    <View
                      key={`${target.cwd}\u0000${target.scope}\u0000${target.targetFingerprint}`}
                      style={styles.queueGroup}
                    >
                      <Text selectable numberOfLines={2} ellipsizeMode="middle" style={styles.routeFile}>
                        {t("queueGroupMeta", { cwd: target.cwd, scope: t(scopeLabelKeys[target.scope]) })}
                      </Text>
                      <Text selectable numberOfLines={1} style={styles.routeMeta}>{target.targetFingerprint.slice(0, 10)}</Text>
                      <View style={styles.group}>
                        {target.files.map((file) => (
                          <View key={file.filePath} style={styles.queueFile}>
                            <View style={styles.fileRowTop}>
                              <Text selectable numberOfLines={2} ellipsizeMode="middle" style={styles.filePath}>{file.filePath}</Text>
                              <Text style={styles.fileMeta}>{t("projectFileComments", { count: file.comments.length })}</Text>
                            </View>
                            {file.comments.map((comment) => (
                              <View key={comment.id} style={styles.queueComment}>
                                <Text selectable numberOfLines={4} style={styles.body}>{comment.comment}</Text>
                                <Text style={styles.routeMeta}>{t("projectCommentSavedAt", { savedAt: comment.savedAt })}</Text>
                              </View>
                            ))}
                          </View>
                        ))}
                      </View>
                    </View>
                  ))}
                </View>
              )}

              <View style={styles.modalSection}>
                <Text style={styles.sectionTitle}>{t("projectAgentLabel")}</Text>
                <Text selectable numberOfLines={2} ellipsizeMode="middle" style={styles.routeMeta}>
                  {t("executionWorkspaceLine", { name: activeWorkspaceName || t("noWorkspaceDirectory"), cwd: reviewCwd ?? "" })}
                </Text>
                {projectAgents.length > 0 ? (
                  <DropdownSelect
                    label={t("projectAgentPlaceholder")}
                    value={selectedProcessAgent}
                    options={projectAgentOptions}
                    onChange={setSelectedProcessAgent}
                    placeholder={t("projectAgentPlaceholder")}
                    closeLabel={t("closeDropdown")}
                    theme={theme}
                    layout={layout}
                  />
                ) : <Text style={styles.muted}>{t("processProjectNoAgentHint")}</Text>}
                <ActionButton
                  variant="primary"
                  stretch
                  disabled={!canProcessProject}
                  label={processingProject ? t("processingProject") : t("processProjectLabel")}
                  onPress={() => void processProject()}
                  theme={theme}
                  layout={layout}
                />
                {!projectComments || projectComments.commentCount === 0 ? (
                  <Text style={styles.scopeDesc}>{t("processProjectNoCommentsHint")}</Text>
                ) : projectAgents.length === 0 ? (
                  <Text style={styles.scopeDesc}>{t("processProjectNoAgentHint")}</Text>
                ) : null}
                {processingProject ? (
                  <Text style={styles.muted}>{t("processingProjectHint", { count: projectComments?.commentCount ?? 0 })}</Text>
                ) : null}
                <Text style={styles.scopeDesc}>{t("queueNextRun")}</Text>
              </View>

              {processError ? <View style={styles.errorCard}><Text style={styles.errorText}>{processError}</Text></View> : null}
              {projectNotice ? <Text style={styles.feedbackSent}>✓ {projectNotice}</Text> : null}
              {processResult ? (
                <View style={styles.analysisBlock}>
                  <Text style={styles.sectionTitle}>{t("processResultTitle")}</Text>
                  {processResult.status !== "idle" ? (
                    <View style={styles.errorCard}>
                      <Text style={styles.errorText}>{t("processResultStatusBad", { status: processResult.status })}</Text>
                    </View>
                  ) : null}
                  <Text style={styles.routeMeta}>
                    {t("processResultProviderModel", { provider: processResult.provider, model: processResult.model })}
                  </Text>
                  <Text selectable numberOfLines={2} ellipsizeMode="middle" style={styles.routeMeta}>
                    {t("executionWorkspaceLine", { name: activeWorkspaceName || t("noWorkspaceDirectory"), cwd: processResult.workspaceCwd })}
                  </Text>
                  <Text selectable style={styles.routeMeta}>{t("executionWorkspaceId", { id: processResult.workspaceId })}</Text>
                  <Text style={styles.routeMeta}>{t("processResultCommentsSent", { count: processResult.commentCount })}</Text>
                  {processResult.commentOutcomes.length > 0 ? (
                    <View style={styles.analysisBlock}>
                      <Text style={styles.label}>{t("processResultOutcomesTitle")}</Text>
                      <Text style={styles.routeMeta}>
                        {t("processResultOutcomeSummary", {
                          completed: processResult.commentOutcomes.filter((outcome) => outcome.status === "completed").length,
                          pending: processResult.commentOutcomes.filter((outcome) => outcome.status !== "completed").length,
                        })}
                      </Text>
                      {processResult.commentOutcomes.map((outcome) => {
                        const completed = outcome.status === "completed";
                        const symbol = completed ? "✓" : outcome.status === "stale" ? "!" : "—";
                        return (
                          <View key={outcome.id} style={styles.queueOutcome}>
                            <Text selectable numberOfLines={2} style={completed ? styles.statusText : styles.errorText}>
                              {symbol} {t("processResultOutcomeLine", {
                                id: outcome.id,
                                status: t(outcomeStatusKeys[outcome.status] ?? "processResultOutcomeUnknown"),
                              })}
                            </Text>
                            {outcome.detail ? <Text selectable style={styles.body}>{outcome.detail}</Text> : null}
                          </View>
                        );
                      })}
                    </View>
                  ) : null}
                  {processResult.sections.verifiedFacts.length > 0 ||
                  processResult.sections.aiInference.length > 0 ||
                  processResult.sections.humanVerificationRecommended.length > 0 ? (
                    <>
                      {renderStringGroup(t("findingsVerified"), processResult.sections.verifiedFacts)}
                      {renderStringGroup(t("findingsInference"), processResult.sections.aiInference)}
                      {renderStringGroup(t("findingsHuman"), processResult.sections.humanVerificationRecommended)}
                    </>
                  ) : <Text selectable style={styles.rawReview}>{processResult.review}</Text>}
                  {canDeleteProcessed ? (
                    <ActionButton
                      variant="danger"
                      disabled={deletingProcessed}
                      label={deletingProcessed ? t("deletingProcessed") : t("deleteProcessedLabel")}
                      hint={t("deleteProcessedHint", { count: processResult.completedCommentIds.length })}
                      onPress={() => void deleteProcessed()}
                      theme={theme}
                      layout={layout}
                    />
                  ) : null}
                </View>
              ) : null}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={moreOpen} transparent animationType="fade" onRequestClose={() => setMoreOpen(false)}>
        <Pressable style={styles.centeredModalWrap} onPress={() => setMoreOpen(false)}>
          <Pressable onPress={(event) => event.stopPropagation()} style={styles.centeredModal}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{t("moreTitle")}</Text>
              <Pressable accessibilityRole="button" onPress={() => setMoreOpen(false)} style={styles.topButton}>
                <Text style={styles.topButtonText}>{t("close")}</Text>
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.modalBody}>
              <View style={styles.modalSection}>
                <Text style={styles.sectionTitle}>{t("moreContextTitle")}</Text>
                <Text style={styles.label}>{t("scopeLabel")}</Text>
                <Segmented options={scopeOptions} value={scope} onChange={setScope} theme={theme} layout={layout} stretch />
                <Text style={styles.scopeDesc}>{t(scopeDescKeys[scope])}</Text>
                <View style={styles.inputRow}>
                  <Text style={styles.label}>{t("path")}</Text>
                  <TextInput
                    value={filePath}
                    onChangeText={setFilePath}
                    placeholder={t("pathPlaceholder")}
                    placeholderTextColor={theme.colors.foregroundMuted}
                    style={[styles.input, styles.inputFlex]}
                  />
                </View>
                {scope === "commits" ? (
                  <View style={styles.inputRow}>
                    <TextInput
                      value={baseRef}
                      onChangeText={setBaseRef}
                      placeholder={t("baseRefPlaceholder")}
                      placeholderTextColor={theme.colors.foregroundMuted}
                      style={[styles.input, styles.inputFlex]}
                    />
                    <TextInput
                      value={headRef}
                      onChangeText={setHeadRef}
                      placeholder={t("headRefPlaceholder")}
                      placeholderTextColor={theme.colors.foregroundMuted}
                      style={[styles.input, styles.inputFlex]}
                    />
                  </View>
                ) : null}
                <ActionButton
                  variant="secondary"
                  label={loading ? t("refreshing") : t("refresh")}
                  onPress={() => void refresh()}
                  theme={theme}
                  layout={layout}
                />
              </View>

              <View style={styles.modalSection}>
                <Text style={styles.sectionTitle}>{t("moreAgentsTitle")}</Text>
                {agents.length > 0 ? agents.map((agent) => (
                  <View key={agent.id} style={styles.agentRow}>
                    <Text numberOfLines={1} style={styles.routeFile}>{agent.title ?? agent.id}</Text>
                    <Text numberOfLines={1} style={styles.routeMeta}>{agent.provider ?? "?"} · {agent.model ?? t("noAgentModel")}</Text>
                    <View style={styles.actionRow}>
                      <ActionButton
                        variant="secondary"
                        label={t("reviewWithAgent", { agentId: agent.id })}
                        onPress={() => {
                          setMoreOpen(false);
                          void runAgentReview(agent.id);
                        }}
                        theme={theme}
                        layout={layout}
                      />
                      {selected ? (
                        <ActionButton
                          variant="ghost"
                          label={t("reviseWithAgent", { agentId: agent.id })}
                          onPress={() => {
                            setMoreOpen(false);
                            void sendRevision(agent.id);
                          }}
                          theme={theme}
                          layout={layout}
                        />
                      ) : null}
                    </View>
                  </View>
                )) : <Text style={styles.muted}>{t("noAgents")}</Text>}
              </View>

              <View style={{ gap: 10 }}>
                <Text style={styles.sectionTitle}>{t("moreSafetyTitle")}</Text>
                <Text style={styles.scopeDesc}>{t("reviewStateDesc")}</Text>
                <Text selectable style={styles.routeMeta}>{t("reviewStateLocation")}</Text>
                <Text style={styles.routeMeta}>
                  {t("reviewStateCurrentSummary", {
                    decisions: decisions.length,
                    comments: decisions.filter((decision) => Boolean(decision.comment)).length,
                  })}
                </Text>
                <View style={styles.actionRow}>
                  <ActionButton
                    variant="danger"
                    label={t("clearCurrentHunk")}
                    disabled={!selected}
                    onPress={() => void clearCurrentHunk()}
                    theme={theme}
                    layout={layout}
                  />
                  <ActionButton
                    variant="danger"
                    label={t("clearCurrentReview")}
                    disabled={!snapshot}
                    onPress={() => void clearCurrentReview()}
                    theme={theme}
                    layout={layout}
                  />
                  <ActionButton
                    variant="ghost"
                    label={t("manageSavedReviews")}
                    onPress={() => {
                      setMoreOpen(false);
                      openManage();
                    }}
                    theme={theme}
                    layout={layout}
                  />
                </View>
              </View>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={manageOpen} transparent animationType="fade" onRequestClose={() => setManageOpen(false)}>
        <Pressable style={styles.centeredModalWrap} onPress={() => setManageOpen(false)}>
          <Pressable onPress={(event) => event.stopPropagation()} style={styles.centeredModal}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{t("savedReviewsTitle")}</Text>
              <Pressable accessibilityRole="button" onPress={() => setManageOpen(false)} style={styles.topButton}>
                <Text style={styles.topButtonText}>{t("close")}</Text>
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.modalBody}>
              <Text selectable style={styles.scopeDesc}>{t("reviewStateLocation")}</Text>
              {stateError ? <View style={styles.errorCard}><Text style={styles.errorText}>{stateError}</Text></View> : null}
              {savedReviews === null ? (
                <Text style={styles.muted}>{t("savedReviewsLoading")}</Text>
              ) : savedReviews.length === 0 ? (
                <Text style={styles.muted}>{t("savedReviewsEmpty")}</Text>
              ) : savedReviews.map((review) => (
                <View key={review.targetFingerprint} style={styles.queueGroup}>
                  <View style={styles.fileRowTop}>
                    <Text selectable numberOfLines={1} style={[styles.diffHeaderRange, { flex: 1 }]}>{review.targetFingerprint.slice(0, 12)}</Text>
                    <ActionButton
                      variant="danger"
                      label={t("clearTarget")}
                      onPress={() => void clearSavedTarget(review.targetFingerprint)}
                      theme={theme}
                      layout={layout}
                    />
                  </View>
                  <Text style={styles.routeMeta} numberOfLines={2}>
                    {review.scope ? t("savedReviewScopeLabel", { scope: t(scopeLabelKeys[review.scope]) }) : ""}
                    {review.cwd ? ` · ${t("savedReviewCwdLabel", { cwd: review.cwd })}` : ""}
                  </Text>
                  <Text style={styles.routeMeta}>
                    {t("savedReviewRowSummary", { decisions: review.decisionCount, comments: review.commentCount })}
                    {` · ${t("savedReviewLastSaved", { savedAt: review.lastSavedAt })}`}
                  </Text>
                </View>
              ))}
              {confirmClearAll ? (
                <View style={styles.errorCard}>
                  <Text style={[styles.errorText, { fontWeight: "700" }]}>{t("confirmClearAllTitle")}</Text>
                  <Text style={styles.muted}>{t("confirmClearAllBody")}</Text>
                  <View style={styles.actionRow}>
                    <ActionButton
                      variant="danger"
                      label={t("confirm")}
                      onPress={() => void clearAllSaved()}
                      theme={theme}
                      layout={layout}
                    />
                    <ActionButton
                      variant="ghost"
                      label={t("cancel")}
                      onPress={() => setConfirmClearAll(false)}
                      theme={theme}
                      layout={layout}
                    />
                  </View>
                </View>
              ) : (
                <ActionButton
                  variant="danger"
                  label={t("clearAllSavedReviews")}
                  hint={t("clearAllSavedReviewsHint")}
                  onPress={() => setConfirmClearAll(true)}
                  theme={theme}
                  layout={layout}
                />
              )}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
