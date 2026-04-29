# HYROX GitHub Actions Setup

This project includes a GitHub Actions workflow at `.github/workflows/hyrox-monitor.yml`.

## What it does

- Runs every 15 minutes
- Opens the HYROX checkout page
- Selects `Relay -> Open -> Women`
- Detects whether `HYROX WOMENS RELAY 여자 릴레이 | SUNDAY` is still sold out
- Sends a Slack alert only when the status changes from `sold_out` to another state

## What you still need

1. Put this folder in a GitHub repository
2. Add a GitHub Actions secret named `HYROX_SLACK_WEBHOOK_URL`
3. Use a Slack Incoming Webhook that posts into the `Hyrox` workspace `#alert` channel

## Notes

- GitHub Actions is free for public repositories on standard GitHub-hosted runners.
- For private repositories, GitHub Free currently includes 2,000 Actions minutes per month.
- This workflow uses Playwright and Chromium, so it depends on GitHub Actions network access.
