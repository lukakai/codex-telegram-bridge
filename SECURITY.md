# Security Policy

## Supported version

Only the latest commit on `main` is currently supported. This project is experimental and has not received an independent production security audit.

## Reporting a vulnerability

Please do not open a public issue containing Bot Tokens, API keys, private commands, local paths, conversation text, or files from `state/`.

Use GitHub's private vulnerability reporting or contact the repository owner privately. Include the smallest reproduction possible with synthetic data. Never include a live credential.

If a Telegram Bot Token or another credential may have been exposed, revoke or rotate it at the provider immediately; removing it from the latest commit is not sufficient because Git history and forks may retain it.

## Deployment expectations

- Run the Bridge only on a trusted Mac user account.
- Use a dedicated Telegram Bot and a private one-to-one chat.
- Keep `state/` private and never commit it.
- Authorize only specific work directories.
- Review desktop takeover warnings and sandbox escalations before confirming them.
- Do not expose the process through an additional public network listener.
