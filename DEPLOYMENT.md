# Deployment

Two machines in **ap-south-1 (Mumbai)**, same default VPC:

| Machine | Runs | Managed by |
|---|---|---|
| `fundednext-bot-prod` (Ubuntu, existing) | Node bot + dashboard (PM2) | GitHub Actions `deploy-bot.yml` (SSH) |
| `fundednext-bot-mt5` (Windows Server 2022) | MT5 terminal + `bridge/` | Terraform + `deploy-bridge.yml` (SSM) |

> Free tier: two instances share the 750 free hours/month, so running both 24/7 costs roughly one
> t3.micro beyond the free hours (or is covered by the new-account credits). Windows needs a 30 GB
> disk; Ubuntu 8 GB → 38 GB total vs 30 GB free (≈ $1/month).

---

## 1. Windows MT5 host (Terraform)

Prereqs on your laptop: [Terraform ≥ 1.5](https://developer.hashicorp.com/terraform/install), AWS CLI logged in (`aws configure`).

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # MT5 login/password, your IP, bot private IP
terraform init
terraform apply
```

Outputs you need:

| Output | Use |
|---|---|
| `bridge_url` | bot `.env` → `MT5_BRIDGE_URL` |
| `read_secrets` | commands to print the bridge token + Windows password |
| `mt5_host_instance_id` | GitHub secret `WINDOWS_INSTANCE_ID` |
| `github_deploy_role_arn` | GitHub secret `AWS_DEPLOY_ROLE_ARN` |

First boot takes ~15 min (Git, Python, MT5, bridge, auto-logon, reboot). Log: `C:\fundednext-bootstrap.log`.

### One-time manual step (RDP, ~3 min)

The generic MT5 installer may not know FundedNext's server yet, and **Algo Trading** must be switched on once:

1. RDP to `mt5_host_public_ip`, user `Administrator`, password from `read_secrets`.
2. In MT5: **File → Open an Account** → search **FundedNext** → select **FundedNext-Server3** → *Connect with an existing account* → login.
3. Click **Algo Trading** in the toolbar (green). **Tools → Options → Expert Advisors**: tick *Allow algorithmic trading*.
4. Close RDP **with "Disconnect"** (not Sign out) — the session must stay logged on.

Check from the Ubuntu box:

```bash
curl http://<mt5-private-ip>:8765/health          # {"ok":true,"tradeAllowed":true,...}
```

> The bridge only accepts traffic from `bot_private_ip` (security group) and requires the bearer token.

---

## 2. Bot on Ubuntu (`fundednext-bot-prod`)

On the server, the repo must be a git clone at `/home/ubuntu/fundednext-trading-bot` with PM2 installed.

```bash
cd ~/fundednext-trading-bot
cp .env.example .env && nano .env
#   DATA_SOURCE=mt5
#   MT5_BRIDGE_URL=http://<mt5-private-ip>:8765
#   MT5_BRIDGE_TOKEN=<bridge_token from SSM>
#   DRY_RUN=true                       ← paper trades on real prices first
#   GROQ_API_KEY=... GROQ_API_KEY_2=...
#   TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=...
#   DASHBOARD_PASSWORD=<new strong password>
npm ci && npm run build
pm2 start ecosystem.config.js && pm2 save
```

Old env names `LONDON_OPEN_HOUR/…`, `FUNDEDNEXT_API_KEY`, `MARKET_DATA_API_KEY` are no longer used — delete them.

---

## 3. GitHub Actions

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|---|---|
| `EC2_HOST` | Ubuntu public IP / DNS (`3.7.248.184`) |
| `EC2_USER` | `ubuntu` |
| `EC2_SSH_KEY` | full contents of the `.pem` key |
| `APP_DIR` | `/home/ubuntu/fundednext-trading-bot` (optional, this is the default) |
| `WINDOWS_INSTANCE_ID` | Terraform output `mt5_host_instance_id` |
| `AWS_DEPLOY_ROLE_ARN` | Terraform output `github_deploy_role_arn` |

Optional **variable** `AWS_REGION` (default `ap-south-1`).

| Workflow | Trigger | Does |
|---|---|---|
| `ci.yml` | PRs, non-main pushes | lint, type-check, Jest, build · bridge pytest (mock MT5) · terraform validate |
| `deploy-bot.yml` | push to `main` (not bridge/infra/docs) | CI → SSH → `scripts/deploy-remote.sh` (pull, build, `pm2 reload`, health check) |
| `deploy-bridge.yml` | push to `main` touching `bridge/` or `scripts/windows/` | CI → OIDC → SSM → `scripts/windows/deploy.ps1` (pull, pip, restart, health check) |

Deploy jobs skip cleanly while their secrets are missing. SSH from GitHub runners needs port 22 open on the
Ubuntu security group. Restarts don't close trades.

---

## 4. Testing stages

1. `DATA_SOURCE=mt5`, `DRY_RUN=true` — real prices, paper trades. Watch the dashboard + Telegram for a few sessions.
2. `npm run backtest -- --bars 5000` on the server — check trade frequency and win rate on real history.
3. `DRY_RUN=false` on the **FundedNext demo** — real orders. Start the day watching the first trade.

---

## 5. Moving to a new AWS account (free tier ended)

1. **Back up** the trade history from the old bot:
   `scp -i key.pem -r ubuntu@<old-ip>:~/fundednext-trading-bot/data ./backup-data`
2. New account: `aws configure` with the new keys.
3. `terraform.tfvars`: set `create_bot_instance = true`, `bot_private_ip = ""` (+ `create_github_oidc_provider = true`).
4. `rm -rf .terraform terraform.tfstate*` (old account's state) → `terraform init && terraform apply`.
5. Ubuntu: copy `.env` + `backup-data/` to the new box (`scp`), then `pm2 start ecosystem.config.js && pm2 save`.
   Update `MT5_BRIDGE_URL` to the new `bridge_url`.
6. Windows: repeat the one-time RDP step.
7. Update GitHub secrets: `EC2_HOST`, `EC2_SSH_KEY`, `WINDOWS_INSTANCE_ID`, `AWS_DEPLOY_ROLE_ARN`.
8. Old account: `terraform destroy` (with the old state) or terminate instances manually.

Everything else (bootstrap, secrets in SSM, deploy pipelines) is recreated by step 4.

---

## Troubleshooting

| Symptom | Check |
|---|---|
| Dashboard `DATA: MT5` + errors / Telegram "MT5 bridge error" | `curl <bridge>/health`; RDP → is the session logged on? `C:\fundednext-bot\bridge\logs\bridge.log` |
| Orders rejected `AutoTrading disabled` | Algo Trading button in MT5 (one-time step 3) |
| `tradeAllowed:false` in `/health` | same as above |
| "AI review unavailable" | Groq keys / quota; Telegram shows which key failed |
| Bridge deploy fails "did not become healthy" | Administrator session was signed out → RDP in once (auto-logon fixes it after a reboot) |
