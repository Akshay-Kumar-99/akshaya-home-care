# Phase 5 (part 1): Master analytics dashboard

Written: 29 Sep 2026. The rest of Phase 5 (user and settings screens, reminders, GST tracker, CSV export) is still to do.

## What it shows

All figures cover **one date range**, chosen at the top: Today · Last 7 / 30 days · This or Last month · This or Last financial year (April to March). Every tile, chart and table uses the same range. Each headline figure is compared with the previous period of the same length.

| Block | Definition |
|---|---|
| **Total sales** | Sum of **issued** invoices whose invoice date (IST service date) is in the range. Void and rejected are never counted. |
| **Expense** | Spare cost on those invoices. This is the only cost the app records today. Fuel, salaries and rent are not tracked. |
| **Gross profit / margin** | Sales − expense; margin = profit ÷ sales (shown on the gauge). |
| Invoices · Avg ticket · Customers · Outstanding · Awaiting issue | Count; sales ÷ count; distinct customers and % returning; issued but not paid; submitted but not yet issued (pipeline). |
| **Sales vs expense** | Daily (≤ 35 days), weekly (≤ 200) or monthly trend. Hover or arrow keys show a readout, and a **Table** button gives the same figures as a table. |
| **Revenue by area** | Top 12 areas by sales. |
| **Revenue by customer** | Top 25 customers, **identified by phone number**. Clicking a row opens their full history: lifetime sales, every invoice and warranty status. |
| **Payment mix** | Cash / UPI / Other / Not paid. |
| **Revenue by appliance** | Sales per appliance type. |
| **Team performance** | Per person who **submitted** the job: invoices, sales, average ticket, % edited by the office, % rejected, and average time from submission to issue. |
| **Quality & flags** | Warranty callbacks (same customer and appliance within 90 days), self-issued share, negative-margin invoices, voided invoices, rejected jobs. |

API: `GET /api/analytics/overview?from=YYYY-MM-DD&to=YYYY-MM-DD` and `GET /api/analytics/customer?phone=…`, both **Master only** (`analytics.view`). All aggregation runs in Postgres, and money stays in integer paise.

## Design

- **Layout** follows the owner's reference design: a slim icon rail with a solid active circle, pill status chips in a top bar, pill filters and a gauge. **Colours** follow the owner's "Black and Gold Elegance" palette: black, navy #14213D, gold #FCA311, light grey #E5E5E5, white. Both apply across the app (phones too), in dark and light versions.
- **Charts** are hand-built SVG with no chart library. They sit in a lazy chunk that loads only on the Master's desktop, so technicians never download them. The rules followed: one y-axis, 2 px lines, rounded bar ends, hairline grid, a legend for 2 or more series, text never drawn in series colours, hover **and** keyboard readouts, and a table view.
- **Chart colours were validated** with the colour-blindness and contrast validator:
  - dark (on navy #0e1830): gold #c98500, blue #3987e5, green #199e70, violet #9085e9;
  - light (on white): gold #b27400, blue #2a78d6, green #138a5f, violet #4a3aa7.

  Both pass every check. Two earlier orders **failed**: green and magenta look almost identical to red-green colour-blind viewers. So the set was re-picked, not eyeballed. The chart gold is a deeper step than the #FCA311 used on buttons, because the brighter gold falls outside the readable band for dark charts.

## Tests

- **Integration** ([analytics.test.ts](../tests/integration/analytics.test.ts)): a fixed dataset with hand-computed answers.
  - It includes issued, unpaid, rejected, voided, pending, backdated and self-issued jobs.
  - It checks every KPI to the paisa, the ranking by customer and area, the payment split, per-technician rates, the zero-filled daily trend, the previous-period comparison and the customer history.
  - It confirms Master-only access.
- **End to end:** the Master copies an invoice, it appears on the dashboard (sales, customer, area), the customer history opens, and the top-bar search filters the invoice list.

## Assumptions

- [ASSUMPTION] Sales are counted by invoice date (the service date), not payment date.
- [ASSUMPTION] Team performance credits the person who submitted the job; checker edits don't move the credit.
- [ASSUMPTION] "Returning customer" means served before this period or more than once within it.
