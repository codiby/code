# Host coordination and automatic pairing

Bun owns `ui-remotes.json`. Electron now reads that registry through `GET /remotes`
instead of reading Bun's files. Its HTTP/WebSocket connections to each destination
still go directly through Electron's own SSH tunnels.

An agent calls its local MCP server. Remote session operations take a separate
path: local Bun → its SSH tunnel → destination Bun's restricted `/peer/tools`
endpoint. Electron is not involved in these operations. Both Bun processes must
remain running; quitting an app that owns its Bun sidecar still stops that server.

## Configuration

1. Add the destination in **Settings → Remotes** using the existing SSH connection.
   The optional server alias is resolved on Bun's host; the desktop alias is
   resolved on Electron's host. Leave the server alias blank to use the same one.
2. Choose **Pair both hosts**. The dialog suggests this computer's LAN address and
   user; adjust it if the other host needs a different address. Choose its SSH
   port and read-only or read/write permissions for agents in both directions.
3. Codiby creates a dedicated SSH key on the destination, exchanges only its public
   half, and authorizes it on the first host. It pins the first host's SSH public
   host keys, creates the return record on the destination, and verifies that the
   return connection reaches the expected Bun identity before enabling both sides.

SSH / Remote Login must already be enabled on the first computer, and its address
must be reachable from the destination. Codiby does not enable system services or
change firewall rules. An unreachable address or disabled SSH produces a setup
error and rolls back the generated authorization and connection records.

**Test desktop** tests Electron's direct connection. **Test server** tests Bun's
independent connection and protocol compatibility. **Pairing… → Unpair** revokes
MCP access immediately, removes the generated authorization, and restores any
previous return record. If the other host is offline, local revocation still works;
the dialog reports that remote cleanup remains pending. Remove the stale pairing
on that host when it is reachable. Unpair before changing a paired route's
connection details or permissions. Both hosts must run this server version.

Pairing survives Bun restarts. It does not use Electron as a relay, a reverse SSH
forward, or a bidirectional WebSocket: each tool calls `/peer/tools` on the target
over its own reusable SSH connection. The generated private key stays on the
machine that uses it, under `~/.codiby/pairing/keys/`. Existing personal private
keys and SSH config are not copied or rewritten.

## MCP

- `ui_list_hosts` discovers enabled peers and reports disabled/offline peers separately.
- `ui_list_sessions`, `ui_read_session_messages`, `ui_send_message`, and
  `ui_spawn_session` accept `host_id`. Omission or `local` preserves local behavior.
- Use the persistent `host_id` from discovery together with the destination's
  `session_id`. `rmt_…` registry IDs are also accepted for a configured route.
- Paths, group IDs and worktree options belong to the destination host.
- For remote writes, supply a unique `request_id`. Retries must reuse it and the
  same arguments. If omitted, a generated ID is returned in the result/error.
- Reads with `since_seq` return the next page and `next_seq` / `has_more`, so a
  context consumer does not skip messages when more than one page arrives.

Example sequence:

```text
ui_list_hosts({})
ui_list_sessions({host_id: "host_…"})
ui_read_session_messages({host_id: "host_…", session_id: "…", since_seq: 0, limit: 20})
ui_send_message({host_id: "host_…", session_id: "…", request_id: "auth-question-1", text: "What did you decide about authentication?"})
```

## Delivery and trust

Peer calls execute only the four allowed session operations, locally at the
destination. Nested host routing, incompatible protocols and wrong destination
identities are rejected. `/peer/tools` checks the TCP source address and accepts
only loopback/SSH traffic; an HTTP Host header cannot grant access. Remote MCP
calls also require a pairing ID and secret token, bound to the source host and
checked against the receiving host's read/write permission. Tokens live only in
the private pairing journal, never in the frontend registry. The token is scoped
to MCP; the trusted OS account and the generated SSH credential can reach the Bun
bridge API. The generated key denies shell execution and restricts local SSH
forwarding to this bridge's port. Enrollment uses the existing trusted SSH account.

Setup authorization expires after ten minutes until the pair is committed.
Incomplete setup is journaled and cleaned on recovery/maintenance; failed probes
and lost commit replies are compensated. Removing a pairing invalidates its MCP
token even for SSH connections that were already established. A peer that was
unreachable during cleanup retains a stale record, not valid access to the host
that revoked it.

Write receipts are persisted before dispatch and deduplicate concurrent retries
and retries after a server restart. A crash during dispatch produces an explicit
unknown outcome instead of repeating the operation. Accepted means the local
operation returned, not that the agent completed its task. Messages include their
source host/session/request. Busy destination sessions reject peer sends; wait and
use a new request ID after they become idle.

Electron and Bun use separate SSH socket directories (`ssh-control` and
`ssh-control-server`). Bun tears down its own connections on shutdown or remote
configuration changes. Registry writes use atomic replacement.

## Remaining stages

Durable queuing for busy/offline sessions, task completion notifications, and
host-qualified UI links/cache keys are not part of this first implementation.
The desktop's existing session aggregation is unchanged; the new host-qualified
addressing is used by the MCP coordination protocol.

## Validation

```sh
bun test packages/core/network/pairing.test.ts packages/core/network/peers.test.ts packages/core/mcp/mcp.test.ts packages/desktop/remotes.test.ts
bun run electron:typecheck
bun run build-server
```

The peer tests exercise two host identities over real local HTTP with an injected
connection transport; they do not require Electron, configured SSH accounts or paid agents. Key generation is also tested with the installed ssh-keygen.
Physical cross-machine SSH and the installed app require a separate deployment test.
