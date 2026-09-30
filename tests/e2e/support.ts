import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import { CREDENTIALS_FILE, type E2eAccount } from './global-setup.ts';

export function account(displayName: string): E2eAccount {
  const all = JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8')) as E2eAccount[];
  const found = all.find((a) => a.displayName === displayName);
  if (!found) throw new Error(`no e2e account ${displayName}`);
  return found;
}

/** Username + password; the Master and Admin Technician then get the PIN page. */
export async function signIn(page: Page, who: E2eAccount): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill(who.username);
  await page.getByLabel('Password', { exact: true }).fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (who.pin) {
    await expect(page.getByRole('heading', { name: 'Enter your PIN' })).toBeVisible();
    await page.getByLabel('PIN', { exact: true }).fill(who.pin);
    await page.getByRole('button', { name: 'Sign in' }).click();
  }
}

/** Fails if the page scrolls sideways at the current viewport. */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

let phoneSeq = Date.now() % 100_000;
export function uniquePhone(): string {
  phoneSeq += 1;
  return `96${String(10_000_000 + phoneSeq).slice(-8)}`;
}
