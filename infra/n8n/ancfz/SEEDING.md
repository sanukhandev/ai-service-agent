# ANCFZ n8n seed — local POC

The default target is the **existing n8n instance owner's personal workspace**.
It does not require the paid/registered Projects entitlement, does not call the
`/api/v1/projects` endpoint and does not create a separate `anzfc` project.
This is appropriate for the single-operator POC. The five workflows are
ANCFZ-specific; the generic Node platform remains agent-scoped.

**Named projects remain optional:** use `--workspace=project` to create/use the
`anzfc` project on an instance whose owner/API key can access Projects.
A project-specific HTTP 403 is not a reason to reset n8n or change the API key
if `/api/v1/workflows` works.

## Prerequisites

- Windows PowerShell, Node 22+, Docker Compose and n8n 2.17+.
- An existing local, uncommitted `.env` with different strong
  `POSTGRES_PASSWORD` and `POSTGRES_APP_PASSWORD` values.
- A **persistent** `N8N_ENCRYPTION_KEY` of at least 32 characters in `.env`.
  Never replace this key on an instance that has saved credentials.
- A local n8n owner account. The intended account email is
  `admin@techcarrot.ae`.
- An owner API key generated in the n8n editor at **Settings → n8n API**.
  The key needs read access to workflows and credentials for the import preflight.

The script does **not** update internal n8n SQLite tables, reset users, delete
volumes or overwrite credentials/workflows that already exist.

**Safe command behavior:** With no arguments the script only inspects an existing
instance. Run `--stage=owner` only for an entirely fresh instance, then create
the owner's API key and separately run `--stage=import`. The previous implicit
`--stage=all` operation has been removed because owner bootstrap must never
happen as a side effect of importing workflows.

A complete, unchanged import is repeat-safe: `--stage=import` detects all four
matching credentials and all five inactive workflows, reports success, and
does not import or overwrite them again. Partial imports, conflicting names/IDs,
or unexpectedly active workflows remain **blocked**, pending operator review.

## 1. Start n8n and reach the editor

From the repository root:

```powershell
docker compose --profile workflows up -d n8n gotenberg
docker compose up -d --build nginx
docker compose --profile workflows ps -a
Start-Process "http://localhost/n8n/"
```

Nginx is bound to `127.0.0.1:80`. The n8n editor is
`http://localhost/n8n/` and **n8n has no exposed host port**. Node
uses `http://n8n:5678/webhook/...` privately; Nginx blocks
browser access to webhook/form/MCP endpoints.

### Owner setup: only for a completely fresh n8n instance

If the initial n8n owner does not exist and there is **no existing n8n-data
volume or running container**, use:

```powershell
$secure = Read-Host "Enter new n8n owner password" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $env:N8N_OWNER_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    node scripts/seed-n8n-anzfc.mjs --stage=owner
} finally {
    Remove-Item Env:N8N_OWNER_PASSWORD -ErrorAction SilentlyContinue
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
```

The owner password must be at least 12 characters. The prompt text is not the
password: **type the password after the prompt appears**.

Existing volume or owner? **Skip owner bootstrap**. Log into the existing
n8n account or complete the initial owner form. Never use
`--allow-owner-update`, delete a volume, or reset users as a routine import
step. On a brand-new owner bootstrap, after verifying sign-in, disable the
temporary environment-managed owner configuration:

```powershell
docker compose --profile workflows up -d --force-recreate n8n
```

This preserves the `n8n-data` volume. Rotate the initial owner password
through the n8n editor and enable MFA.

## 2. Inspect and review the dry run

The offline dry run requires no API key:

```powershell
node scripts/seed-n8n-anzfc.mjs --dry-run
```

For a **live read-only inventory**, first provide the owner's n8n API key
privately (as shown in step 3). Then run:

```powershell
node scripts/seed-n8n-anzfc.mjs
# equivalent to --stage=inspect --workspace=personal
```

It reports `status=empty`, `ready`, `partial`, or `conflict`, together
with matching credential/workflow counts. Inspection never imports anything,
creates a project, changes the owner, or activates a workflow. If a partial
import is detected, back up the n8n data volume and inspect the missing
resources before taking action.

## 3. Review the dry run for import

```powershell
node scripts/seed-n8n-anzfc.mjs --stage=import --workspace=personal --dry-run
node scripts/check-n8n-anzfc-seed.mjs
```

Expected dry run reports `workspace=personal`, `project=none`,
four placeholder credentials and five inactive workflows. No Docker,
database, provider or network calls occur in dry-run mode.

## 4. Import to the default personal workspace

Generate an **owner** API key in **Settings → n8n API**, then:

```powershell
$secureKey = Read-Host "Enter n8n owner API key" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try {
    $env:N8N_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    node scripts/seed-n8n-anzfc.mjs --stage=import --workspace=personal
} finally {
    Remove-Item Env:N8N_API_KEY -ErrorAction SilentlyContinue
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
```

`--workspace=personal` is the **default**, so this also works:

```powershell
node scripts/seed-n8n-anzfc.mjs --stage=import
```

Only use the shorthand while `N8N_API_KEY` is present in the current private
process environment.

**How it works:**

1. The private helper calls the authenticated workflows/credentials list APIs
   to check for existing resource names/IDs. Personal mode **never calls**
   `/projects`.
2. Existing matching names/IDs cause a **fail-closed stop**. Do not overwrite
   provider secrets or reimport partially seeded instances.
3. Official n8n server CLI `import:credentials` and `import:workflow` commands
   run **without `--projectId`**. n8n assigns the records to the global
   owner's personal project.
4. Imported workflows have `--activeState=false`. The private helper verifies
   the four credential IDs/names and five **inactive** workflow names using
   the API. A failed import requires inspection; never blindly rerun.

Expected successful output:

```text
Owner personal workspace selected; importing disabled ANCFZ assets.
Verified n8n owner personal workspace: 4 credential placeholders and 5 inactive ANCFZ workflows.
```

## Imported resources

| Resource | Result |
|---|---|
| Owner | Existing owner, intended email `admin@techcarrot.ae` |
| Destination | Owner's default personal workspace |
| Credentials | Four **placeholders**: Node header auth, Salesforce sandbox OAuth2, SMTP OTP, MockGateway API key |
| Workflows | Five **inactive** workflows: OTP email, Salesforce Lead, PDF quotation/invoice template, MockGateway payment link, payment verification |

The workflow JSON lives in `infra/n8n/ancfz/`:

- `00-otp-email.json`
- `01-salesforce-lead.json`
- `02-render-pdf.json`
- `03-mockgateway-payment-link.json`
- `04-mockgateway-payment-verify.json`

Update the imported credentials in the editor before activating **any** workflow.
The Salesforce credential still contains `xxxx` for client ID/secret.
The payment-status workflow remains fail-closed; no fake payment verification.

## Optional: create a named anzfc project

Only if your n8n instance supports Projects and the owner API key has
project-read/create permissions:

```powershell
# Supply N8N_API_KEY privately as in step 3
node scripts/seed-n8n-anzfc.mjs --stage=import --workspace=project
```

This mode uses the Projects API and passes `--projectId` to the n8n CLI.
A 403 means the selected API key or instance cannot perform project
operations. Use the default personal mode; don't buy a license for the POC.

## Verification and troubleshooting

```powershell
node scripts/check-n8n-anzfc-seed.mjs
node scripts/check-ancfz-workflows.mjs
node scripts/check-ancfz-credentials.mjs
node scripts/check-ancfz-salesforce.mjs
docker compose --profile workflows logs --tail=50 n8n
```

These script checks are offline contract validations, **not** live Salesforce,
SMTP, payment or Gotenberg acceptance tests.

- **HTTP 401 on workflows or credentials:** invalid/expired key or wrong owner.
- **HTTP 403 on credentials:** required credential-list scope missing; create
  an owner key with sufficient permissions.
- **HTTP 403 on projects:** only relevant when using
  `--workspace=project`; personal mode does not call the endpoint.
- **Already seeded:** all four matching credentials and five inactive workflows
  are present. Re-running import is safe and makes no changes.
- **Existing partial/conflicting resources:** imports do not overwrite them.
  Inspect the personal workspace and make a backup before reconciliation.
- **Partial import:** the helper aborts before reimport; check n8n credentials
  and workflows manually. Do not reset user management or volumes.
- **No owner exists:** complete first-time owner creation before importing;
  the CLI's implicit personal-workspace selection requires an owner.

n8n stores its default SQLite database in the `n8n-data` Docker volume.
Back up that volume together with the persistent encryption key. Real provider
workflow operation still requires credentials and independent live testing.
