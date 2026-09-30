import { expect, test, type Page } from '@playwright/test';
import { account, expectNoHorizontalScroll, signIn, uniquePhone } from './support.ts';

// Primary target: Android Chrome (Pixel 7 emulation). Maker → checker → issued, end to end.

const shots = (name: string) => ({ path: `test-results/screens/mobile-${name}.png`, fullPage: true });

async function fillJob(page: Page, opts: { phone: string; name: string; total: string; spare: string }) {
  await page.getByLabel('Customer phone').fill(opts.phone);
  await page.getByLabel('Customer name').fill(opts.name);
  await page.getByLabel('Area').fill('Thiruvanmiyur');
  await page.getByRole('radio', { name: 'AC (split)' }).click();
  await page.getByLabel('Brand').fill('Daikin');
  await page.getByRole('button', { name: 'Gas refilling' }).click();
  await page.getByLabel('Total (₹)').fill(opts.total);
  await page.getByLabel('Spare cost (₹)').fill(opts.spare);
  await page.getByRole('radio', { name: 'UPI' }).click();
}

test.describe.serial('technician and admin technician on Android', () => {
  const phone = uniquePhone();
  const customer = `Meena ${phone.slice(-4)}`;

  test('technician signs in without a PIN and saves a job to the server', async ({ page }) => {
    await signIn(page, account('Technician 1'));
    await expect(page.getByRole('heading', { name: 'New Invoice' })).toBeVisible();
    // "Invoice only": the same interface as before, no Works assigned tab.
    await expect(page.getByRole('button', { name: 'Works assigned' })).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await page.screenshot(shots('01-new-job-empty'));

    await fillJob(page, { phone, name: customer, total: '2300', spare: '800' });
    await expect(page.locator('.action-total')).toContainText('₹2,300.00');
    await page.screenshot(shots('02-new-job-filled'));
    await page.getByRole('button', { name: 'Save to Server' }).click();
    await expect(page.getByText('Submitted. The office will send the invoice to the customer.')).toBeVisible();

    await page.getByRole('button', { name: 'My Jobs' }).click();
    const card = page.locator('article', { hasText: customer });
    await expect(card.getByText('Submitted', { exact: true })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot(shots('03-my-submissions'));
  });

  test('admin technician signs in with password, then PIN, and copies the message', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Username').fill(account('Admin Technician').username);
    await page.getByLabel('Password', { exact: true }).fill(account('Admin Technician').password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Enter your PIN' })).toBeVisible();
    await page.screenshot(shots('04a-pin-step'));
    await page.getByRole('button', { name: 'Not you? Start again' }).click();
    await signIn(page, account('Admin Technician'));
    await expect(page.getByRole('heading', { name: 'Technician Work Inv' })).toBeVisible();
    const card = page.locator('article', { hasText: customer });
    await expect(card).toBeVisible();
    await expect(card.getByText('₹2,300.00', { exact: true })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot(shots('04-work-inv-pending'));

    // Two taps, in order: the phone number (for WhatsApp search), then the invoice.
    await expect(card.getByRole('button', { name: 'Copy invoice' })).toHaveCount(0);
    await card.getByRole('button', { name: 'Copy phone' }).click();
    await expect(page.getByRole('status').filter({ hasText: `Phone ${phone} copied.` })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(phone);
    await page.screenshot(shots('05a-phone-copied'));
    // Leaving for WhatsApp and coming back keeps the step.
    await page.reload();
    await card.getByRole('button', { name: 'Copy invoice' }).click();
    const toast = page.getByRole('status').filter({ hasText: `for ${customer} copied. Paste it in WhatsApp.` });
    await expect(toast).toBeVisible();
    await expect(toast.getByRole('link')).toHaveCount(0); // no chat pop-up link any more
    await page.screenshot(shots('05-copied-toast'));

    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain(`Hello ${customer},`);
    expect(clip).toMatch(/Invoice Number: INV-\d{5,}/);
    expect(clip).toContain('Invoice Total: ₹2,300.00');
    expect(clip).not.toMatch(/spare|profit/i);

    await expect(card).toHaveCount(0);
    await page.getByRole('tab', { name: 'Recently copied' }).click();
    await expect(page.locator('article', { hasText: customer }).getByText(/Copied by Admin Technician/)).toBeVisible();
    await page.screenshot(shots('06-recently-copied'));
  });

  test('the technician sees the issued invoice number', async ({ page }) => {
    await signIn(page, account('Technician 1'));
    await page.getByRole('button', { name: 'My Jobs' }).click();
    await expect(page.locator('article', { hasText: customer }).getByText(/Issued · INV-\d+/)).toBeVisible();
  });

  test('offline: the job is kept on the phone and sent when the connection returns', async ({ page, context }) => {
    await signIn(page, account('Technician 2'));
    await page.getByRole('button', { name: 'New Invoice' }).click();
    await expect(page.getByRole('heading', { name: 'New Invoice' })).toBeVisible();
    const offlineName = `Offline ${uniquePhone().slice(-4)}`;
    await context.setOffline(true);
    await fillJob(page, { phone: uniquePhone(), name: offlineName, total: '1200', spare: '0' });
    await page.getByRole('button', { name: 'Save to Server' }).click();
    await expect(page.getByText('Saved on this phone. Not yet on server: it will be sent automatically.')).toBeVisible();
    await page.getByRole('button', { name: 'My Jobs' }).click();
    await expect(page.locator('article', { hasText: offlineName }).getByText('Not yet on server')).toBeVisible();
    await page.screenshot(shots('07-offline-queued'));

    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.locator('article', { hasText: offlineName }).getByText('Submitted', { exact: true })).toBeVisible();
    await expect(page.getByText('Not yet on server')).toHaveCount(0);
  });

  test('first sign-in forces a new password (no PIN for technicians)', async ({ page }) => {
    const tech3 = account('Technician 3');
    await signIn(page, { ...tech3, pin: undefined });
    await expect(page.getByRole('heading', { name: 'Set your own password' })).toBeVisible();
    await expect(page.getByLabel('New PIN (6+ digits)')).toHaveCount(0);
    await page.screenshot(shots('08-first-login'));
    await page.getByLabel('Current (temporary) password').fill(tech3.password);
    await page.getByLabel('New password (12+ characters)').fill('Kadalai-Mittai-2026');
    await page.getByLabel('Confirm new password').fill('Kadalai-Mittai-2026');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('heading', { name: 'New Invoice' })).toBeVisible();
  });

  test('works at 360 px wide with no sideways scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await signIn(page, account('Admin Technician'));
    await expect(page.getByRole('heading', { name: 'Technician Work Inv' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.getByRole('button', { name: 'Invoices', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'All Invoices' })).toBeVisible();
    await expect(page.locator('tbody tr').first()).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot(shots('09-invoices-360'));
    await page.getByRole('button', { name: 'New Invoice' }).click();
    await expectNoHorizontalScroll(page);
    // The action bar sits after the last field; it never floats over the form.
    const bar = await page.locator('.action-bar').boundingBox();
    const payment = await page.getByRole('radiogroup', { name: 'Payment' }).boundingBox();
    expect(bar!.y).toBeGreaterThan(payment!.y + payment!.height);
    await page.screenshot(shots('10-new-invoice-360'));
    await page.getByRole('button', { name: 'Work orders' }).click();
    await expect(page.getByRole('heading', { name: 'Work orders' })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});

test.describe.serial('work allocation on Android', () => {
  const phone = uniquePhone();
  const customer = `Work ${phone.slice(-4)}`;

  test('admin technician assigns a job to an Invoice + Work technician', async ({ page }) => {
    await signIn(page, account('Admin Technician'));
    await page.getByRole('button', { name: 'Work orders' }).click();
    await expect(page.getByRole('heading', { name: 'Work orders' })).toBeVisible();
    await page.getByRole('button', { name: 'New work order' }).click();
    const dialog = page.getByRole('dialog', { name: 'New work order' });
    await dialog.getByLabel('Customer phone').fill(phone);
    await dialog.getByLabel('Customer name').fill(customer);
    await dialog.getByLabel('Area').fill('Thiruvanmiyur');
    await dialog.getByLabel('Address for the visit').fill('12, 3rd Main Road');
    await dialog.getByRole('radio', { name: 'AC (split)' }).click();
    await dialog.getByLabel('Complaint').fill('AC not cooling');
    // Only Invoice + Work technicians are offered.
    await expect(dialog.locator('option', { hasText: 'Technician 1' })).toHaveCount(0);
    const tech2 = await dialog.locator('option', { hasText: 'Technician 2' }).getAttribute('value');
    await dialog.getByLabel('Assign to').selectOption(tech2!);
    await page.screenshot(shots('11-new-work-order'));
    await dialog.getByRole('button', { name: 'Assign' }).click();
    await expect(page.getByText('Assigned to Technician 2.')).toBeVisible();
    await expect(page.locator('article', { hasText: customer }).getByText('Assigned', { exact: true })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot(shots('12-work-orders'));
  });

  test('the technician starts the job and completes it with the invoice', async ({ page }) => {
    await signIn(page, account('Technician 2'));
    await expect(page.getByRole('heading', { name: 'Works assigned' })).toBeVisible();
    await expect(page.locator('.tabbar-badge')).toHaveText('1');
    const card = page.locator('article', { hasText: customer });
    await expect(card.getByText(/AC not cooling/)).toBeVisible();
    await expect(card.getByText(/12, 3rd Main Road/)).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot(shots('13-works-assigned'));

    await card.getByRole('button', { name: 'Start job' }).click();
    await expect(card.getByText('In progress', { exact: true })).toBeVisible();
    await card.getByRole('button', { name: 'Complete & create invoice' }).click();
    await expect(page.getByRole('heading', { name: 'Complete the job' })).toBeVisible();
    await expect(page.getByText(customer)).toBeVisible();
    await page.getByRole('button', { name: 'Gas refilling' }).click();
    await page.getByLabel('Total (₹)').fill('2600');
    await page.getByLabel('Spare cost (₹)').fill('900');
    await page.getByRole('radio', { name: 'Cash' }).click();
    await expectNoHorizontalScroll(page);
    await page.screenshot(shots('14-complete-work'));
    await page.getByRole('button', { name: 'Complete & create invoice' }).click();
    await expect(page.getByText('Job completed. The office will send the invoice.')).toBeVisible();
    await expect(page.locator('article', { hasText: customer }).getByText('Submitted', { exact: true })).toBeVisible();
    await expect(page.locator('.tabbar-badge')).toHaveCount(0);
  });

  test('the office copies the invoice raised from the work order', async ({ page }) => {
    await signIn(page, account('Admin Technician'));
    const card = page.locator('article', { hasText: customer });
    await expect(card.getByText('₹2,600.00', { exact: true })).toBeVisible();
    await card.getByRole('button', { name: 'Copy phone' }).click();
    await card.getByRole('button', { name: 'Copy invoice' }).click();
    await expect(page.getByRole('status').filter({ hasText: `for ${customer} copied` })).toBeVisible();
    await page.getByRole('button', { name: 'Work orders' }).click();
    await page.getByRole('tab', { name: 'Completed' }).click();
    await expect(page.locator('article', { hasText: customer }).getByText(/Issued · INV-\d+/)).toBeVisible();
  });
});
