/**
 * Browser end-to-end test of the Jarvis command centre:
 * sign-in, Command Centre (real data), command bar → streamed chat, Markdown,
 * history across reloads, Personal/Business mode isolation, mobile layout,
 * sign-out — with zero console errors (including CSP violations).
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
const watch = (page) => {
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(e.message));
};

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  watch(page);

  // Protected route redirects to login; a wrong password is rejected.
  await page.goto(`${WEB}/app`);
  await page.waitForURL(/\/login\?next=%2Fapp/);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("alert").waitFor();

  // Sign in lands on the Command Centre with real system data.
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/app$/);
  await page.getByRole("heading", { level: 1, name: /Tester/ }).waitFor();
  await page.getByText("Personal mode · Personal").waitFor();
  await page.getByText("scripted", { exact: false }).first().waitFor(); // AI provider from /system/status
  await page.getByText("No conversations in this workspace yet.").waitFor();

  // The command bar hands the prompt to a streamed chat.
  await page.getByLabel("Ask Jarvis").fill("First message");
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/app\/chat/);
  await page.getByText('You said: "First message"').waitFor({ timeout: 15_000 });
  // Markdown renders as formatting, never as raw asterisks.
  await page.locator(".msg-assistant strong", { hasText: "Jarvis" }).first().waitFor();
  assert.equal(await page.getByText("**Jarvis**").count(), 0, "markdown is rendered");

  await page.getByLabel("Message", { exact: true }).fill("Second message");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText('You said: "Second message"').waitFor({ timeout: 15_000 });
  assert.match(page.url(), /\/app\/chat\/[0-9a-f-]{36}$/, "conversation URL");

  // History persists across a reload.
  await page.reload();
  await page.getByText('You said: "Second message"').waitFor();
  assert.equal(await page.locator(".msg").count(), 4, "history persists across reloads");
  await page.locator(".chat-history").getByRole("link", { name: "First message" }).waitFor();

  // Memory: save a chat message via "Remember", then manage it on the Memory page.
  await page.getByRole("button", { name: "Remember this message" }).first().click();
  await page.getByRole("dialog").getByLabel("Note").fill("I prefer meetings after 10am");
  await page.getByRole("button", { name: "Save memory" }).click();
  await page.getByText("Saved to memory.").waitFor();
  await page.getByRole("link", { name: "Memory" }).first().click();
  await page.waitForURL(/\/app\/memory$/);
  await page.getByText("I prefer meetings after 10am").waitFor();
  await page.getByLabel("Remember…").fill("My sister's name is Rudo");
  await page.getByRole("button", { name: "Save memory" }).click();
  await page.getByText("My sister's name is Rudo").waitFor();
  await page.getByRole("button", { name: "Pin memory" }).first().click();
  await page.getByText("Pinned", { exact: true }).waitFor();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Delete memory" }).last().click();
  await page.getByText("Saved memories · 1").waitFor();

  // Business mode: create the workspace; personal history must not appear there.
  await page.getByRole("link", { name: "Command" }).first().click();
  await page.waitForURL(/\/app$/);
  await page.getByRole("radio", { name: "Business" }).click();
  await page.getByRole("dialog").getByLabel("Business name").fill("Acme Test Business");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await page.getByText("Business mode · Acme Test Business").waitFor();
  await page.getByText("No conversations in this workspace yet.").waitFor();
  await page.getByText("Workspace created").waitFor(); // real audit event
  // Personal memories are not visible in Business mode.
  await page.getByRole("link", { name: "Memory" }).first().click();
  await page.getByText("No memories yet.", { exact: false }).waitFor();
  await page.getByRole("link", { name: "Command" }).first().click();

  // Back to Personal: the personal conversation is there again.
  await page.getByRole("radio", { name: "Personal" }).click();
  await page.getByText("Personal mode · Personal").waitFor();
  await page
    .getByRole("link", { name: /First message/ })
    .first()
    .waitFor();

  // Mobile layout: bottom tabs, history sheet, no horizontal scroll.
  const mobile = await browser.newContext({
    ...devices["iPhone 13"],
    storageState: await ctx.storageState(),
  });
  const mp = await mobile.newPage();
  watch(mp);
  await mp.goto(`${WEB}/app/chat`);
  await mp.locator(".tabbar").getByRole("link", { name: "Command" }).waitFor();
  await mp.getByRole("button", { name: "Open history" }).click();
  await mp.locator(".sheet").getByRole("link", { name: "First message" }).waitFor();
  assert.equal(
    await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
    "no horizontal scroll on mobile",
  );
  await mp.goto(`${WEB}/app`);
  await mp.getByRole("heading", { level: 1, name: /Tester/ }).waitFor();
  assert.equal(
    await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
    "no horizontal scroll on the mobile Command Centre",
  );
  // Panels must fit the screen (scroll containers can hide overflow from the check above).
  assert.deepEqual(
    await mp.evaluate(() =>
      [...document.querySelectorAll(".panel")]
        .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
        .map((el) => el.className),
    ),
    [],
    "every panel fits within the mobile viewport",
  );

  // Sign out re-protects /app.
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
