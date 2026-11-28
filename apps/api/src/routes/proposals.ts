import { AppError, ErrorCode } from "@jarvis/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import type { AppEnv } from "../context.js";
import { unwrap, unwrapMaybe } from "../db.js";
import { uuidParam } from "../validation.js";

const COLUMNS = "id, kind, summary, payload, status, result_id, created_at, decided_at";

/**
 * The user's decision on a Sir Libz proposal. Confirming creates the record in
 * one database transaction with the user's current permissions; both outcomes
 * are audited. Sir Libz itself can never call these endpoints.
 */
function decide(confirm: boolean) {
  return async (c: Context<AppEnv>) => {
    const id = uuidParam(c, "proposalId");
    const db = c.get("db");
    await db.rpc("decide_ai_proposal", { p_proposal_id: id, p_confirm: confirm }).then(unwrapMaybe);
    const rows = await db.from("ai_proposals").select(COLUMNS).eq("id", id).limit(1).then(unwrap);
    if (!rows[0]) throw new AppError(ErrorCode.NotFound, "Proposal not found.");
    return c.json({ proposal: rows[0] });
  };
}

export const proposalRoutes = new Hono<AppEnv>()
  .post("/proposals/:proposalId/confirm", decide(true))
  .post("/proposals/:proposalId/dismiss", decide(false));
