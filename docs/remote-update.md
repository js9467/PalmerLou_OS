# Remote Access and Update Flow

Palmer Lou OS supports remote troubleshooting and remote update execution behind Starlink CGNAT using outbound-only tunnel patterns.

## Reverse tunnel model

- No inbound port forwarding is required.
- Configure tunnel mode with `PALMER_LOU_REMOTE_ACCESS_MODE`:
  - `tailscale` (default)
  - `cloudflared`
  - `custom`
  - `disabled`
- Use environment command hooks so service control remains explicit and auditable:
  - `PALMER_LOU_REMOTE_TUNNEL_STATUS_COMMAND`
  - `PALMER_LOU_REMOTE_TUNNEL_START_COMMAND`
  - `PALMER_LOU_REMOTE_TUNNEL_STOP_COMMAND`
  - `PALMER_LOU_REMOTE_TUNNEL_RESTART_COMMAND`

Optional labels and links shown in the Settings UI:

- `PALMER_LOU_REMOTE_ACCESS_LABEL`
- `PALMER_LOU_REMOTE_VIEW_URL`
- `PALMER_LOU_REMOTE_TROUBLESHOOT_URL`

## Backend endpoints

Remote access:

- `GET /api/remote/access`
- `POST /api/remote/access/action` with JSON body `{ "action": "status" | "start" | "stop" | "restart" }`

Remote update execution:

- `GET /api/remote/update`
- `POST /api/remote/update/apply`

Version metadata:

- `GET /api/version`
- `GET /api/update/check`

## Update feed manifest

Set `PALMER_LOU_UPDATE_FEED_URL` on the boat machine to enable latest-version checks.

Suggested payload:

```json
{
  "latestVersion": "0.2.0",
  "channel": "stable",
  "notes": "Weekend release for streaming and Bluetooth validation."
}
```

## Remote apply command

You can set an explicit command with `PALMER_LOU_REMOTE_UPDATE_COMMAND`.

If this value is not set and the backend is running on Linux, the server defaults to running:

```bash
PALMER_LOU_REPO_DIR=<repo-root> bash infrastructure/scripts/update.sh
```

Example explicit value:

```bash
PALMER_LOU_REMOTE_UPDATE_COMMAND="PALMER_LOU_REPO_DIR=/opt/palmer-lou bash /opt/palmer-lou/infrastructure/scripts/update.sh"
```

## Operational notes

- Run the backend as a service account with least privilege.
- Restrict who can reach the backend tunnel endpoint.
- Remote update state is guarded against concurrent execution.
- The Settings panel surfaces command output to speed home troubleshooting.
