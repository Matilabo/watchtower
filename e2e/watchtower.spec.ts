import { expect, test, type Page } from '@playwright/test';

/**
 * The journey the app exists for: watch a domain, have a look-alike show up,
 * decide what it is, and still have that decision tomorrow.
 *
 * A short polling interval is requested so the suite spends its time asserting
 * rather than waiting. Everything else is the app exactly as it ships.
 */

const APP = '/?poll=1500';

/** A fixture certificate that is a TLD swap of the domain added below. */
const WATCHED_DOMAIN = 'unrelated-startup.com';
const EXPECTED_MATCH = 'blog.unrelated-startup.dev';

function row(page: Page, name: string) {
  return page.locator('tbody tr').filter({ hasText: name });
}

async function waitForFirstPoll(page: Page): Promise<void> {
  await expect(page.getByRole('status').first()).toContainText(/Updated|just now/, {
    timeout: 20_000,
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto(APP);
  // Each test starts from the shipped seed, not from a previous test's verdicts.
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await waitForFirstPoll(page);
});

test('add a watchlist entry, get a match, triage it, and keep the verdict', async ({ page }) => {
  // --- add ---------------------------------------------------------------
  await page.getByLabel('Domain').fill(WATCHED_DOMAIN);
  await page.getByRole('button', { name: 'Watch domain' }).click();

  await expect(page.getByRole('listitem').filter({ hasText: WATCHED_DOMAIN })).toBeVisible();
  // The field is cleared only once the entry was actually accepted.
  await expect(page.getByLabel('Domain')).toHaveValue('');

  // --- poll returns a match ----------------------------------------------
  const match = row(page, EXPECTED_MATCH);
  await expect(match).toBeVisible({ timeout: 20_000 });
  await expect(match).toContainText(WATCHED_DOMAIN);
  await expect(match).toContainText('Same name, different TLD');

  // --- triage -------------------------------------------------------------
  await match.getByRole('radio', { name: 'Malicious' }).check();
  await expect(match.getByRole('radio', { name: 'Malicious' })).toBeChecked();
  await expect(page.getByText(/marked Malicious/)).toBeAttached();

  // --- persists across a reload ------------------------------------------
  await page.reload();
  await waitForFirstPoll(page);

  const reloaded = row(page, EXPECTED_MATCH);
  await expect(reloaded).toBeVisible();
  await expect(reloaded.getByRole('radio', { name: 'Malicious' })).toBeChecked();

  // And the audit trail survived with it.
  await reloaded.getByRole('button', { name: /Details/ }).click();
  const detail = page.locator('#alert-detail');
  await expect(detail.getByRole('heading', { name: EXPECTED_MATCH })).toBeVisible();
  await expect(detail.locator('.history')).toContainText('Malicious');
});

test('explains every score it shows, and the parts add up', async ({ page }) => {
  const first = page.locator('tbody tr').first();
  await first.getByRole('button', { name: /Details/ }).click();

  const detail = page.locator('#alert-detail');
  await expect(detail.getByRole('heading', { level: 3, name: /Why it scored/ })).toBeVisible();

  const contributions = await detail.locator('.hit .value').allInnerTexts();
  expect(contributions.length).toBeGreaterThan(0);

  const sum = contributions.reduce((total, text) => total + Number(text.replace('+', '')), 0);
  await expect(detail.locator('.total')).toContainText(String(sum));
});

test.describe('accessibility', () => {
  test('states the risk level as text, not only as colour', async ({ page }) => {
    const badge = page.locator('tbody tr').first().locator('.badge');
    await expect(badge).toContainText(/Critical|High|Medium|Low|None|Your certificate/);
    await expect(badge).toContainText('/100');
  });

  test('moves focus to the detail heading only when the user asks for it', async ({ page }) => {
    const heading = page.locator('#alert-detail-heading');

    // Background polling continues throughout; focus stays where it was put.
    await page.getByLabel('Show').focus();
    await page.waitForTimeout(3_500);
    await expect(page.getByLabel('Show')).toBeFocused();

    await page.locator('tbody tr').first().getByRole('button', { name: /Details/ }).click();
    await expect(heading).toBeFocused();
  });

  test('holds new alerts back while the table has focus, then applies them on request', async ({
    page,
  }) => {
    // Stand where a keyboard user reading the table stands.
    await page.locator('tbody tr').first().getByRole('radio', { name: 'New' }).focus();
    const before = await page.locator('tbody tr').count();

    // The fixture source drips new certificates in on later polls.
    const banner = page.locator('.pending');
    await expect(banner).toBeVisible({ timeout: 25_000 });

    // Nothing was inserted under the user while they were reading.
    expect(await page.locator('tbody tr').count()).toBe(before);
    await expect(page.locator('[aria-live="polite"]')).toContainText('Not added to the table yet');

    await banner.getByRole('button', { name: /Show \d+ new/ }).click();
    await expect(page.locator('tbody tr')).not.toHaveCount(before);
    await expect(banner).toBeHidden();
  });

  test('is operable from the keyboard alone', async ({ page }) => {
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to results' })).toBeFocused();

    // Tab into the table and drive the triage radio group with the keyboard.
    const firstRow = page.locator('tbody tr').first();
    await firstRow.getByRole('radio', { name: 'New' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(firstRow.getByRole('radio', { name: 'Investigating' })).toBeChecked();

    await firstRow.getByRole('button', { name: /Details/ }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#alert-detail-heading')).toBeFocused();
  });

  test('reports invalid input on the field that caused it', async ({ page }) => {
    const field = page.getByLabel('Domain');
    await field.fill('not a domain');
    await page.getByRole('button', { name: 'Watch domain' }).click();

    await expect(field).toHaveAttribute('aria-invalid', 'true');
    const describedBy = await field.getAttribute('aria-describedby');
    await expect(page.locator(`#${describedBy}`)).toContainText('not a valid domain name');

    // The entry was not added.
    await expect(page.getByRole('listitem').filter({ hasText: 'not a domain' })).toHaveCount(0);
  });

  test('gives the results table a caption and row headers', async ({ page }) => {
    await expect(page.locator('table caption')).toContainText('highest risk first');
    await expect(page.locator('tbody tr').first().locator('th[scope="row"]')).toBeVisible();
  });
});

test('says how old the data is, and never claims data it does not have', async ({ page }) => {
  const status = page.getByRole('status').first();
  await expect(status).toContainText('Offline fixtures');
  await expect(status).toContainText(/Updated/);

  await page.getByRole('button', { name: /Check now/ }).click();
  await expect(status).toContainText(/Updated/, { timeout: 20_000 });
});

test('does not alert on the user own certificates', async ({ page }) => {
  // northwindbank.com is seeded, and the fixtures include its own certificates.
  await expect(page.locator('tbody tr').filter({ hasText: 'www.northwindbank.com' })).toHaveCount(0);
  await expect(page.locator('tbody tr').filter({ hasText: 'n0rthwindbank.com' })).toHaveCount(1);
});
