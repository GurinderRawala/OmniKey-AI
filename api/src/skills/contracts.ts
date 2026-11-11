/** Skills v1: backend-owned, user-level, runtime-only guidance. */
export const SKILL_LIMITS = Object.freeze({
  saved: 100,
  active: 8,
  nameCodePoints: 80,
  keywordCodePoints: 80,
  instructionCodePoints: 8_000,
  instructionBytes: 32_768,
  aggregateInstructionCodePoints: 16_000,
  previewInputCodePoints: 100_000,
  previewInputBytes: 400_000,
});
export interface AppliedSkillRef {
  id: string;
  name: string;
  keyword: string;
  revision: number;
}
export interface SkillDTO extends AppliedSkillRef {
  instructions: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
export type SkillSummary = Omit<SkillDTO, 'instructions'>;
export type SkillSnapshot = Readonly<AppliedSkillRef & { instructions: string }>;
export interface SkillCreateInput {
  name: string;
  keyword: string;
  instructions: string;
  enabled?: boolean;
}
export type SkillUpdateInput = Partial<SkillCreateInput>;
export type SkillErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'KEYWORD_CONFLICT'
  | 'REVISION_CONFLICT'
  | 'REVISION_REQUIRED'
  | 'SKILL_QUOTA_EXCEEDED'
  | 'INPUT_LIMIT_EXCEEDED'
  | 'ACTIVE_LIMIT_EXCEEDED'
  | 'CONTEXT_LIMIT_EXCEEDED'
  | 'STORE_UNAVAILABLE'
  | 'INTERNAL_ERROR';
export interface SkillErrorBody {
  error: { code: SkillErrorCode; message: string; fields?: Record<string, string> };
}
export interface SkillWarning {
  code: 'INVALID_SKILL';
  skillId?: string;
  message: string;
}
export interface SkillMatchResult {
  matches: readonly SkillSnapshot[];
  warnings: readonly SkillWarning[];
}
export interface SkillMatchPreview {
  matches: AppliedSkillRef[];
  warnings: SkillWarning[];
}
export interface SkillStore {
  listEnabled(subscriptionId: string): Promise<SkillMatchResult>;
}
export interface SkillStatus {
  input_id: string;
  status: 'applied' | 'warning' | 'blocked';
  skills: AppliedSkillRef[];
  warnings: SkillWarning[];
  /** Present only for blocked inputs. No instruction text or raw storage errors. */
  error?: SkillErrorBody['error'];
}
export interface SkillStatusNotice {
  is_terminal_output: false;
  is_error: false;
  session_id: string;
  sender: 'agent';
  content: string;
  skill_status: SkillStatus;
}

/** All-or-nothing failure; never includes raw storage errors or skill instructions. */
export class SkillError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: SkillErrorCode,
    message: string,
    public readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'SkillError';
  }
}
export type MatchSkills = (
  rawText: string,
  snapshots: readonly SkillSnapshot[],
) => SkillMatchResult;
export type ResolveSkillsForInput = (
  subscriptionId: string,
  rawText: string,
) => Promise<SkillMatchResult>;
