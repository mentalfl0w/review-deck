import { z } from "zod";

/** Plugin-owned version-1 timeline item kind: a batch of Review Deck project
 * review comments was handed to the selected workspace Agent's workflow. A
 * timeline row of this kind states only that the submission happened — it
 * never claims the Agent's work completed. */
export const reviewHandoffTimelineKind = "review-deck-handoff";
export const reviewHandoffTimelineVersion = 1;

/** Data payload of a version-1 "review-deck-handoff" timeline item: exactly a
 * positive comment count and the ISO submission timestamp. Deliberately
 * content-minimal — a row never carries review content, file paths, cwd,
 * workspace, project, or agent identifiers. */
export const reviewHandoffTimelineSchema = z
  .object({
    commentCount: z.number().int().positive(),
    submittedAt: z.iso.datetime(),
  })
  .strict();
export type ReviewHandoffTimelineData = z.infer<typeof reviewHandoffTimelineSchema>;
