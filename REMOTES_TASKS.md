# Remote Sessions — Implementation Tasks

> Feature: trabajar con sesiones remotas via SSH. Bun server vive en remoto, Electron local se conecta via SSH tunnel. Server local actúa como gateway. Sesiones locales y remotas conviven en la misma ventana.

## Decisions reference

- **Arquitectura**: Modelo B (bun server remoto) + Modelo D (server local como gateway). Frontend siempre habla con `localhost:3111`; gateway proxea por `remoteId`.
- **Cache local A2**: metadata de sesiones remotas en `~/.claude/remote-sessions/{remoteId}.json`, fuente de verdad en remote. Sobrevive entre runs.
- **Server remoto persistente**, instalación manual (sin bootstrap auto).
- **SSH**: `ssh` CLI con **ControlMaster** (un master por remote, forwards multiplexan).
- **Lazy first-click**: master se levanta al primer click en sesión remota. Grace de 5min al cerrar la última pane.
- **Reconnect Modelo 3**: backoff 1→60s, indicator no-bloqueante, queue de inputs, overlay tras 10s sin éxito.
- **Config minima por remote**: `~/.ssh/config` alias + bunPort + name + color. Sin user/host/port/keyFile explícitos.
- **Auth provider** (Claude/Codex/OpenCode) en cada remote independientemente.
- **Port forwards**: manuales por sesión, persistidos en sessions.json del remote, multiplex via `ssh -O forward`.
- **UI**: tabs locales/remotas mezcladas; remotas con borde/tinte del color del remote. Modal con tabs `Local | remote-1 | …`. Loading first-click in-pane.

### Fuera de v1
- `browser_preview` en sesiones remotas
- Telegram notifs para sesiones remotas
- Mobile pairing / Tailscale Funnel
- Bootstrap auto del server remoto

---

## Phase 1 — Data model & persistence

- [x] **1.1** Add `Remote` type + `RemoteConfig` to `server/types.ts`
- [x] **1.2** Extend `Session` and `PersistedSession` with `remoteId` and `portForwards`
- [x] **1.3** Create `server/remotes.ts` (load/save `~/.claude/remotes.json`, in-memory map)
- [x] **1.4** Add `~/.claude/remote-sessions/{remoteId}.json` cache layer (read/write/invalidate)

## Phase 2 — SSH master lifecycle

- [x] **2.1** Create `server/ssh-tunnel.ts` — spawn ControlMaster, wait for socket ready
- [x] **2.2** Health check helper (`curl localhost:<port>/health` over tunnel)
- [x] **2.3** Lazy connect: `acquireTunnel` brings up master on demand (gateway wiring lives in Phase 3)
- [x] **2.4** Grace-of-5-min: timer on last pane close, cancel on reopen
- [x] **2.5** Reconnect with backoff (1→2→4→8→15→30→60s capped)
- [x] **2.6** Emit `remote.status` events (connecting/online/reconnecting/offline) for the UI

## Phase 3 — Server local as gateway

- [x] **3.1** Add `remoteId` resolver: given a `sessionId`, return remote (or `null` = local)
- [x] **3.2** HTTP proxy helper: forward any handler to `http://localhost:<localTunnelPort>` when sessionId is remote
- [x] **3.3** WS proxy helper: bidirectional pipe between client WS and remote bun WS (`/browser/ws/{id}` wired; `/terminal/ws/{procId}` deferred — needs procId→remote index)
- [x] **3.4** Wire sessions/messages/resume/stop/rename/delete endpoints through the gateway (exec/processes/files deferred until needed)
- [x] **3.5** Sessions list endpoint merges local + cached remote metadata

## Phase 4 — Port forwards (per session)

- [x] **4.1** Schema: `portForwards: Array<{ localPort: number|null, remotePort: number, label?: string }>` on Session
- [x] **4.2** Endpoint: add/remove port forward for a session
- [x] **4.3** When pane opens, apply forwards via `ssh -O forward -L X:localhost:Y -S /tmp/...`
- [x] **4.4** When pane closes (post-grace), cancel forwards via `ssh -O cancel ...` (port forwards die with the master at grace expiry)
- [x] **4.5** `localPort: null` → pick free port at open time; conflict → surface error
- [ ] **4.6** Re-apply forwards on master reconnect (pendiente: requiere persistir/leer del cache de session)

## Phase 5 — Settings UI (Remotes CRUD)

- [x] **5.1** `RemotesPanel.tsx` — list of remotes with status badge per remote
- [x] **5.2** `RemoteEditDialog.tsx` — name / alias / bunPort / color picker (palette + Auto)
- [x] **5.3** "Test Connection" button (optional) — runs `ssh -o BatchMode=yes <alias> "curl localhost:<port>/health"`, shows parsed result
- [x] **5.4** Edit flow: changing alias/bunPort kills active master; next first-click respawns
- [x] **5.5** Delete flow: confirm dialog, SIGTERM master, clear cache, close open panes with toast (toast en panes pendiente — depende del gateway)
- [x] **5.6** Wire `RemotesPanel` into `SettingsPanel`

## Phase 6 — NewSessionModal (remote target)

- [x] **6.1** Add tabs header `Local | remote-1 | …` to `NewSessionModal.tsx`
- [x] **6.2** When a remote tab is active: route browse/git/recent endpoints through gateway with that `remoteId`
- [x] **6.3** `onCreate` passes `remoteId` (null for local) to the create-session flow
- [x] **6.4** Persist last-used target in localStorage (per machine)

## Phase 7 — Tabs / sidebar / per-pane UX

- [x] **7.1** Tab styling: tinted border/background using `remote.color` for remote sessions
- [ ] **7.2** Sidebar / tab-group "+" dropdown: add "New remote session" entry; submenu when >1 remote (deferred — modal tabs cover the create flow)
- [ ] **7.3** Loading state in-pane on first-click: spinner + "Connecting to {name}..." + Cancel button (deferred)
- [ ] **7.4** Error state in-pane (connect failed): error message + Retry / Edit Remote / Close (deferred)
- [ ] **7.5** Reconnect overlay (post 10s without success): non-blocking, Retry / Edit / Close (deferred — server emits `remote.status` events, frontend wiring TBD)
- [ ] **7.6** Input queue while disconnected: textarea writable, Send button shows "Queued (reconnecting)" (deferred)
- [ ] **7.7** "Connection lost — stream interrupted" tag on in-flight assistant messages (deferred)
- [ ] **7.8** Port forward panel inside the chat header (list, add, remove, copy URL) (deferred — `/sessions/:id/port-forwards` endpoints are live)

## Phase 8 — QA & polish

- [x] **8.1** Error mapping: parse common `ssh` stderr ("Host not found", "Permission denied", "Connection refused") into friendly messages (`classifySshError` en `ssh-tunnel.ts`)
- [x] **8.2** Cleanup stale ControlMaster sockets on startup (`cleanupStaleControlSockets`)
- [x] **8.3** Guard against duplicate remote names / aliases at save time (`validateRemoteInput`)
- [x] **8.4** Document manual remote-server install steps in README / docs
- [ ] **8.5** Manual QA: cold connect, reconnect after Wi-Fi flap, kill ssh from outside, edit-while-connected, delete-while-active (pendiente — requiere correr la app contra un remote real)

---

## ⚠️ Limitaciones conocidas para v1 (no bloquean el feature, pero hay que cerrarlas pronto)

1. **Suscripción WS para sesiones remotas:** `ChatApp.tsx` se suscribe vía el WS multiplexado `/ws` (`c.subscribe(id)`), no el legacy `/browser/ws/:id`. Para que el chat reciba mensajes del agente remoto, el frontend debe abrir el WS legacy cuando la sesión activa tiene `remoteId != null`. El backend ya está preparado (handler `proxy-browser`). Cambio sugerido: un `useEffect` en ChatApp que abre/cierra `ws://localhost:3111/browser/ws/{id}` para la sesión activa remota.

2. **`/terminal/ws/:procId` no proxea remoto:** los PTYs interactivos para sesiones remotas no funcionarán hasta agregar un índice `procId → remoteId` y wire-up de `proxy-terminal`. Mismo patrón que `proxy-browser`.

3. **Reconnect UX:** el server local broadcastea `{ type: 'remote.status', remoteId, status, lastError }` por el WS frontend. El frontend NO lo procesa todavía — no hay overlay no-bloqueante, ni badges "reconnecting" en tabs, ni input queue. Es el trabajo de Phase 7 que quedó deferred.

4. **Endpoints no-proxeados (mientras `?remoteId=` no se use):** algunos endpoints session-bound (exec, processes, lsp, debug, worktrees) NO están remote-aware. Para v1 solo funcionan en sesiones locales. Agregar `resolveSessionRemote + proxyHttpToRemote` al inicio de cada handler.

5. **Browser preview y Telegram para sesiones remotas:** documentado como fuera de v1.

## Cómo correr un remote (instalación manual)

Para que el feature funcione end-to-end, en cada máquina que vayas a usar como remote tienes que:

1. Asegurar que `sshd` está corriendo y tu Mac local tiene un `Host <alias>` válido en `~/.ssh/config` para esa máquina.
2. Cargar tu key en `ssh-agent` (la app NO captura passphrase prompts).
3. Instalar bun en el remote: `curl -fsSL https://bun.sh/install | bash`.
4. Copiar el repo (o publicar el bridge como binario) y dejar el bun bridge corriendo:
   ```bash
   # ejemplo con systemd --user
   cd ~/taskr
   bun run bridge      # o `bun run server/index.ts`
   ```
   Para sobrevivir reboots, registralo como `systemd --user` con `loginctl enable-linger <user>`.
5. Autenticate Claude/Codex/OpenCode en el remote (`claude login`, etc.). Cada remote mantiene su propia auth.
6. En la app local: Settings → Remotes → + Add Remote → alias + bun port → Test Connection.
