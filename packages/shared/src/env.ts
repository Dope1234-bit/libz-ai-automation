import type { z } from "zod";

/**
 * Thrown when environment configuration is invalid. The message lists the
 * offending variable *names* and reasons only — never their values — so it is
 * safe to log even when secrets are involved.
 */
export class EnvValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "EnvValidationError";
    this.issues = issues;
  }
}

/**
 * Validate a raw environment record against a Zod schema and return the typed
 * result. Fails fast at boot so misconfiguration never reaches runtime paths.
 */
export function parseEnv<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  source: Record<string, string | undefined>,
): z.infer<TSchema> {
  const result = schema.safeParse(source);
  if (result.success) {
    return result.data as z.infer<TSchema>;
  }
  const issues = result.error.issues.map((issue) => {
    const key = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${key}: ${issue.message}`;
  });
  throw new EnvValidationError(issues);
}
