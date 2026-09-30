import { expect, test } from '@playwright/test';
import { account, expectNoHorizontalScroll, signIn, uniquePhone } from './support.ts';

// The Master on desktop Chrome/Edge at 1366×768: an analysis and management desk (no New Invoice).
// Rail: Dashboard, Work Inv, All Invoices (with Void requests), Work orders, Settings (with Team).

const shots = (name: string) => ({ path: `test-results/screens/desktop-${name}.png`, fullPage: true });

test('Master: copies a technician job from Work Inv, dashboard, invoice list with profit, and void', async ({ page, browser }, testInfo) => {
  // A technician saves the job on their phone.
  const phone = uniquePhone();
  const name = `Desk ${phone.slice(-4)}`;
  const techContext = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  const tech = await techContext.newPage();
  await signIn(tech, account('Technician 1'));
  await tech.getByLabel('Customer phone').fill(phone);
  await tech.getByLabel('Customer name').fill(name);
  await tech.getByLabel('Area').fill('Besant Nagar');
  await tech.getByRole('radio', { name: 'Refrigerator' }).click();
  await tech.getByLabel('Service done').fill('Compressor replacement');
  await tech.getByLabel('Total (₹)').fill('5400');
  await tech.getByLabel('Spare cost (₹)').fill('3100');
  await tech.getByRole('radio', { name: 'Cash' }).click();
  await tech.getByRole('button', { name: 'Save to Server' }).click();
  await expect(tech.getByText('Submitted. The office will send the invoice to the customer.')).toBeVisible();
  await techContext.close();

  const master = account('Master');
  await signIn(page, master);
  await expect(page.getByRole('heading', { name: 'Business dashboard' })).toBeVisible();
  await expectNoHorizontalScroll(page);
  // A clean management desk: five sections, no New Invoice, no separate Void requests or Team.
  for (const gone of ['New Invoice', 'Void requests', 'Team']) {
    await expect(page.locator('.rail').getByRole('button', { name: gone, exact: true })).toHaveCount(0);
  }
  await expect(page.locator('.rail-nav .rail-item')).toHaveCount(5);

  // The Master, as backup checker, copies it from Work Inv: first the phone, then the invoice.
  await page.keyboard.press('Alt+2');
  const card = page.locator('article', { hasText: name });
  await card.getByRole('button', { name: 'Copy phone' }).click();
  // The copy finishes a moment after the tap; the app confirms it with a message.
  await expect(page.getByRole('status').filter({ hasText: `Phone ${phone} copied.` })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(phone);
  await card.getByRole('button', { name: 'Copy invoice' }).click();
  await expect(page.getByRole('status').filter({ hasText: `for ${name} copied. Paste it in WhatsApp.` })).toBeVisible();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain('*Amount:* ₹5,400.00');

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

  // Invoice table shows spare cost, gross profit and who did the job.
  await page.keyboard.press('Alt+3');
  await expect(page.getByRole('heading', { name: 'All Invoices' })).toBeVisible();
  const row = page.locator('tbody tr', { hasText: name });
  await expect(row.getByText('₹2,300.00', { exact: true })).toBeVisible(); // 5,400 − 3,100
  await expect(row).toContainText('Technician 1');

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
  await expect(dialog.locator('pre')).toContainText('*Amount:* ₹5,400.00');
  await dialog.getByRole('button', { name: 'Void invoice' }).click();
  await dialog.getByLabel('Reason for voiding').fill('Entered for the wrong customer');
  await dialog.getByRole('button', { name: 'Void invoice' }).last().click();
  await expect(page.locator('tbody tr', { hasText: name }).locator('.pill-void')).toBeVisible();

  // Void requests from the Admin Technician are a tab of All Invoices.
  await page.getByRole('tab', { name: /Void requests/ }).click();
  await expect(page.getByText('No void requests')).toBeVisible();
  await page.screenshot(shots('03b-void-requests'));

  // Top-bar search jumps to the filtered invoice list.
  await page.keyboard.press('Alt+1');
  await page.keyboard.press('/');
  await page.keyboard.type(name);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'All Invoices' })).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expectNoHorizontalScroll(page);
});

test('Master: Settings tiles; Team adds an Invoice + Work technician', async ({ page }) => {
  await signIn(page, account('Master'));
  await expect(page.getByRole('heading', { name: 'Business dashboard' })).toBeVisible();
  await page.keyboard.press('Alt+5');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  // One square tile per section; each opens its own page.
  await expect(page.locator('.settings-tile')).toHaveCount(2);
  const tile = await page.locator('.settings-tile').first().boundingBox();
  expect(Math.abs(tile!.width - tile!.height)).toBeLessThan(2);
  await page.screenshot(shots('04a-settings-tiles'));
  await page.getByRole('button', { name: /^Team/ }).click();
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

  await page.keyboard.press('Alt+4');
  await expect(page.getByRole('heading', { name: 'Work orders' })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.screenshot(shots('06-work-orders'));
});

test('Master: Settings, Invoice Template adds the Terms & Conditions link to the message', async ({ page }) => {
  await signIn(page, account('Master'));
  await expect(page.getByRole('heading', { name: 'Business dashboard' })).toBeVisible();
  await page.keyboard.press('Alt+5');
  await page.getByRole('button', { name: /^Invoice Template/ }).click();
  await expect(page.getByRole('heading', { name: 'Invoice Template' })).toBeVisible();
  const url = 'https://drive.google.com/file/d/akshaya-terms/view';
  await page.getByLabel('Terms & Conditions link').fill('drive.google.com/x');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Paste the full link, starting with https://')).toBeVisible();
  await page.getByLabel('Terms & Conditions link').fill(url);
  await expect(page.locator('pre.message-preview')).toContainText(`*Terms & Conditions:* ${url}`);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved. New invoices use these details.')).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.screenshot(shots('07-settings'));
  // Back to the tiles, with the link and with the browser's Back button.
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await expect(page.locator('.settings-tile')).toHaveCount(2);
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Invoice Template' })).toBeVisible();
});
