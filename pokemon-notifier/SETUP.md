# Pokemon Release Notifier - Setup Guide

Automatically checks for new Pokemon game/product announcements and emails you.

## Sources Monitored

| Source | What it checks |
|--------|---------------|
| **Pokemon.com** | Official Pokemon Company news page |
| **Serebii.net** | Front-page news headlines |
| **PokemonDB** | News articles |
| **Reddit** | r/pokemon, r/NintendoSwitch, r/PokemonScarletViolet |
| **X / Twitter** | @Pokemon, @NintendoAmerica, @SerebiiNet (via Nitter RSS) |

## Schedule

Runs automatically via GitHub Actions at **9:00 AM UTC** and **12:00 PM UTC** daily.
You can also trigger it manually from the Actions tab.

## Setup (Required)

You need to configure **GitHub Secrets** so the notifier can send emails.

### 1. Go to your repo Settings

Navigate to: **Settings → Secrets and variables → Actions → New repository secret**

### 2. Add these secrets

| Secret Name | Value | Example |
|-------------|-------|---------|
| `EMAIL_SENDER` | Your sending email address | `yourname@gmail.com` |
| `EMAIL_PASSWORD` | App password (NOT your regular password) | `abcd efgh ijkl mnop` |
| `EMAIL_RECIPIENT` | Email address to receive alerts | `yourname@gmail.com` |
| `SMTP_SERVER` | *(Optional)* SMTP server, defaults to `smtp.gmail.com` | `smtp.gmail.com` |
| `SMTP_PORT` | *(Optional)* SMTP port, defaults to `587` | `587` |

### 3. Gmail App Password Setup

If using Gmail:

1. Go to [Google Account Security](https://myaccount.google.com/security)
2. Enable **2-Step Verification** if not already on
3. Go to [App Passwords](https://myaccount.google.com/apppasswords)
4. Generate a new app password for "Mail"
5. Use that 16-character password as `EMAIL_PASSWORD`

### 4. Adjust the schedule (optional)

Edit `.github/workflows/pokemon-notifier.yml` to change the cron times.
The cron expressions use **UTC** time. Convert to your timezone as needed.

```yaml
schedule:
  - cron: "0 9 * * *"   # 9:00 AM UTC
  - cron: "0 12 * * *"  # 12:00 PM UTC
```

## Running Locally

```bash
cd pokemon-notifier
pip install -r requirements.txt

# Set environment variables
export EMAIL_SENDER="you@gmail.com"
export EMAIL_PASSWORD="your-app-password"
export EMAIL_RECIPIENT="you@gmail.com"

python notifier.py
```

## How Deduplication Works

The notifier stores hashes of seen announcements in `seen.json`. After each run,
GitHub Actions commits the updated file so you won't get duplicate alerts.
