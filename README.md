# Nemesis Cosmetic Backend

This service shares equipped capes and wings between Nemesis clients. It keeps
short-lived presence data in memory; clients refresh their state automatically,
and stale users disappear after 45 seconds.

The admin dashboard shows active Nemesis users and their equipped cosmetic IDs.
Players only receive cosmetic data for the players currently loaded in their
Minecraft world.

## Run locally

1. Install Node.js 18 or newer.
2. Run `npm start` inside this directory.
3. Open `http://127.0.0.1:8787/admin`.
4. Enter the `ADMIN_TOKEN` stored in `.env`.

The distributed client is configured for
`https://nemesis-cosmetics.onrender.com`. Older local-only configuration files
are migrated automatically, so users do not need to edit anything.

Changing a cape, wings, or wing animation state publishes the new value
immediately. While another wing user is visible, clients fetch movement-state
changes at 10 Hz; otherwise presence refreshes run every two seconds. All
networking stays on a low-priority background thread, so rendering never waits
for the backend.

## Deploy

### Free Render deployment

The backend folder includes its own `render.yaml` Blueprint, so it can be put
in a small separate GitHub repository without uploading the Minecraft client.
Choose **New > Blueprint** in Render, connect that repository, and use the
default `render.yaml` path. When prompted, copy `COSMETIC_API_KEY` and
`ADMIN_TOKEN` from the local `.env` file. Render supplies `PORT` and the public
HTTPS URL automatically. Never upload or commit the `.env` file itself.

Build the included Dockerfile or run `node server.js` on a Node host. Set these
environment variables on the host:

- `PORT`
- `COSMETIC_API_KEY` — must match every distributed client's API key
- `ADMIN_TOKEN` — only used by the protected admin endpoint
- `PRESENCE_TTL_SECONDS` (optional, defaults to 45)

After deployment, change `backendUrl` in the client's
`Client Config/CosmeticSync.properties` to the public HTTPS address. Never ship
the admin token inside the client.

Every distributed build must contain the same cosmetic IDs and assets. The API
key is included in clients and therefore prevents casual/accidental requests,
but it is not identity proof against a modified client. Keep the admin token
private; it is never required by the game client.

## Endpoints

- `GET /health` — service health and online count
- `POST /v1/sync` — authenticated client presence/query endpoint
- `GET /admin` — live admin dashboard
- `GET /v1/admin/players` — bearer-token protected presence list
