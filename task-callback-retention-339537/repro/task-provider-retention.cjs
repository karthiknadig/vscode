/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const root = __dirname;
const runId = randomUUID().slice(0, 8);
let metrics;

async function waitForReport(name, timeoutMs = 90000) {
	const report = path.join(root, `run-${runId}-${name}.json`);
	const errorFile = path.join(root, `run-${runId}-error.json`);
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (fs.existsSync(errorFile)) {
			throw new Error(fs.readFileSync(errorFile, 'utf8'));
		}
		if (fs.existsSync(report)) {
			return JSON.parse(fs.readFileSync(report, 'utf8'));
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	throw new Error(`Fixture timed out waiting for ${report}`);
}

module.exports = {
	id: 'w2-terminal-task-provider-retention',
	title: 'Unregistered task providers release custom-execution backing storage',
	workspacePath: path.join(root, 'workspace'),
	extraArgs: [`--extensionDevelopmentPath=${path.join(root, 'extension')}`, '--disable-workspace-trust'],
	userSettings: {
		'terminalTaskPerf.runId': runId,
		'terminalTaskPerf.captureHeap': process.env.TERMINAL_HUNT_CAPTURE_HEAP === '1',
		'task.autoDetect': 'on',
		'git.enabled': false,
		'extensions.autoUpdate': false,
		'chat.disableAIFeatures': true,
		'workbench.startupEditor': 'none'
	},
	stepPauseMs: 3000,
	steps: [
		{
			id: 'BASELINE',
			title: 'Discover a custom task, unregister its provider, verify no active tasks or terminals',
			async run(context) {
				await context.workbench.quickaccess.runCommand('terminalTaskPerf.baseline');
				const baseline = await waitForReport('baseline');
				assert.equal(baseline.ok, true);
				return `Real extension API baseline passed; extension-host PID ${baseline.pid}; zero tasks and terminals.`;
			}
		},
		{
			id: 'MEASURE',
			title: 'One warmup and five 2 MiB provider lifecycles per arm, with GC',
			async run(context) {
				await context.workbench.quickaccess.runCommand('terminalTaskPerf.measure');
				metrics = await waitForReport('metrics');
				assert.deepStrictEqual(metrics.control.concat(metrics.reusedId, metrics.fetched).map(sample => [sample.activeTasks, sample.terminals]), Array.from({ length: 15 }, () => [0, 0]));
				const summary = {
					controlMiB: metrics.controlDelta.external / (1024 * 1024),
					reusedIdMiB: metrics.reusedIdDelta.external / (1024 * 1024),
					fetchedMiB: metrics.fetchedDelta.external / (1024 * 1024),
					controlLive: metrics.controlDelta.livePayloads,
					fetchedLive: metrics.fetchedDelta.livePayloads
				};
				await context.page.evaluate(summary => {
					const card = document.createElement('section');
					card.id = 'terminal-lifetime-measurement';
					card.style.cssText = 'position:absolute;inset:90px 70px auto;padding:28px;z-index:10000;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);border:2px solid var(--vscode-focusBorder);font:20px monospace;white-space:pre-wrap';
					card.textContent = [
						'TASK PROVIDER LIFETIME - REAL EXTENSION API',
						'5 cycles x 2 MiB callback payload; GC after every disposal',
						'All providers unregistered; no active tasks or terminals',
						'',
						`No-discovery control: ${summary.controlMiB.toFixed(2)} MiB retained, ${summary.controlLive} live payloads`,
						`Same-ID discovery control: ${summary.reusedIdMiB.toFixed(2)} MiB growth`,
						`Discover then dispose: ${summary.fetchedMiB.toFixed(2)} MiB retained, ${summary.fetchedLive} live payloads`,
						'',
						'Backing storage, not renderer heap or native task processes',
						'Local synthetic provider; no user-frequency claim'
					].join('\n');
					document.querySelector('.monaco-workbench').append(card);
				}, summary);
				return JSON.stringify(summary);
			}
		},
		{
			id: 'RELEASE',
			title: 'Disposed providers must release callback payloads',
			async run() {
				assert.ok(Math.abs(metrics.controlDelta.external) < 1024 * 1024, 'No-discovery control must not retain significant backing storage');
				assert.ok(Math.abs(metrics.reusedIdDelta.external) < 1024 * 1024, 'Same-ID discovery control must not grow significantly');
				assert.ok(metrics.fetchedDelta.external < 1024 * 1024, `Unregistered providers retained ${metrics.fetchedDelta.external} external bytes (${metrics.fetchedDelta.livePayloadBytes} live payload bytes) after GC; expected under 1 MiB total.`);
				return 'No sustained backing-storage retention after provider disposal.';
			}
		}
	]
};
