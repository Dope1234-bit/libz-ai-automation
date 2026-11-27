/**
 * Browser end-to-end test of Business Mode: creating the business workspace,
 * clients, contacts, deals and the pipeline, activity logging, tasks with the
 * overdue badge, CSV import with preview, reports from real aggregates,
 * personal tasks, and the phone layout — with zero console errors.
 *
 * Same prerequisites as chat.e2e.mjs.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, devices } from "playwright";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const WEB = process.env.WEB_URL ?? "http://localhost:3000";
const SHOTS = process.env.SCREENSHOT_DIR; // optional: save screenshots here
assert.ok(SECRET_KEY, "SUPABASE_SECRET_KEY is required");

const email = `biz-${Date.now()}@example.com`;
const password = `E2e-${crypto.randomUUID()}!aA1`;
const adminHeaders = {
  apikey: SECRET_KEY,
  Authorization: `Bearer ${SECRET_KEY}`,
  "Content-Type": "application/json",
};
const created = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
  method: "POST",
  headers: adminHeaders,
  body: JSON.stringify({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: "Denzel" },
  }),
});
assert.equal(created.status, 200, "create test user");
const userId = (await created.json()).id;

const browser = await chromium.launch();
const problems = [];
const watch = (page) => {
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(e.message));
};
const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
};

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  watch(page);

  await page.goto(`${WEB}/app`);
  await page.waitForURL(/\/login/);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("heading", { level: 1, name: /Denzel/ }).waitFor();

  // Personal mode: tasks work, CRM sections are not in the navigation.
  const rail = page.locator(".rail");
  assert.equal(
    await rail.getByRole("link", { name: "Clients" }).count(),
    0,
    "no Clients in Personal",
  );
  await rail.getByRole("link", { name: "Tasks" }).click();
  await page.getByRole("heading", { level: 1, name: "Tasks" }).waitFor();
  await page.getByLabel("New task").fill("Renew passport");
  await page.getByRole("button", { name: "Add task" }).click();
  await page.getByText("Renew passport").waitFor();

  // Business-only page offers to create the business workspace.
  await page.goto(`${WEB}/app/clients`);
  await page.getByRole("button", { name: "Create business workspace" }).click();
  await page.getByRole("heading", { level: 1, name: "Clients" }).waitFor();
  await page.getByText("No clients yet.", { exact: false }).waitFor();
  assert.equal(await page.getByText("Renew passport").count(), 0);

  // Add a client with a local phone number (normalised to E.164).
  await page.getByRole("button", { name: "Add client" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Company name").fill("Moyo Hardware");
  await dialog.getByLabel("Industry").fill("Retail");
  await dialog.getByLabel("Phone").fill("0772 123 456");
  await dialog.getByRole("button", { name: "Save client" }).click();
  await page.getByText("1 client").waitFor();
  await page.getByText("Retail · +263772123456").waitFor();
  await page.getByRole("link", { name: /Moyo Hardware/ }).click();
  await page.getByRole("heading", { level: 1, name: "Moyo Hardware" }).waitFor();

  // Contact, deal, task, logged call.
  await page.getByRole("button", { name: "Contact" }).click();
  await dialog.getByLabel("Full name").fill("Tendai Moyo");
  await dialog.getByLabel("Phone").fill("+263 77 212 3456");
  await dialog.getByRole("button", { name: "Save contact" }).click();
  await page.getByText("Contacts · 1").waitFor();

  await page.getByRole("button", { name: "Deal" }).click();
  await dialog.getByLabel("Deal").fill("WhatsApp booking bot");
  await dialog.getByLabel("Value").fill("1200");
  await dialog.getByRole("button", { name: "Save deal" }).click();
  await page.getByText("WhatsApp booking bot").waitFor();

  await page.getByRole("button", { name: "Task" }).click();
  await dialog.getByLabel("Task").fill("Send proposal to Moyo");
  const yesterday = new Date(Date.now() - 86_400_000 * 2);
  const local = new Date(yesterday.getTime() - yesterday.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
  await dialog.getByLabel("Due").fill(local);
  await dialog.getByRole("button", { name: "Add task" }).click();
  await page.getByText("Send proposal to Moyo").waitFor();
  await page
    .getByText(/Overdue ·/)
    .first()
    .waitFor();

  await page.getByRole("button", { name: "Log call / note" }).click();
  await dialog.getByLabel("With").selectOption({ label: "Tendai Moyo" });
  await dialog.getByLabel("Summary").fill("Discussed booking bot; wants a quote by Friday.");
  await dialog.getByRole("button", { name: "Save" }).click();
  await page.getByText("Discussed booking bot; wants a quote by Friday.").waitFor();
  await page.getByText("Call · outbound").waitFor();
  await shot(page, "desktop-client");

  // Overdue badge on Tasks reflects the real overdue task.
  await rail.getByRole("link", { name: /Tasks/ }).getByText("1").waitFor();

  // Pipeline: move the deal to Won.
  await rail.getByRole("link", { name: "Pipeline" }).click();
  await page.getByText("1 open deal", { exact: false }).waitFor();
  await page.getByLabel("Move WhatsApp booking bot to stage").selectOption("won");
  await page.getByText("0 open deals", { exact: false }).waitFor();
  await shot(page, "desktop-pipeline");

  // Reports from real aggregates.
  await rail.getByRole("link", { name: "Reports" }).click();
  await page.getByText("1 deal · 0 lost").waitFor();
  await page.getByText("1 overdue · 0 due today").waitFor();
  await shot(page, "desktop-reports");

  // Command Centre shows business panels.
  await rail.getByRole("link", { name: "Command" }).click();
  await page.locator("#pipeline-title").waitFor();
  await page.getByText("Send proposal to Moyo").waitFor();
  await shot(page, "desktop-command");

  // CSV import with preview; duplicates and bad rows are skipped.
  const csvPath = join(tmpdir(), `contacts-${Date.now()}.csv`);
  writeFileSync(
    csvPath,
    [
      "Name,Company,Phone,Email",
      "Chipo Ncube,Ncube Logistics,0712 345 678,chipo@ncube.co.zw",
      "Tendai Again,,+263772123456,",
      "Bad Number,,12,",
    ].join("\n"),
  );
  await rail.getByRole("link", { name: "Clients" }).click();
  await page.getByRole("button", { name: "Import CSV" }).click();
  await dialog.getByLabel("CSV file").setInputFiles(csvPath);
  await dialog.getByRole("button", { name: "Preview" }).click();
  await dialog.getByText("3 rows → 1 new contact, 1 new company", { exact: false }).waitFor();
  await dialog.getByText("2 row(s) will be skipped").waitFor();
  await dialog.getByRole("button", { name: "Import 1" }).click();
  await dialog.getByText("Imported 1 contact and 1 new company.", { exact: false }).waitFor();
  await dialog.getByRole("button", { name: "Done" }).click();
  await page.getByText("2 clients").waitFor();

  // Completing the task clears the overdue badge.
  await rail.getByRole("link", { name: /Tasks/ }).click();
  await page.getByRole("button", { name: "Complete “Send proposal to Moyo”" }).click();
  await page.getByText("No open tasks.", { exact: false }).waitFor();
  await page.locator(".rail .nav-badge").waitFor({ state: "detached" });

  // Phone layout.
  const mctx = await browser.newContext({
    ...devices["iPhone 13"],
    storageState: await ctx.storageState(),
  });
  const mp = await mctx.newPage();
  watch(mp);
  for (const path of [
    "/app",
    "/app/clients",
    "/app/pipeline",
    "/app/tasks",
    "/app/reports",
    "/app/projects",
    "/app/more",
  ]) {
    await mp.goto(`${WEB}${path}`);
    await mp.locator(".tabbar").getByRole("link", { name: "More" }).waitFor();
    await mp.locator("h1").first().waitFor();
    await mp.waitForTimeout(400);
    assert.equal(
      await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      false,
      `no horizontal scroll on ${path}`,
    );
    assert.deepEqual(
      await mp.evaluate(() =>
        [...document.querySelectorAll(".panel, .board-col.is-current, .segmented")]
          .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
          .map((el) => el.className),
      ),
      [],
      `everything fits on ${path}`,
    );
  }
  await mp.goto(`${WEB}/app/pipeline`);
  await mp.getByRole("tab", { name: /Won/ }).click();
  await mp.getByText("WhatsApp booking bot", { exact: true }).waitFor();
  await shot(mp, "phone-pipeline");
  await mp.goto(`${WEB}/app/clients`);
  await mp.getByText("2 clients").waitFor();
  await mp.getByRole("button", { name: "Add client" }).click();
  await mp.getByRole("dialog").getByLabel("Company name").waitFor();
  await shot(mp, "phone-add-client");
  await mp.getByRole("button", { name: "Close" }).click();
  await mp.goto(`${WEB}/app/more`);
  await mp.locator(".more-list").getByRole("link", { name: "Reports" }).click();
  await mp.getByRole("heading", { level: 1, name: "Reports" }).waitFor();
  await shot(mp, "phone-reports");
  await mctx.close();

  assert.deepEqual(problems, [], "no console errors");
  console.log("business e2e: all checks passed");
} finally {
  await browser.close();
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: "DELETE",
    headers: adminHeaders,
  });
}
