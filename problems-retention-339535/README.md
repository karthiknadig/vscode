# Problems retention: #339535

Evidence for [microsoft/vscode#339535](https://github.com/microsoft/vscode/issues/339535).

| Measurement | Before | After |
|---|---:|---:|
| Current diagnostics | 2,000 | 2,000 |
| View models after seven cycles | 15,976 | 2,000 |
| Obsolete view models | 13,976 | 0 |
| Per-window median heap growth, MiB/cycle | 19.66-19.77 | 0.14-0.18 |
| Visible-update control, MiB/cycle | 0.043-0.044 | 0.041-0.047 |
| States after explicit clear | 0 | 0 |

Before: `6fad7188e7dbf7db564e5e4a85960eb2bf69bdf4`. After: `278012e774a91c3429e087dff94fb01b844be907`.
Three fresh Windows Code OSS Dev windows per side used the same scenario and `npm run transpile-client` build path. Each mode has seven cycles; the first is warmup. Each quoted per-window median uses six consecutive post-GC heap differences. The initial hide/show allocation is excluded from those warmed medians, not from the published raw data.

## What triggers it

1. Publish four diagnostics per resource on 500 logical URIs.
2. Update one existing resource while Problems is visible, invalidating its sorted-resource cache.
3. Hide Problems with the normal panel toggle.
4. Replace the diagnostics while hidden, changing messages but keeping resources, ranges, and counts.
5. Show Problems again; repeat seven times.

Plain hide/show is not claimed to leak. This is a synthetic provider using the real workbench marker service and Problems view, not language-server or typing-latency evidence. The measured fixture had 77-character messages and 1,478,001 serialized bytes.

## Portable reproduction

Download [problems-retention.scenario.cjs](./problems-retention.scenario.cjs). It only requires Node built-ins, creates an empty workspace beside itself, and resolves imports from the running dev workbench. No private paths or existing source files are required.

From a prepared VS Code source checkout with current compiled output:

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Remove-Item Env:DIAGNOSTICS_SNAPSHOT -ErrorAction SilentlyContinue
$scenario = (Resolve-Path 'C:\path\to\problems-retention.scenario.cjs').Path
node .\test\scenario\out\runScenario.js --dev $scenario
```

Use `npm run transpile-client` for current source output. If the scenario runner is not built, use `npm --prefix test\scenario run compile`. Set `FFMPEG_PATH` and `FFPROBE_PATH` to installed binaries to retain annotated recordings. These are preparation/reproduction instructions; the exact executed validation results are in the pull request.

When the Bug Swarm helper is available, it also supplies shared-data isolation and repeats in fresh windows:

```powershell
node "$env:USERPROFILE\.copilot\skills\bug-swarm\scripts\run-scenario.mjs" --scenario $scenario --checkout (Get-Location).Path --isolation problems-339535 --repeat 3
```

The baseline fails `expected-release` with 15,976 view models and 13,976 obsolete ones. The fix passes with 2,000 current view models and zero obsolete ones. Each invocation saves a `retention-<timestamp>.json` with raw heap, backing-storage, count, visible-update-control, and explicit-clear samples. Changing the download directory changes serialized URI lengths; the diagnostic count, messages, ranges, and assertions stay the same.

The scenario is preserved byte-for-byte, including its historical `source` metadata; this evidence resolves #339535, not that earlier investigated report. Its SHA-256 is `0c4d6b74100faa4fd538b61d32733cbd558d655008e6c4fe2295d29c9d9d6f2f`.

For supplementary UI checks, keep [behavior.scenario.cjs](./behavior.scenario.cjs) beside the retention scenario and run it with the same runner. It verifies tree/table mode, current text, the 500-of-2,000 filter, Home/ArrowDown navigation, accessible focus labels, and final clear.

## Read the evidence

- [Comparison card](./comparison.png): exact state counts and ranges across all three windows.
- [Before GIF](./before.gif) / [After GIF](./after.gif): 4.51-second **recorded-data replays**, not elapsed-action playback. They show run 1, use identical scales, and subtract the first warmup cycle from every plotted heap sample. Zero-valued bars use a small baseline marker.
- [Metrics](./metrics.json), [provenance](./proof-provenance.json), and raw [before](./before/) / [after](./after/) JSON samples.
- [UI behavior results](./behavior-results.json).
- [Proof renderer](./render-proof.mjs): regenerates the card and GIFs from the published data using FFmpeg and Windows Segoe UI fonts.

The remaining small renderer heap trend is not claimed to be zero; the obsolete marker-view-model retention is eliminated. Backing-storage deltas remain small. The shared installed Insiders was not launched because it has a pending update. Keyboard and ARIA checks passed; no physical screen-reader test was performed.
