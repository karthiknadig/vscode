/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const workspacePath = path.join(__dirname, 'base64-workspace');
fs.mkdirSync(workspacePath, { recursive: true });
const resultsPath = path.join(__dirname, process.env.BASE64_RESULTS_FILE ?? 'base64-results.json');
const results = [];
let environment;

function save() {
	fs.writeFileSync(resultsPath, JSON.stringify({
		issue: 334892,
		checkoutHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
		workingTreeChanges: execFileSync('git', ['diff', '--stat'], { encoding: 'utf8' }).trim(),
		scope: 'Actual renderer encoder, synthetic buffers capped at 4 MiB; not a full plugin-sync or crash reproduction.',
		warmupRunsPerCase: 1,
		measuredRunsPerCase: 5,
		environment,
		results,
	}, null, 2));
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

module.exports = {
	id: 'hunt-334892-base64',
	title: 'Bounded reproduction of renderer Base64 memory amplification',
	source: 'https://github.com/microsoft/vscode/issues/334892',
	workspacePath,
	stepPauseMs: 250,
	userSettings: {
		'workbench.startupEditor': 'none',
		'chat.disableAIFeatures': true,
		'telemetry.telemetryLevel': 'off',
	},
	extraArgs: ['--disable-extensions', '--disable-workspace-trust'],
	steps: [
		{
			id: 'setup',
			title: 'Load the actual encoder used by Agent Host resourceRead',
			async run(context) {
				environment = await context.page.evaluate(async () => {
					const root = location.href.slice(0, location.href.indexOf('/out/') + 5);
					if (!root.endsWith('/out/')) {
						throw new Error(`Not a source workbench: ${location.href}`);
					}
					const { encodeBase64, VSBuffer } = await import(root + 'vs/base/common/buffer.js');
					if (typeof Uint8Array.prototype.toBase64 !== 'function') {
						throw new Error('The native Base64 control is unavailable in this renderer.');
					}
					window.base64Hunt = { encodeBase64, VSBuffer, input: undefined, encoded: undefined };
					return { userAgent: navigator.userAgent, nativeToBase64: true, root };
				});
				save();
				return 'Imported the production encoder without patching it. Native Uint8Array.toBase64 is available as a control.';
			},
		},
		{
			id: 'measure',
			title: 'Measure encoding latency and retained heap with inputs no larger than 4 MiB',
			async run(context) {
				const cdp = await context.page.context().newCDPSession(context.page);
				try {
					await cdp.send('HeapProfiler.enable');
					for (const inputBytes of [256 * 1024, 1024 * 1024, 4 * 1024 * 1024]) {
						await context.page.evaluate(size => {
							const state = window.base64Hunt;
							state.input = state.VSBuffer.alloc(size);
							for (let index = 0; index < size; index++) {
								state.input.buffer[index] = (index * 31 + 17) & 255;
							}
						}, inputBytes);
						for (const algorithm of ['production', 'native']) {
							const samples = [];
							for (let run = -1; run < 5; run++) {
								await cdp.send('HeapProfiler.collectGarbage');
								const baseline = await cdp.send('Runtime.getHeapUsage');
								const encoded = await context.page.evaluate(async method => {
									const state = window.base64Hunt;
									const start = performance.now();
									const timer = new Promise(resolve => setTimeout(() => resolve(performance.now() - start), 0));
									state.encoded = method === 'production'
										? state.encodeBase64(state.input)
										: state.input.buffer.toBase64();
									const encodeMs = performance.now() - start;
									const outputCharacters = state.encoded.length;
									return { encodeMs, outputCharacters, timerDelayMs: await timer };
								}, algorithm);
								const beforeGc = await cdp.send('Runtime.getHeapUsage');
								await cdp.send('HeapProfiler.collectGarbage');
								const retained = await cdp.send('Runtime.getHeapUsage');
								const matchesNative = await context.page.evaluate(() => {
									const state = window.base64Hunt;
									return state.encoded === state.input.buffer.toBase64();
								});
								assert.equal(matchesNative, true, 'The encoded result must match the native control byte-for-byte.');
								assert.equal(encoded.outputCharacters, 4 * Math.ceil(inputBytes / 3));
								await context.page.evaluate(() => { window.base64Hunt.encoded = undefined; });
								await cdp.send('HeapProfiler.collectGarbage');
								const released = await cdp.send('Runtime.getHeapUsage');
								if (run >= 0) {
									samples.push({
										...encoded,
										heapGrowthBeforeGc: beforeGc.usedSize - baseline.usedSize,
										retainedHeapBytes: retained.usedSize - baseline.usedSize,
										retainedBackingStorageBytes: retained.backingStorageSize - baseline.backingStorageSize,
										retainedMemoryBytes: retained.usedSize - baseline.usedSize + retained.backingStorageSize - baseline.backingStorageSize,
										heapGrowthAfterRelease: released.usedSize - baseline.usedSize,
										matchesNative,
									});
								}
							}
							results.push({
								inputBytes,
								algorithm,
								medianEncodeMs: median(samples.map(sample => sample.encodeMs)),
								worstEncodeMs: Math.max(...samples.map(sample => sample.encodeMs)),
								medianTimerDelayMs: median(samples.map(sample => sample.timerDelayMs)),
								medianRetainedHeapBytes: median(samples.map(sample => sample.retainedHeapBytes)),
								medianRetainedMemoryBytes: median(samples.map(sample => sample.retainedMemoryBytes)),
								outputCharacters: samples[0].outputCharacters,
								samples,
							});
							save();
						}
					}
				} finally {
					await context.page.evaluate(() => { delete window.base64Hunt; });
					await cdp.send('HeapProfiler.collectGarbage');
					await cdp.detach();
				}

				await context.page.evaluate(measurements => {
					const board = document.createElement('pre');
					board.style.cssText = 'position:fixed;left:100px;right:100px;top:100px;z-index:100000;padding:24px;white-space:pre-wrap;font:20px/1.8 monospace;color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);border:2px solid var(--vscode-focusBorder)';
					board.textContent = [
						'TEST INSTRUMENTATION - ACTUAL RENDERER BASE64 ENCODER',
						'Five warmed samples per case. Maximum input: 4 MiB.',
						'No plugins, real files, or multi-GB allocations.',
						'',
						...measurements.map(result => `${result.algorithm.padEnd(10)} ${(result.inputBytes / 1048576).toFixed(2)} MiB input: ${result.medianEncodeMs.toFixed(1)} ms median, ${(result.medianRetainedMemoryBytes / 1048576).toFixed(1)} MiB retained (heap + backing storage)`),
						'',
						'Every result matched the native encoder byte-for-byte.',
					].join('\n');
					document.querySelector('.monaco-workbench').appendChild(board);
				}, results);
				return results.map(result => `${result.algorithm} ${result.inputBytes / 1048576} MiB: ${result.medianEncodeMs.toFixed(1)} ms, ${(result.medianRetainedMemoryBytes / 1048576).toFixed(1)} MiB retained heap + backing storage`).join('; ');
			},
		},
		{
			id: 'bounded-memory',
			title: 'Assert the encoded result does not retain an excessive intermediate string graph',
			run() {
				const largest = results.find(result => result.algorithm === 'production' && result.inputBytes === 4 * 1024 * 1024);
				assert.ok(largest);
				const generousBudget = Math.max(16 * 1024 * 1024, largest.outputCharacters * 8);
				assert.ok(largest.medianRetainedMemoryBytes <= generousBudget,
					`Encoding a 4 MiB input retained ${(largest.medianRetainedMemoryBytes / 1048576).toFixed(1)} MiB of heap and backing storage for ${(largest.outputCharacters / 1048576).toFixed(2)} MiB of output; median renderer blocking ${largest.medianEncodeMs.toFixed(1)} ms.`);
				return 'Encoded output remains within the declared 8x-output retained-memory budget, including backing storage.';
			},
		},
	],
};
