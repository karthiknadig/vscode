# Successful custom-task callback retention

Proof for [microsoft/vscode#339537](https://github.com/microsoft/vscode/issues/339537).

| Additional retention after five measured cycles | Before | After |
| --- | ---: | ---: |
| Distinct-ID discovery, then provider disposal | 5 copies / 10 MiB | 0 copies / 0 bytes |
| No-discovery control | 0 bytes | 0 bytes |
| Same-ID discovery control | 0 bytes | 0 bytes |

Every cycle uses a **synthetic 2 MiB callback payload**. Each arm has one warmup and five measured cycles. All three independent fresh windows agree. Providers are unregistered, discovery is empty, and there are no active tasks or terminals at every sample. No callback is executed in this memory probe.

- [Comparison card](comparison.png)
- [Before](before.gif) and [after](after.gif): four-second **measured-data replays**, not real-time action playback
- [Raw per-cycle metrics and source hashes](metrics.json)
- [Unchanged portable scenario](repro/task-provider-retention.cjs) and [development extension](repro/extension/extension.cjs)

The metrics record exact fixture byte hashes used before and after, plus LF-normalized hashes for the published text files.

The valid byte signals are extension-host external memory and weakly observed live `Buffer.byteLength`. The existing baseline native snapshot confirms `ExtHostTask -> callback cache -> callback closure -> Buffer -> native backing store`. `arrayBuffers` is zero in this Electron runtime and is **not** the proof. The payload size is not a typical task-size or user-frequency estimate; elapsed times include forced GC and are not latency measurements.

## Reproduce

Download this folder, preserving the `repro` directory layout. Use a built VS Code source checkout with its scenario harness compiled and FFmpeg available. From that checkout:

```powershell
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:TERMINAL_HUNT_CAPTURE_HEAP = '0'
node test\scenario\out\runScenario.js --dev <evidence-folder>\repro\task-provider-retention.cjs
```

The scenario's unchanged `RELEASE` assertion requires under 1 MiB additional external memory after five distinct-ID cycles. The canonical Bug Swarm wrapper ran it three times on each build:

- Base `0817aaa824590067854c361e77eb973a08b3cf48`: **failed 3/3**, exactly 10 MiB retained each time.
- Final fix `93080fb83d00ebe1f34fab30c43ed53003a9dc08`: **passed 3/3**, zero additional external bytes and zero live callback payloads. These are three new windows measured after the startup review follow-up.

Client compilation, API-test compilation, 57 lifecycle/protocol tests plus the test-runner self-test, and nine real task API tests passed. The original 44 lifecycle and eight API tests are retained; one pre-existing API test remains skipped.

## Startup compatibility review

[Review 4175998774](https://github.com/microsoft/vscode/pull/339553#discussion_r4175998774) identified a verified regression in the initial PR commit `4ff52438`. Provider disposal could remove a callback before the main-thread start notification arrived. The fix reserves the callback before definition resolution and fences owner cleanup on the unregister reply, which follows earlier main-thread notifications on the same ordered IPC channel. Task end releases the reservation even before the extension host observes start; canceled startup cannot attach a late PTY or emit a late start. Callbacks still receive fully resolved variables.

| Same startup test | Base `0817aaa8` | Initial PR `4ff52438` | Final `93080fb8` |
| --- | --- | --- | --- |
| Suspended main-thread definition resolution | Pass | Fail: no callback/PTY | Pass |
| Provider disposal before startup IPC delivery | Pass | Fail: no callback/PTY | Pass |
| IPC delay with no suspended resolver | Pass | Fail: no callback/PTY | Pass |
| Real workbench Run Task, disposal in terminal-open event before callback/start event | Pass | Fail: no terminal output, timeout | Pass |

The pinned baseline/initial-PR task modules were temporarily transpiled into the isolated worktree output, tested with the same final assertions, then restored. No source checkout or branch switch was used. The real API test checks exact terminal output, complete workspace-folder substitution, task completion, empty discovery and no active execution.

Exact final commands, all passed:

```powershell
npm run gulp compile-client compile-extension:vscode-api-tests
scripts\test.bat --run src\vs\workbench\api\test\node\extHostTask.test.ts --run src\vs\workbench\api\test\browser\mainThreadTask.test.ts
scripts\test-integration.bat --suite api-folder --grep "vscode API - tasks"
npx --no-install eslint --max-warnings 0 src\vs\workbench\api\common\extHostTask.ts src\vs\workbench\api\browser\mainThreadTask.ts src\vs\workbench\api\common\extHost.protocol.ts src\vs\workbench\api\node\extHostTask.ts src\vs\workbench\api\test\node\extHostTask.test.ts src\vs\workbench\api\test\browser\mainThreadTask.test.ts extensions\vscode-api-tests\src\singlefolder-tests\workspace.tasks.test.ts
```

Results: zero compile/lint errors; **58 unit passes** including the runner self-test; **9 API passes, 1 pre-existing skip**. Actual Mocha output was inspected because the API launcher can return zero despite test failures.

This fixes successful callback-cache ownership, **not** failed provider/task-ID promises or pending RPC replies covered by [microsoft/vscode#338231](https://github.com/microsoft/vscode/pull/338231). The installed Insiders comparison remains unverified because of a pending update; the shared installation and its guard were left untouched.
