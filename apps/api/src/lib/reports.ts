import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, ErrorCode } from "@jarvis/shared";
import { unwrap } from "../db.js";

/**
 * Real aggregates for one workspace, computed under the caller's row-level
 * security. Shared by the reports endpoint and Jarvis's pipeline tool so both
 * always report the same numbers.
 */
export async function workspaceSummary(db: SupabaseClient, workspaceId: string) {
  const now = new Date();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const endOfDay = new Date(startOfDay.getTime() + 86_400_000);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();

  const count = async (
    table: string,
    build: (q: ReturnType<typeof base>) => ReturnType<typeof base>,
  ) => {
    const result = await build(base(table));
    if (result.error)
      throw new AppError(ErrorCode.Internal, "Report query failed.", { cause: result.error });
    return result.count ?? 0;
  };
  function base(table: string) {
    return db
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId);
  }

  const [deals, companies, contacts, openTasks, overdueTasks, dueToday, activities7d] =
    await Promise.all([
      db
        .from("deals")
        .select("stage, value, currency, closed_at")
        .eq("workspace_id", workspaceId)
        .limit(10_000)
        .then(unwrap),
      count("companies", (q) => q),
      count("contacts", (q) => q),
      count("tasks", (q) => q.in("status", ["open", "in_progress"])),
      count("tasks", (q) =>
        q.in("status", ["open", "in_progress"]).lt("due_at", startOfDay.toISOString()),
      ),
      count("tasks", (q) =>
        q
          .in("status", ["open", "in_progress"])
          .gte("due_at", startOfDay.toISOString())
          .lt("due_at", endOfDay.toISOString()),
      ),
      count("activities", (q) => q.gte("occurred_at", weekAgo)),
    ]);

  const STAGES = [
    "lead",
    "contacted",
    "qualified",
    "proposal",
    "negotiation",
    "won",
    "lost",
  ] as const;
  const byStage = STAGES.map((stage) => ({
    stage,
    count: 0,
    value: {} as Record<string, number>,
  }));
  const wonThisMonth = { count: 0, value: {} as Record<string, number> };
  let lostThisMonth = 0;
  const openPipeline: Record<string, number> = {};
  for (const d of deals) {
    const amount = Number(d.value);
    const bucket = byStage.find((s) => s.stage === d.stage)!;
    bucket.count += 1;
    bucket.value[d.currency] = (bucket.value[d.currency] ?? 0) + amount;
    if (d.stage !== "won" && d.stage !== "lost") {
      openPipeline[d.currency] = (openPipeline[d.currency] ?? 0) + amount;
    }
    if (d.closed_at && d.closed_at >= startOfMonth) {
      if (d.stage === "won") {
        wonThisMonth.count += 1;
        wonThisMonth.value[d.currency] = (wonThisMonth.value[d.currency] ?? 0) + amount;
      } else if (d.stage === "lost") {
        lostThisMonth += 1;
      }
    }
  }

  return {
    generatedAt: now.toISOString(),
    pipeline: { byStage, open: openPipeline },
    wonThisMonth,
    lostThisMonth,
    tasks: { open: openTasks, overdue: overdueTasks, dueToday },
    counts: { companies, contacts, activitiesLast7Days: activities7d },
    // Revenue figures are derived from won deals only (no invoicing yet).
    revenueBasis: "won_deals" as const,
  };
}
