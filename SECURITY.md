# Security policy

Rupelian is in active development. There is no supported stable release series yet.

Please report suspected vulnerabilities privately through [GitHub's private vulnerability reporting](https://github.com/hamides-dev/rupelian/security/advisories/new). Do not disclose API keys, browser cookies, personal media, or exploit details in a public issue. No response-time guarantee is currently offered.

Include the affected commit or version, Windows version, reproduction steps, expected impact, and a minimal example without personal data. For ordinary bugs and feature requests, use the issue templates.

API keys and browser playback access are encrypted for the current Windows account with DPAPI. AI requests and YouTube playback still require communication with their selected external services. Never commit Documents data, browser profiles, `.env` files, cookies, or local credential files.
