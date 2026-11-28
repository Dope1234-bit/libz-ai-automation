import { AppError, ErrorCode } from "@jarvis/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { unwrap } from "../db.js";
import { csvToRecords } from "../lib/csv.js";
import { normalizeEmail, normalizePhone } from "../lib/phone.js";
import { workspaceSummary } from "../lib/reports.js";
import { parseBody, uuidParam } from "../validation.js";

const MAX_ROWS = 2000;

/** First non-empty value among several possible header names. */
function pick(record: Record<string, string>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (value) return value;
  }
  return "";
}

const importSchema = z
  .object({
    csv: z.string().min(1).max(900_000),
    dryRun: z.boolean().default(true),
    defaultCountryCode: z
      .string()
      .regex(/^[1-9]\d{0,3}$/)
      .default("263"),
  })
  .strict();

interface PlannedContact {
  row: number;
  full_name: string;
  email: string | null;
  phone_e164: string | null;
  role_title: string | null;
  notes: string | null;
  company: string | null;
}

export const businessRoutes = new Hono<AppEnv>()
  /**
   * Import contacts from the user's own CSV. Dry run (default) only reports what
   * would happen. Rows are validated and normalised; duplicates (in the file or
   * already in the workspace, by email or phone) are skipped. Imported contacts
   * have consent "unknown" — importing is not permission to market to them.
   */
  .post("/workspaces/:workspaceId/import/contacts", async (c) => {
    const workspaceId = uuidParam(c, "workspaceId");
    const { csv, dryRun, defaultCountryCode } = await parseBody(c, importSchema);
    const db = c.get("db");

    // Fail early and clearly for viewers/outsiders even when every row would be skipped.
    if (!dryRun) {
      const membership = await db
        .from("workspace_members")
        .select("role")
        .eq("workspace_id", workspaceId)
        .eq("user_id", c.get("user").id)
        .limit(1)
        .then(unwrap);
      if (!membership[0] || membership[0].role === "viewer") {
        throw new AppError(ErrorCode.Forbidden, "You need member access to import contacts.");
      }
    }

    const { headers, records } = csvToRecords(csv);
    if (!headers.some((h) => ["full_name", "name", "contact_name", "contact"].includes(h))) {
      throw new AppError(ErrorCode.BadRequest, "The CSV needs a name column (name or full_name).");
    }
    if (records.length > MAX_ROWS) {
      throw new AppError(ErrorCode.BadRequest, `Import at most ${MAX_ROWS} rows at a time.`);
    }

    const [existingContacts, existingCompanies] = await Promise.all([
      db
        .from("contacts")
        .select("email, phone_e164")
        .eq("workspace_id", workspaceId)
        .limit(20_000)
        .then(unwrap),
      db
        .from("companies")
        .select("id, name")
        .eq("workspace_id", workspaceId)
        .limit(20_000)
        .then(unwrap),
    ]);
    const seenEmails = new Set(existingContacts.map((r) => r.email).filter(Boolean));
    const seenPhones = new Set(existingContacts.map((r) => r.phone_e164).filter(Boolean));
    const companyIds = new Map(
      existingCompanies.map((r) => [r.name.trim().toLowerCase(), r.id as string]),
    );

    const planned: PlannedContact[] = [];
    const skipped: { row: number; reason: string }[] = [];

    records.forEach((record, index) => {
      const row = index + 2; // 1-based, after the header line
      const fullName = pick(record, ["full_name", "name", "contact_name", "contact"]).slice(0, 200);
      if (!fullName) return skipped.push({ row, reason: "missing name" });

      const rawEmail = pick(record, ["email", "e_mail", "email_address"]);
      const email = rawEmail ? normalizeEmail(rawEmail) : null;
      if (rawEmail && !email) return skipped.push({ row, reason: "invalid email" });

      const rawPhone = pick(record, ["phone", "phone_number", "mobile", "whatsapp", "cell"]);
      const phone = rawPhone ? normalizePhone(rawPhone, defaultCountryCode) : null;
      if (rawPhone && !phone) return skipped.push({ row, reason: "invalid phone number" });

      if ((email && seenEmails.has(email)) || (phone && seenPhones.has(phone))) {
        return skipped.push({ row, reason: "duplicate (same email or phone)" });
      }
      if (email) seenEmails.add(email);
      if (phone) seenPhones.add(phone);

      planned.push({
        row,
        full_name: fullName,
        email,
        phone_e164: phone,
        role_title:
          pick(record, ["role", "title", "role_title", "position", "job_title"]).slice(0, 100) ||
          null,
        notes: pick(record, ["notes", "note", "comments"]).slice(0, 5000) || null,
        company:
          pick(record, [
            "company",
            "company_name",
            "organisation",
            "organization",
            "business",
          ]).slice(0, 200) || null,
      });
    });

    // New companies, first spelling wins for case-insensitive duplicates.
    const newCompanyNames = new Map<string, string>();
    for (const p of planned) {
      const key = p.company?.toLowerCase();
      if (key && !companyIds.has(key) && !newCompanyNames.has(key))
        newCompanyNames.set(key, p.company!);
    }
    const uniqueNewCompanies = [...newCompanyNames.values()];

    if (dryRun) {
      return c.json({
        dryRun: true,
        totalRows: records.length,
        toCreate: planned.length,
        newCompanies: uniqueNewCompanies,
        skipped,
        preview: planned.slice(0, 20),
      });
    }

    if (uniqueNewCompanies.length > 0) {
      const created = await db
        .from("companies")
        .insert(
          uniqueNewCompanies.map((name) => ({ workspace_id: workspaceId, name, source: "import" })),
        )
        .select("id, name")
        .then(unwrap);
      for (const company of created) companyIds.set(company.name.trim().toLowerCase(), company.id);
    }

    let createdContacts = 0;
    for (let i = 0; i < planned.length; i += 500) {
      const batch = planned.slice(i, i + 500).map((p) => ({
        workspace_id: workspaceId,
        full_name: p.full_name,
        email: p.email,
        phone_e164: p.phone_e164,
        role_title: p.role_title,
        notes: p.notes,
        company_id: p.company ? (companyIds.get(p.company.toLowerCase()) ?? null) : null,
      }));
      const inserted = await db.from("contacts").insert(batch).select("id").then(unwrap);
      createdContacts += inserted.length;
    }

    return c.json(
      {
        dryRun: false,
        totalRows: records.length,
        createdContacts,
        createdCompanies: uniqueNewCompanies.length,
        skipped,
      },
      201,
    );
  })

  /** Real aggregates for the business dashboard and reports. */
  .get("/workspaces/:workspaceId/reports/summary", async (c) => {
    const workspaceId = uuidParam(c, "workspaceId");
    return c.json(await workspaceSummary(c.get("db"), workspaceId));
  });
