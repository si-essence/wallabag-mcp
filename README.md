# wallabag

MCP connector for a [Wallabag](https://github.com/wallabag/wallabag) server. It speaks the REST API over stdio and over stateless Streamable HTTP on `127.0.0.1`.

Wallabag is MIT-licensed software. This connector does not copy that PHP. It only calls the HTTP API on the server you configure. It is not affiliated with Wallabag. Create an API client in your Wallabag account under Developer, then use the OAuth2 password grant, or pass a pre-issued access token.

The operations table is generated from `vendor/routes.json`, a route snapshot derived from wallabag 2.6.15 ApiBundle controllers (MIT). The snapshot has 35 routes. This connector covers 29 of them in 7 tools. It leaves out 6 endpoints that export files or serve the HTML developer portal. `scripts/gen-operations.mjs` writes `src/operations.ts`. Do not edit that file by hand.

Self-hosted servers first. There is no default base URL. `WALLABAG_BASE_URL` is required. A path prefix is allowed, for example `https://example.com/wallabag`.

## Setup

```bash
npm install
npm run ci
npm start
npm run start:http
```

`npm start` speaks stdio. `npm run start:http` serves Streamable HTTP at `http://127.0.0.1:3000/mcp` and `GET /health`. HTTP mode has no authentication of its own. Keep it on localhost.

```json
{
  "mcpServers": {
    "wallabag": {
      "command": "node",
      "args": ["/workspace/connectors/wallabag/dist/index.js"],
      "env": {
        "WALLABAG_BASE_URL": "http://127.0.0.1:80",
        "WALLABAG_CLIENT_ID": "...",
        "WALLABAG_CLIENT_SECRET": "...",
        "WALLABAG_USERNAME": "...",
        "WALLABAG_PASSWORD": "...",
        "WALLABAG_ALLOW_WRITES": "false",
        "WALLABAG_TOOLSETS": "entries,tags,annotations,search,config,info"
      }
    }
  }
}
```

You can set `WALLABAG_ACCESS_TOKEN` instead of the password-grant variables.

Docker (HTTP, no authentication, keep it on localhost):

```bash
docker build -t wallabag .
docker run -p 127.0.0.1:3000:3000 \
  -e WALLABAG_BASE_URL=http://127.0.0.1:80 \
  -e WALLABAG_ACCESS_TOKEN=... \
  wallabag
```

Do not put tokens in the image.

Regenerate the registry after a Wallabag route bump.

```bash
npm run gen:operations
```

`scripts/live-check.mjs` talks to a real server over stdio. It needs `WALLABAG_BASE_URL` and either `WALLABAG_ACCESS_TOKEN` or the password-grant variables. It sets `WALLABAG_TOOLSETS=all`. Gated writes run only when `WALLABAG_ALLOW_WRITES=true`. It prints pass or fail lines only. This workspace does not start Wallabag.

## Config

| Variable | Meaning |
| --- | --- |
| `WALLABAG_BASE_URL` | Required. Origin, `http` or `https`, no userinfo, query, or hash. A path prefix is allowed. Example `http://127.0.0.1:80`. |
| `WALLABAG_CLIENT_ID` | OAuth2 client id from Developer → create a client. Required with the other password-grant variables when no access token is set. |
| `WALLABAG_CLIENT_SECRET` | OAuth2 client secret. Redacted in logs, errors, and tool output. |
| `WALLABAG_USERNAME` | Wallabag username or email for the password grant. |
| `WALLABAG_PASSWORD` | Wallabag password. Redacted everywhere. |
| `WALLABAG_ACCESS_TOKEN` | Optional pre-issued Bearer token. Used until HTTP 401. If password-grant variables are also set, a 401 tries `refresh_token` then the password grant. |
| `WALLABAG_ALLOW_WRITES` | Must be the literal `true` before a confirmed write is sent. |
| `WALLABAG_TOOLSETS` | Comma list of toolsets, or `all`. Default is the set below. `user` is off by default because `PUT /api/user` registers an account. |
| `WALLABAG_PER_MINUTE` | Local request budget. Default 30. Cache hits do not spend it. |
| `WALLABAG_TIMEOUT_MS` | Upstream timeout. Default 20000. |
| `WALLABAG_CACHE_TTL_SEC` | Read cache TTL. Default 60. Writes clear the cache. |
| `WALLABAG_CONTACT` | Contact token in the User-Agent. Must not contain a secret. |
| `MCP_TRANSPORT` | `stdio` or `http`. `--http` overrides. |
| `PORT` | HTTP port. Default 3000. Bound to `127.0.0.1`. |

Invalid values are reported by field name and issue code. The rejected value is not included. Tokens, passwords, and client secrets are redacted in logs, errors, tool results, thrown messages, and URLs.

Auth is `POST /oauth/v2/token` with `grant_type=password` and `application/x-www-form-urlencoded`, then `Authorization: Bearer <access_token>`. A stored `refresh_token` is used after HTTP 401. The connector never puts credentials in the API URL.

## Safety

GET is a read. POST, PUT, PATCH, and DELETE are writes.

A write needs `confirm: true` as a boolean and `WALLABAG_ALLOW_WRITES=true`. The string `"true"` is rejected. Otherwise the tool returns a dry-run preview of method, path, query, and redacted body, and it sends nothing. Deletes, bulk URL lists, and user registration add a warning line on the tool and on the preview.

`PUT /api/user` can return a new OAuth `client_secret`. That value is shown once. Later calls redact it. User `email`, `password`, `token`, `refresh_token`, and `client_secret` are redacted. Error text drops stack traces and filesystem paths.

HTTP 401 is unauthorized. HTTP 403 is forbidden. HTTP 404 is not found. HTTP 400 and 422 are invalid input. HTTP 429 includes Retry-After. Other failures are server, network, or timeout. Response bodies are capped.

Entry export (epub, pdf, and related files) is not exposed. The HTML developer portal is not exposed.

## Tools

Default `WALLABAG_TOOLSETS` publishes 6 tools. `WALLABAG_TOOLSETS=all` publishes 7 tools (29 operations). Each tool takes `action` plus optional `params`, `query`, `body`, and `confirm`.

`action` `help` with optional `target` returns the path, query, and body fields for one action. Descriptions list action names only, so the tool list stays small.

| Toolset | Tool | Default |
| --- | --- | --- |
| entries | `wallabag_entries` | yes |
| tags | `wallabag_tags` | yes |
| annotations | `wallabag_annotations` | yes |
| search | `wallabag_search` | yes |
| config | `wallabag_config` | yes |
| info | `wallabag_info` | yes |
| user | `wallabag_user` | no |

`wallabag_config` includes `GET /api/config` and tagging-rule export. `wallabag_info` includes `GET /api/info` and `GET /api/version`.
