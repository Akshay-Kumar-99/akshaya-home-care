import { expect, test } from '@playwright/test';
import { account, expectNoHorizontalScroll, signIn, uniquePhone } from './support.ts';

// The Master on desktop Chrome/Edge at 1366×768: rail shell, business dashboard, Copy invoice,
// invoice list with profit, void, and the Team panel.

const shots = (name: string) => ({ path: `test-results/screens/desktop-${name}.png`, fullPage: true });

test('Master: dashboard, Copy invoice, invoice list with profit, and void', async ({ page }) => {
  const master = account('Master');
  await signIn(page, master);
  await expect(page.getByRole('heading', { name: 'Business dashboard' })).toBeVisible();
  await expectNoHorizontalScroll(page);

  // Copy invoice for the Master's own job: first the phone, then the invoice (no chat pop-up).
  const phone = uniquePhone();
  const name = `Desk ${phone.slice(-4)}`;
  await page.getByRole('button', { name: 'New Invoice' }).click();
  await page.getByLabel('Customer phone').fill(phone);
  await page.getByLabel('Customer name').fill(name);
  await page.getByLabel('Area').fill('Besant Nagar');
  await page.getByRole('radio', { name: 'Refrigerator' }).click();
  await page.getByLabel('Service done').fill('Compressor replacement');
  await page.getByLabel('Total (₹)').fill('5400');
  await page.getByLabel('Spare cost (₹)').fill('3100');
  await page.getByRole('radio', { name: 'Cash' }).click();
  await page.getByRole('button', { name: 'Copy phone', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(phone);
  await page.getByRole('button', { name: 'Copy invoice' }).click();
  await expect(page.getByRole('status').filter({ hasText: /INV-\d+ copied\. Paste it in the customer's WhatsApp\./ })).toBeVisible();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain('Invoice Total: ₹5,400.00');

  // The dashboard picks it up: sales, revenue by customer (by phone) and by area.
  await page.keyboard.press('Alt+1');
  await expect(page.getByRole('heading', { name: 'Business dashboard' })).toBeVisible();
  await expect(page.locator('.kpi-hero .kpi-value')).not.toHaveText('₹0');
  await expect(page.locator('.dash-card', { hasText: 'Revenue by customer' }).getByText(name)).toBeVisible();
  await expect(page.locator('.dash-card', { hasText: 'Revenue by area' }).getByText('Besant Nagar')).toBeVisible();
  await page.getByRole('img', { name: 'Sales vs expense' }).focus();
  await expect(page.locator('.tooltip')).toBeVisible();
  await page.screenshot(shots('01-dashboard'));
  await page.locator('.dash-card', { hasText: 'Revenue by customer' }).getByText(name).click();
  await expect(page.getByRole('dialog', { name })).toContainText('Lifetime sales');
  await page.screenshot(shots('02-customer-history'));
  await page.keyboard.press('Escape');

  // Invoice table shows spare cost, gross profit and the self-issued flag.
  await page.keyboard.press('Alt+4');
  await expect(page.getByRole('heading', { name: 'All Invoices' })).toBeVisible();
  const row = page.locator('tbody tr', { hasText: name });
  await expect(row.getByText('₹2,300.00', { exact: true })).toBeVisible(); // 5,400 − 3,100
  await expect(row.getByText('Self-issued')).toBeVisible();

  // Date filter: Today shows it, Yesterday doesn't, a custom range that includes today does.
  const dateFilters = page.getByRole('radiogroup', { name: 'Filter by date' });
  await dateFilters.getByRole('radio', { name: 'Today' }).click();
  await expect(page.locator('tbody tr', { hasText: name })).toBeVisible();
  await dateFilters.getByRole('radio', { name: 'Yesterday' }).click();
  await expect(page.getByText('No invoices match')).toBeVisible();
  await dateFilters.getByRole('radio', { name: 'Date range' }).click();
  const today = await page.evaluate(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()));
  await page.getByLabel('From').fill(today);
  await page.getByLabel('To').fill(today);
  await expect(page.locator('tbody tr', { hasText: name })).toBeVisible();
  await page.screenshot(shots('03-invoices'));
  await dateFilters.getByRole('radio', { name: 'All dates' }).click();

  // Detail and void. The PIN was entered at sign-in moments ago, so no step-up prompt here;
  // the server-side step-up window is covered by tests/integration/workflow.test.ts.
  await row.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('pre')).toContainText('Invoice Total: ₹5,400.00');
  await dialog.getByRole('button', { name: 'Void invoice' }).click();
  await dialog.getByLabel('Reason for voiding').fill('Entered for the wrong customer');
  await dialog.getByRole('button', { name: 'Void invoice' }).last().click();
  await expect(page.locator('tbody tr', { hasText: name }).locator('.pill-void')).toBeVisible();

  // Top-bar search jumps to the filtered invoice list.
  await page.keyboard.press('Alt+1');
  await page.keyboard.press('/');
  await page.keyboard.type(name);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'All Invoices' })).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expectNoHorizontalScroll(page);
});

test('Master: Team panel adds an Invoice + Work technician', async ({ page }) => {
  await signIn(page, account('Master'));
  await expect(page.getByRole('heading', { name: 'Business dashboard' })).toBeVisible();
  await page.keyboard.press('Alt+7');
  await expect(page.getByRole('heading', { name: 'Team' })).toBeVisible();
  await expect(page.locator('article', { hasText: 'Technician 2' }).getByText('Invoice + Work allocation')).toBeVisible();
  await expect(page.locator('article', { hasText: 'Technician 1' }).getByText('Invoice only')).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.screenshot(shots('04-team'));

  const username = `karthik-${Date.now() % 100_000}`;
  await page.getByRole('button', { name: 'Add user' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a user' });
  await dialog.getByLabel('Name', { exact: true }).fill('Karthik');
  await dialog.getByLabel('Username', { exact: true }).fill(username);
  await dialog.getByRole('radio', { name: 'Technician', exact: true }).click();
  await dialog.getByRole('button', { name: 'Generate' }).click();
  // A technician must be given a type before the account can be created.
  await dialog.getByRole('button', { name: 'Create user' }).click();
  await expect(dialog.getByText('Choose Invoice only or Invoice + Work allocation.')).toBeVisible();
  await dialog.getByRole('radio', { name: 'Invoice + Work allocation' }).click();
  await page.screenshot(shots('05-add-user'));
  await dialog.getByRole('button', { name: 'Create user' }).click();

  const created = page.getByRole('dialog', { name: 'User created' });
  await expect(created).toContainText(username);
  await created.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('article', { hasText: 'Karthik' }).getByText('Invoice + Work allocation')).toBeVisible();

  await page.keyboard.press('Alt+6');
  await expect(page.getByRole('heading', { name: 'Work orders' })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.screenshot(shots('06-work-orders'));
});
