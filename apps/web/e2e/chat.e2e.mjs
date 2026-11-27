/**
 * Browser end-to-end test: sign in, chat (streamed), reload, mobile layout,
 * sign out — with zero console errors (including CSP violations).
 *
 * Needs: local Supabase (`pnpm db:start`), the test API (`pnpm --filter
 * @jarvis/api e2e:server`) and the built web app on :3000. Env:
 * SUPABASE_URL, SUPABASE_SECRET_KEY (to create the test user), WEB_URL.
 */
import assert from "node:assert/strict";
import { chromium, devices } from "playwright";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const WEB = process.env.WEB_URL ?? "http://localhost:3000";
assert.ok(SECRET_KEY, "SUPABASE_SECRET_KEY is required");

const email = `e2e-${Date.now()}@example.com`;
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
    user_metadata: { display_name: "Tester" },
  }),
});
assert.equal(created.status, 200, "create test user");
const userId = (await created.json()).id;

const browser = await chromium.launch();
const problems = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(e.message));

  await page.goto(`${WEB}/app`);
  await page.waitForURL(/\/login\?next=%2Fapp/);

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("alert").waitFor();

  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/app$/);
  await page.getByText("How can I help, Tester?").waitFor();

  await page.getByLabel("Message").fill("First message");
  await page.keyboard.press("Enter");
  await page.getByText('You said: "First message"').waitFor({ timeout: 15_000 });
  await page.getByLabel("Message").fill("Second message");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByText('You said: "Second message"').waitFor({ timeout: 15_000 });

  await page.reload();
  await page.getByRole("button", { name: "First message" }).click();
  await page.getByText('You said: "Second message"').waitFor();
  assert.equal(await page.locator(".msg").count(), 4, "history persists across reloads");

  const mobile = await browser.newContext({
    ...devices["iPhone 13"],
    storageState: await ctx.storageState(),
  });
  const mp = await mobile.newPage();
  mp.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  await mp.goto(`${WEB}/app`);
  await mp.getByRole("button", { name: "Open menu" }).click();
  await mp.getByRole("button", { name: "First message" }).waitFor();
  assert.equal(
    await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
    "no horizontal scroll on mobile",
  );

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(/\/login/);
  await page.goto(`${WEB}/app`);
  await page.waitForURL(/\/login/);

  // Anything other than the deliberate failed sign-in is a bug (e.g. a CSP violation).
  const unexpected = problems.filter((p) => !/400|invalid login/i.test(p));
  assert.deepEqual(unexpected, [], "no console errors");
  console.log("web e2e: all checks passed");
} finally {
  await browser.close();
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: "DELETE",
    headers: adminHeaders,
  });
}
