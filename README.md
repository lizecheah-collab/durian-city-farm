# Durian City Farm

Website for Durian City Farm, Bandar Seri Alam, Johor Bahru: the public pages, an online booking form with deposit-receipt upload, and a password-protected admin page for bookings and availability.

## What's here

| Path | What it is |
| --- | --- |
| `public/` | The site pages: `index`, `book`, `events`, `retreat`, `partner`, `faq`, and `admin` |
| `server.js` | Node.js/Express server that serves `public/` and the booking API |
| `test/` | API tests (`npm test`) |
| `data/` | Created at runtime: `dcf.sqlite` database and `uploads/` receipts. Not committed. |

## Run it locally

Needs Node.js 22.13 or newer (it uses Node's built-in SQLite).

```bash
npm install
```

```bash
ADMIN_PASSWORD=choose-a-password npm start
```

Then open http://localhost:3000. The admin page is http://localhost:3000/admin.html.

On Windows PowerShell, set the password with `$env:ADMIN_PASSWORD="choose-a-password"; npm start`.

## Settings (environment variables)

| Variable | Required | Meaning |
| --- | --- | --- |
| `ADMIN_PASSWORD` | Yes | Password for `admin.html`. Without it the admin login is refused. |
| `PORT` | No | Port to listen on (default 3000). Most hosts set this for you. |
| `DATA_DIR` | No | Folder for the database and receipts (default `./data`). Point it at a persistent disk in production. |
| `NODE_ENV` | No | Set to `production` so the admin cookie is only sent over HTTPS. |

## How booking works

1. A visitor picks an experience, date and time on `book.html`, pays the RM10-per-person deposit, and uploads the receipt.
2. The server checks the request against the current availability (open-from date, season months, closed/fully booked dates, closed slots, products and varieties, 24-hour lead time) and saves it with a reference like `DCF-7KQ2MX`.
3. In `admin.html`, the farm checks the receipt, sets the booking to *confirmed*, and sends the WhatsApp confirmation with one tap. Bookings can be exported to CSV.
4. The Availability tab controls which products, varieties, dates and slots visitors can book. Changes apply immediately.

## Deploying

GitHub Pages can't run this, since it only hosts static files. Use a Node host with a persistent disk, for example **Render** (Web Service with a Disk) or **Railway** (service with a Volume):

- Build command: `npm install`
- Start command: `npm start`
- Environment: `ADMIN_PASSWORD`, `NODE_ENV=production`, and `DATA_DIR` set to the mounted disk path (e.g. `/var/data`)

Without a persistent disk, bookings and receipts are lost whenever the host restarts.

Back up `DATA_DIR` regularly; it holds every booking and receipt.
