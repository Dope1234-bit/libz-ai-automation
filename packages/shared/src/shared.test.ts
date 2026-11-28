import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AppError,
  EnvValidationError,
  ErrorCode,
  parseEnv,
  roleAtLeast,
  toErrorBody,
} from "./index.js";

describe("parseEnv", () => {
  const schema = z.object({
    PORT: z.coerce.number().int().positive(),
    SECRET_KEY: z.string().min(32),
  });

  it("returns typed values for a valid environment", () => {
    const env = parseEnv(schema, { PORT: "8080", SECRET_KEY: "x".repeat(32) });
    expect(env.PORT).toBe(8080);
  });

  it("reports variable names but never leaks values", () => {
    const leaked = "super-secret-short";
    try {
      parseEnv(schema, { PORT: "nope", SECRET_KEY: leaked });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      const message = (err as Error).message;
      expect(message).toContain("PORT");
      expect(message).toContain("SECRET_KEY");
      expect(message).not.toContain(leaked);
    }
  });
});

describe("toErrorBody", () => {
  it("maps AppError to its status and code", () => {
    const { status, body } = toErrorBody(new AppError(ErrorCode.Forbidden, "No access"), "req-1");
    expect(status).toBe(403);
    expect(body.error).toEqual({ code: "forbidden", message: "No access", requestId: "req-1" });
  });

  it("hides details of unknown errors", () => {
    const { status, body } = toErrorBody(new Error("db password is hunter2"));
    expect(status).toBe(500);
    expect(body.error.code).toBe("internal_error");
    expect(body.error.message).not.toContain("hunter2");
  });
});

describe("roleAtLeast", () => {
  it("orders roles from owner down to viewer", () => {
    expect(roleAtLeast("owner", "admin")).toBe(true);
    expect(roleAtLeast("admin", "admin")).toBe(true);
    expect(roleAtLeast("member", "admin")).toBe(false);
    expect(roleAtLeast("viewer", "member")).toBe(false);
  });
});
