# Live check against a Wallabag server

**Result: PASS, passed=18, failed=0** (30 Oct 2026, ~10:00 Accra, GMT).

Server: real Wallabag 2.6.15 (official release tarball), run locally on 127.0.0.1:8099 with PHP 8.3.32 (static build, built-in web server) and SQLite. Throwaway user and OAuth client (password + refresh_token grants) created for the check; no real data. `DATABASE_URL` unset. Server and data torn down afterwards.

Command: `WALLABAG_BASE_URL=... WALLABAG_CLIENT_ID=... WALLABAG_CLIENT_SECRET=... WALLABAG_USERNAME=... WALLABAG_PASSWORD=... WALLABAG_ALLOW_WRITES=true npm run live-check`

Checks (all PASS): lists tools, info, version, config, user, user redacts secrets, tags, entries, search, entry unknown id (404), entry create preview, entry create (confirm), tag preview, tag, annotate preview, annotate, annotation delete, entry delete.

Auth path exercised live: OAuth2 password grant. Pre-issued token mode and refresh are mock-tested only. Other routes (of 29 mapped) are mock-tested only.

Caveats: the static PHP build lacked ext-intl and ext-tidy (Wallabag 2.6 lists both); the API paths above worked without them.
