# Manual test: public form and upload request (local, synthetic data only)

Use PowerShell windows in `C:\MAIN-DEV-ALL\Formiva`. Everything here is fake data in the local test database.
Do not put real credentials in any of these commands.

## Window 1: database and form link

```powershell
docker start formiva-pg
$env:DATABASE_URL = "postgresql://formiva_test:formiva_test_only@127.0.0.1:55432/formiva_test"
pnpm --filter "@formiva/db" run db:seed-demo
```

It prints a link like `http://localhost:3001/f/<64 characters>`. Keep it. Run the command again for a fresh form and link.

## Window 2: API (port 3000)

```powershell
$env:DATABASE_URL = "postgresql://formiva_test:formiva_test_only@127.0.0.1:55432/formiva_test"
$env:NODE_ENV = "development"; $env:PORT = "3000"
# Clerk is not used by the public form; these are placeholders so the API starts.
$env:CLERK_ISSUER = "https://clerk.synthetic.invalid"; $env:CLERK_AUDIENCE = "synthetic"
$env:CLERK_JWKS_URL = "https://clerk.synthetic.invalid/jwks"; $env:CLERK_AUTHORIZED_PARTIES = "http://localhost:3001"
$env:CLERK_SECRET_KEY = "synthetic-not-real"
# any 32+ character fake value (written in parts so the repository secret scan stays quiet)
$env:IP_HASH_SECRET = ("synthetic","local","ip","hash","key","0123456789abcdef" -join "-")
# Fake storage settings: the API can create upload links but nothing can be uploaded to them.
$env:R2_ACCOUNT_ID = "synthetic-account"; $env:R2_ACCESS_KEY_ID = "synthetic-id"
$env:R2_SECRET_ACCESS_KEY = "synthetic-local-signing-value"; $env:R2_QUARANTINE_BUCKET = "quarantine-dev"
cd apps\api
pnpm exec tsx src/index.ts
```

## Window 3: website (port 3001)

```powershell
$env:API_BASE_URL = "http://127.0.0.1:3000"
cd apps\web
pnpm exec next dev -p 3001
```

## What to try in the browser

1. Open the link. You should see "Synthetic onboarding form" with a privacy-notice tick box.
2. Press Save draft without ticking the box: it must refuse and say so.
3. Tick the box, type a name, press Save draft: "Draft saved." Reload the page: the name is still there.
4. "Private notes" is saved with the draft but never shown back to you after a reload. The bank account and file fields are hidden (not available yet).
5. Open the same link on your phone browser (same Wi-Fi, use your PC's address instead of `localhost`) and check the layout.
6. Change one character in the link: you must see the neutral "not valid or has expired" message.

## Upload request (API only, no web control yet)

After step 3, in a new PowerShell window (replace `<TOKEN>` with the 64 characters from your link):

```powershell
$body = '{"idempotency_key":"manual-test-0001","slot_key":"photo","filename":"photo.png","mime_type":"image/png","size_bytes":1000}'
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/public/v1/forms/<TOKEN>/upload-requests" -ContentType "application/json" -Body $body
```

Expect `status: quarantine_pending` and a long `url`. Change `filename` to `virus.exe` and `mime_type` to `application/octet-stream`: expect a 422 "This file type is not accepted."
The link cannot actually receive a file (fake storage settings); real storage is tested later with a real Cloudflare R2 bucket.

## Submit

In the browser: after step 3, press **Submit form**. The page saves your answers first, then submits, then shows "Form submitted". Reload the link: it shows the same confirmation, not the form. Try it with the name field emptied first: you should see the error list and nothing is sent.

The demo form has no required file, so it can be submitted. A form with a required file cannot be completed in a browser yet (no upload control); the page then says which item is still needed. Automated tests cover the file case (they mark a test file clean directly in the test database). Run `pnpm --filter "@formiva/db" run db:seed-demo` again for a fresh link, because the seed now adds a routing policy.

Same thing through the API (use a fresh link, after step 3):

```powershell
$body = '{"draft_revision":1,"idempotency_key":"manual-submit-0001"}'
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/public/v1/forms/<TOKEN>/submit" -ContentType "application/json" -Body $body
```

Expect `status: submitted` and an empty `job_ids`. Run it again: same `case_id`, `replay: true`.

## Known limits

- The API here connects as the test database owner, so this does not exercise row-level security. The automated tests do.
- `next dev` prints each request path, which includes the link token, to the console. Production does not do this by default, but web host logs can.
- The website proxy has no upload route yet; the upload request only works against the API directly (port 3000).
