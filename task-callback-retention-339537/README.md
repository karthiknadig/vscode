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
- Fix `4ff52438d46919c520e7effa4647ae78ecfbdf26`: **passed 3/3**, zero additional external bytes and zero live callback payloads.

Client compilation, API-test compilation, 44 lifecycle tests plus the test-runner self-test, and eight real task API tests passed. One pre-existing API test remains skipped. The public API tests separately verify actual terminal output and task completion, including an extension-held task executed after provider disposal and disposal during a running task.

This fixes successful callback-cache ownership, **not** failed provider/task-ID promises or pending RPC replies covered by [microsoft/vscode#338231](https://github.com/microsoft/vscode/pull/338231). The installed Insiders comparison remains unverified because of a pending update; the shared installation and its guard were left untouched.
