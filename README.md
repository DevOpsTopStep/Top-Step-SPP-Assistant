# Topstep SPP Assistant

An AI assistant that lives inside SuiteProjects Pro. Open it from the toolbar (or press **Ctrl/⌘+Shift+K**) on any SPP page and ask it to:

- **Draft script requests:** it interviews you briefly, writes the SR in Topstep's format (summary, script name, type, severity, estimate, full spec in notes), and shows a card you confirm before anything is saved.
- **Update SRs:** move stages, set estimates, attach script names and notes. These also require confirmation.
- **Write SPP user scripts:** form, scheduled and library scripts, checked for ES5 compatibility (SPP's only supported JavaScript version) and SPP best practices before you see them, with Copy and Download .js buttons and a deploy checklist.
- **Review a script:** open it in the Scripting Studio and click *Review this script*.
- **Run reports:** answers questions from live SPP data as tables with a Download CSV button.
- **Explain the page you're on:** it reads the visible form, never password or token fields.

Every read and write uses **the signed-in user's own SPP role and filter set** through OAuth 2.0. People only see and change what they already can in SPP.

```
 SPP page ──► Chrome side panel (extension/) ──HTTPS──► Assistant server (server/)
   ▲ content.js reads page context                          │  holds Claude API key,
   │                                                         │  SPP OAuth client secret,
   └──────────── user signs in to SPP (OAuth) ◄──────────────┤  per-user SPP tokens
                                                             ├──► Claude API
                                                             └──► SPP REST API + XML API
```

The server is needed because the Claude API key and the SPP OAuth client secret must never ship inside a browser extension.

---

## 1. SPP admin setup (one time)

1. **Turn on API access and the REST API** for the account. API Access comes from your SPP account manager; REST API is enabled by SPP Support.
2. **Get the XML API namespace and key.** Script requests are SPP *Issues*, and the REST API doesn't cover Issues, so the assistant uses the XML API for them.
3. **Register an OAuth 2.0 application** (under Administration > Global Settings > Account > Integration; see "Adding a New Application" in SPP help):
   - Redirect URI: `https://<your-server>/auth/callback` (must match `PUBLIC_URL` exactly)
   - Scopes: REST and XML
   - Note the **Client ID** and **Client Secret**.
   - Token lifetimes are set on the application form; SPP's docs cite 15-minute access tokens and 24-hour refresh tokens. The server refreshes access tokens automatically, but once a refresh token expires the user clicks **Connect SPP** again.
4. **Check the SR field names** in `server/config/script-request.json`. Category, stage, source and severity IDs came from your live SPP data. The custom field names (`script_name__c`, `estimated_hours__c`, `requested_date__c`, `create_task_for_script_request__c`, …) follow SPP's `__c` convention but **need confirming** in Administration > Global Settings > Custom Fields. Edit the JSON if any differ; no code change is needed.

### Starting without the XML API key (REST-only mode)

You can pilot before you have the namespace and key: leave `SPP_API_NAMESPACE` and `SPP_API_KEY` empty. The server then runs **REST-only**:

| Works now | Turns on when the XML key is added |
|---|---|
| Writing and reviewing SPP scripts (ES5-checked) | Saving new SRs to SPP, updating SRs |
| Reports on projects, users, customers, bookings, time entries, tasks, expense reports | Listing/finding SRs, invoices, charges, timesheets, billing & rev-rec rules |
| Drafting SRs as copy-ready text to paste into SPP | Showing the signed-in user's name in the panel |

Add both values to `.env` and restart: everything turns on automatically. Users don't need to reconnect, because the OAuth scope already includes `xml`. `GET /health` shows which mode is active (`features.xml`).

## 2. Run the server

Requires Node 20+ and has **no npm dependencies**.

```bash
cd server
cp .env.example .env      # fill in Claude + SPP values
npm test                  # 13 tests, all mocked, no network needed
npm start                 # http://localhost:8787
```

Docker: `docker build -t spp-assistant server/ && docker run -p 8787:8787 --env-file server/.env -v spp-data:/app/data spp-assistant`

Put it behind HTTPS (your load balancer, an internal reverse proxy, Azure App Service, etc.). Check `GET /health`: it lists any missing configuration.

| Setting | What it is |
|---|---|
| `PUBLIC_URL` | HTTPS URL of the server; the OAuth redirect is `${PUBLIC_URL}/auth/callback` |
| `ALLOWED_ORIGINS` | `chrome-extension://<id>` of your extension (shown on its Settings page). **Set this before rollout**; otherwise any extension can call the server |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Claude API key and model (default `claude-sonnet-5-5`) |
| `SPP_COMPANY_ID`, `SPP_SANDBOX` | Your SPP account. Point a pilot at the **sandbox** first |
| `SPP_CLIENT_ID`, `SPP_CLIENT_SECRET` | From the OAuth application |
| `SPP_API_NAMESPACE`, `SPP_API_KEY` | XML API credentials. Optional: leave empty for REST-only mode |

### Topstep's AWS deployment (us-east-1, account `topstepllc`)

| Piece | Name |
|---|---|
| Server URL | `https://sp-ebcdf1d3a33d46bbbdb599fdc9fea0dd.ecs.us-east-1.on.aws` |
| SPP OAuth redirect URI | `https://sp-ebcdf1d3a33d46bbbdb599fdc9fea0dd.ecs.us-east-1.on.aws/auth/callback` |
| ECS Express service | `spp-assistant` (cluster `default`), 1 task, 0.25 vCPU / 512 MB |
| Container image | ECR `spp-assistant` (tagged by commit) |
| Build | CodeBuild `spp-assistant-build` (pulls `main` from GitHub, runs tests, pushes image) |
| Secrets | Secrets Manager `spp-assistant/config` (JSON: `ANTHROPIC_API_KEY`, `SPP_CLIENT_ID`, `SPP_CLIENT_SECRET`, `SPP_API_NAMESPACE`, `SPP_API_KEY`) |
| Logs | CloudWatch `/ecs/spp-assistant` (90-day retention) |
| IAM roles | `spp-assistant-task-execution`, `spp-assistant-ecs-infrastructure`, `spp-assistant-codebuild` |

Sign-ins are kept in memory only (`TOKEN_STORE_FILE=memory`), so nothing sensitive is written to disk and a redeploy asks users to click **Connect SPP** again.

**Changing secrets:** edit `spp-assistant/config` in Secrets Manager, then force a new deployment of the ECS service (secrets are read when the container starts).
**Deploying new code:** push to `main`, start the `spp-assistant-build` CodeBuild project, then update the ECS service to the new image tag.

## 3. Install the extension

**Pilot (a few people):** `chrome://extensions` → Developer mode → *Load unpacked* → pick the `extension/` folder. The `key` in `manifest.json` pins the extension ID to `hdkeejeiifcgbimnjfjpbilpmmiiggmc` on every machine, which is what the server's `ALLOWED_ORIGINS` allows (remove `key` before publishing to the Chrome Web Store, which assigns its own ID). Open the extension's **Settings**, enter the server URL, then click **Connect SPP** in the panel.

**Company rollout:** publish it as an unlisted/private Chrome Web Store item (or self-host the .crx) and force-install it through Google Admin or Intune. Push the server URL as managed policy so nobody has to configure anything:

```json
{ "backendUrl": { "Value": "https://spp-assistant.topstepllc.com" } }
```

Works in Chrome and Edge (both support side panels and managed storage).

## 4. Safety model

- **Nothing is written without a click.** Write tools only create proposals; the server executes a proposal only when the same user confirms it, once, within 30 minutes.
- **Per-user permissions.** OAuth tokens are per person, so SPP enforces each user's role and filter set. Tokens stay on the server (`data/sessions.json`, file mode 600); the browser only holds a random session ID.
- **Page context is minimal.** Visible field labels and values, the title and selected text. Password, hidden and token-like fields are skipped, and you can turn off *Include this page* per message.
- **Scripts are drafts.** The assistant never deploys code. People review, test in sandbox, and deploy through your normal SR flow (Code Review → Dev Testing → Client UAT).

## 5. Customizing

- **SR conventions, script rules, report terminology:** `server/src/prompts.js`
- **Field mapping and IDs:** `server/config/script-request.json`
- **Quick-action buttons:** `extension/sidepanel.html` (`data-prompt`)
- **New tools** (e.g. time entry fixes, booking creation): add a definition and handler in `server/src/tools.js`. Use the `propose()` pattern for anything that writes.

## 6. Known limits / next steps

- Field names for the XML `Issue` type and custom fields must be confirmed against your account (step 1.4). Test SR creation in the sandbox first.
- Conversations live in server memory for 12 hours; restarting the server clears them, but SPP sign-ins persist.
- Large reports are capped at 200 rows per lookup sent to the model. For big data pulls, use SPP published reports (`published-reports`), which the assistant can read.
- Possible additions: attach generated scripts as SR attachments, a Code Review mode that diffs a script against its SR spec, Slack notifications on SR stage changes.
