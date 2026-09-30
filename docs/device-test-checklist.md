# Device test checklist (Phase 4, updated 30 Sep 2026)

Run on real devices before go-live and after any change to the job form, Work Inv or clipboard code. Tick every box, and note the phone model and browser version at the top.

Order: **Android Chrome first (primary)**, then the installed Android app, then iPhone Safari (secondary, best effort), then desktop Chrome/Edge.

Device / browser: ______________________ Date: __________ Tester: __________

## A. Android Chrome (mid-range phone, PRIMARY)

### Technician
- [ ] Sign in with username and password only: no PIN page appears.
- [ ] First sign-in forces a new password. No PIN is asked for.
- [ ] New Invoice: the number keypad appears for phone, total and spare cost; letters keyboard for name.
- [ ] Typing a known customer's 10-digit phone fills in the name and area.
- [ ] Area and brand suggestions appear while typing; an unlisted value shows "Choose from the list".
- [ ] Appliance chips and payment chips are easy to hit with a thumb (no mis-taps).
- [ ] Spare cost higher than the total shows the confirm box; saving without ticking it is blocked.
- [ ] The "Customer pays / Save to Server" bar sits at the end of the form, after Payment, and never floats over the fields while typing.
- [ ] A full job takes **under 30 seconds** for a practised user. Time: ____ s
- [ ] After saving: "Submitted. The office will send the invoice to the customer."
- [ ] My Submissions shows Submitted, then "Issued · INV-…" after the office copies it, or "Rejected: reason".
- [ ] "Edited by office" appears after a checker edit.
- [ ] Nowhere does the technician see the customer message, profit or margin.
- [ ] Offline (airplane mode): saving shows "Saved on this phone…". My Submissions shows "Not yet on server". Turning airplane mode off sends it within about 30 s, without opening the app again, and it never appears twice.
- [ ] Close the app completely while a job is "Not yet on server", reopen it with a connection, and the job is sent.
- [ ] Half-fill New Invoice, switch to another app (or take a call), come back or reopen the app: "Your unfinished invoice was restored." and every field is still there. Saving clears it.
- [ ] Service chips: tap one to add it (highlighted, with a tick), tap again to remove it.
- [ ] Type the phone of a customer served in the last 90 days: "Recent visits" appears, with a **Warranty service** tick box showing that invoice and "warranty till …".
- [ ] Tick it: appliance, brand and "Warranty service, …" fill in; the amount box becomes "Visit charge"; leave it empty and it shows "No charge". Save, and My Jobs shows the job tagged Warranty service.
- [ ] Untick it (a different job for the same customer): the total is required again.

### Technician labelled "Invoice + Work allocation"
- [ ] The first tab is **Works assigned**; its badge shows the number of open jobs. An "Invoice only" technician has no such tab.
- [ ] A job assigned from the office appears within about 30 seconds while the app is open.
- [ ] Call dials the customer. Start job changes it to In progress.
- [ ] Complete & create invoice shows the customer, address and complaint, and asks only for the brand, work done, amounts and payment.
- [ ] After completing: "Job completed. The office will send the invoice." The job moves to "Done recently" as Submitted, then Issued · INV-… after the office copies it.
- [ ] If the office rejects it, the job comes back as In progress with "Sent back by the office: reason".
- [ ] Offline: the list is still there; completing a job shows "Not yet on server" and it is sent when back online.

### Admin Technician (checker)
- [ ] Sign in: username and password, then the PIN page. "Not you? Start again" goes back. A wrong PIN says how many tries are left.
- [ ] After 10 minutes idle, reopening asks for the PIN; 5 wrong PINs sign out.
- [ ] Work Inv badge count on the tab bar matches the pending list.
- [ ] Cards are oldest first; an item older than 4 hours has a red age badge and border.
- [ ] Duplicate (same phone and same total within 24 h) and negative-margin flags show.
- [ ] Message preview shows "(assigned on copy)" before copying.
- [ ] **Copy phone** first: the 10-digit number (e.g. 9876543210) is copied; paste it in WhatsApp search and it finds the customer. The button then reads **Copy invoice**.
- [ ] Go to WhatsApp and come back (even if the app reloads): the card still shows **Copy invoice**, with a "Copy phone again" link.
- [ ] **Copy invoice**: paste into WhatsApp and check the text: bold labels, INV number, date dd/mm/yyyy, service done, ₹ amount with Indian commas, payment, warranty "90 days on our service, till … Spare parts are not covered", the Terms & Conditions link (if set), phone. No line wraps into a second line of dashes.
- [ ] A warranty service card shows "Warranty for INV-…" and "No charge" (or the visit charge); its message says "Warranty service for INV-…" and "covered under INV-… till …".
- [ ] After copying, a confirmation "INV-… for … copied. Paste it in WhatsApp." appears, with **no** chat pop-up or link.
- [ ] Switch to WhatsApp, send, come back: the app has reloaded and the card is under "Recently copied".
- [ ] Copy again (Copy phone, then Copy again) and Put back in queue work from "Recently copied". There is no WhatsApp chat button anywhere in the app.
- [ ] Edit a pending item's name (no PIN), then its total (asks for the PIN).
- [ ] Reject needs a reason; the technician sees that reason.
- [ ] Two phones tap Copy on the same item at the same moment: exactly one gets the number, the other sees "Already copied by … at …".
- [ ] New Invoice → "Copy phone" checks the form and copies the number; "Copy invoice" then creates and copies the invoice, which never appears in the queue.
- [ ] All Invoices: search by name, phone and INV number; Request void sends a request.
- [ ] Sound on: a new submission beeps while the app is open.
- [ ] Work orders tab: New work order offers only "Invoice + Work" technicians, each with their open-job count. The job appears under Open as Assigned.
- [ ] Re-assign / reschedule and Cancel job (with a reason) work; the technician's list updates.

## B. Installed Android app (PWA)
- [ ] Chrome menu → "Install app" / "Add to Home screen" gives the house icon with no white box around it.
- [ ] Opens full screen (no browser address bar).
- [ ] With the server asleep (after about 20 min idle), the app opens instantly and shows "Waking the server…", then works.
- [ ] **Push alerts:** Work Inv → "Turn on alerts" → allow. With the app closed and the phone locked, a technician's submission shows the notification "New invoice waiting" within about a minute. Tapping it opens Work Inv.
- [ ] Battery settings changed as in [phase-1-architecture.md §6](phase-1-architecture.md) (Chrome set to Unrestricted; Samsung: not in "Sleeping apps"). Test again after 30 min idle.
- [ ] The notification text contains no customer name, phone or amount.

## C. iPhone Safari (secondary, best effort)
- [ ] Sign in, New Invoice and My Submissions work; the layout fits under the notch and above the home bar.
- [ ] Copy message puts the text on the clipboard. If it doesn't, the "Copy the message" box appears with the text selectable.
- [ ] "Add to Home Screen" works. Push alerts (iOS 16.4+) only work from the Home Screen app, after "Turn on alerts". Record the result: ______

## D. Desktop Chrome / Edge (Master, 1366×768 and 1920×1080)
- [ ] Sign-in asks for the PIN on a second page.
- [ ] The sidebar shows only Dashboard, Work Inv (with badge), All Invoices, Work orders and Settings. There is no New Invoice for the Master.
- [ ] All Invoices has a **Void requests** tab (with a count when requests wait); Settings shows square tiles (**Team**, **Invoice Template**); each opens its own page with "‹ Settings" to go back (the browser's Back works too).
- [ ] Alt+1 to Alt+5 switch sections; "/" jumps to invoice search.
- [ ] The invoice table shows spare cost, gross profit (red if negative), and Self-issued / Edited / Void requested flags.
- [ ] "Load more" pages through older invoices.
- [ ] Date filter: Today, Yesterday and Date range (From/To pickers) show only invoices with those invoice dates; From after To shows an error.
- [ ] Void asks for the PIN when the last PIN entry is over 5 minutes old; the voided invoice keeps its number.
- [ ] Void requests: Approve (asks for the PIN) voids the invoice; Refuse leaves it issued.
- [ ] Team → Add user: a Technician cannot be created until Invoice only or Invoice + Work allocation is chosen; an Admin Technician needs a PIN. The details card is shown once and Copy details works.
- [ ] Team → Edit switches a technician's type; Password / PIN signs that person out; Remove stops them signing in and Restore lets them back in.
- [ ] Team actions ask for the PIN when the last PIN entry is over 5 minutes old.
- [ ] Settings (Alt+5) → Invoice Template: paste the Google Drive T&C link, "Open link" opens the PDF (while signed out of Google too), the preview shows it, Save asks for the PIN if needed. The next invoice copied includes the link.
- [ ] The window narrowed to phone width still works (no sideways scrolling).

## E. Every device
- [ ] No sideways scrolling on any screen.
- [ ] Phones: the top header (logo, name, theme, sign out) scrolls away as you scroll down and is back only at the top of the page; it never covers the content. The bottom tab bar stays.
- [ ] Buttons and chips are at least finger-sized (48 px).
- [ ] Dark and light themes are both readable (theme button in the top bar cycles Auto → Dark → Light); light is readable outdoors in sunlight.
- [ ] Area picker: typing "thiru" suggests Thiruvanmiyur, Thirumangalam, Thiruverkadu, Thiruneermalai, Thirumullaivoyal.
