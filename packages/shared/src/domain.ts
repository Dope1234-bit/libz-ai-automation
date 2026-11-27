/** Core domain vocabulary shared by every app. Kept in sync with the database. */

export const WORKSPACE_TYPES = ["personal", "business"] as const;
export type WorkspaceType = (typeof WORKSPACE_TYPES)[number];

/** Ordered from most to least privileged. */
export const WORKSPACE_ROLES = ["owner", "admin", "member", "viewer"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** True when `role` grants at least the privileges of `required`. */
export function roleAtLeast(role: WorkspaceRole, required: WorkspaceRole): boolean {
  return WORKSPACE_ROLES.indexOf(role) <= WORKSPACE_ROLES.indexOf(required);
}

/** Risk classification every tool must declare; drives the policy engine. */
export const TOOL_RISK_LEVELS = [
  "read",
  "write",
  "external_communication",
  "financial",
  "destructive",
] as const;
export type ToolRiskLevel = (typeof TOOL_RISK_LEVELS)[number];

export const POLICY_MODES = ["allow", "ask", "deny"] as const;
export type PolicyMode = (typeof POLICY_MODES)[number];
