/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'w3-explorer-move-'));
const sourcePath = path.join(workspacePath, 'source');
const targetPath = path.join(workspacePath, 'destination');
const names = Array.from({ length: 1024 }, (_, index) => `case${String(index).padStart(5, '0')}.ts`);
fs.mkdirSync(sourcePath);
fs.mkdirSync(targetPath);
for (const name of names) {
	fs.writeFileSync(path.join(sourcePath, name), 'export const value = 1;\n');
}
const runId = Date.now().toString();
const metrics = { runId, workspacePath, fixtureFiles: 1024, fixtureBytes: 23552, movedPerSample: 32, samples: [] };
const output = path.join(__dirname, `bulk-metrics-${runId}.json`);
const save = () => fs.writeFileSync(output, JSON.stringify(metrics, null, 2));
save();
let cdp;
let serviceId;
let moduleUrl;
async function invoke(functionDeclaration, ...values) {
	const response = await cdp.send('Runtime.callFunctionOn', {
		objectId: serviceId, functionDeclaration, arguments: values.map(value => ({ value })),
		awaitPromise: true, returnByValue: true
	});
	if (response.exceptionDetails) {
		throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
	}
	return response.result.value;
}
async function validateDisk(reverse) {
	assert.deepStrictEqual(fs.readdirSync(sourcePath).sort(), reverse ? names : names.slice(32));
	assert.deepStrictEqual(fs.readdirSync(targetPath).sort(), reverse ? [] : names.slice(0, 32));
}
async function move(arm, reverse) {
	const result = await invoke(`async function(arm, reverse, moduleUrl) {
		const { ResourceFileEdit } = await import(moduleUrl.replace('/workbench/contrib/files/browser/explorerService.js', '/editor/browser/services/bulkEditService.js'));
		const tree = this.view.tree;
		const prepareDeadline = performance.now() + 8000;
		let quietSince = performance.now();
		let previousSource;
		let previousTarget;
		for (;;) {
			const source = this.roots[0].getChild('source');
			const target = this.roots[0].getChild('destination');
			const ready = source && target && tree.hasNode(source) && tree.hasNode(target) &&
				!this.onFileChangesScheduler.isScheduled() && this.fileChangeEvents.length === 0 &&
				tree.refreshPromises.size === 0 && tree.subTreeRefreshPromises.size === 0;
			if (!ready || source !== previousSource || target !== previousTarget) { quietSince = performance.now(); }
			previousSource = source;
			previousTarget = target;
			if (ready && performance.now() - quietSince >= 600) { break; }
			if (performance.now() >= prepareDeadline) { throw new Error('Prior file events did not reach a stable model before measurement'); }
			await new Promise(resolve => setTimeout(resolve, 25));
		}
		const original = this.roots[0].getChild('source');
		const target = this.roots[0].getChild('destination');
		await tree.expand(original);
		await tree.expand(target);
		if (arm === 'collapsed') { tree.collapse(original); tree.collapse(target); }
		await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		const source = reverse ? target : original;
		const destination = reverse ? original : target;
		const entries = Array.from({ length: 32 }, (_, index) => source.getChild('case' + String(index).padStart(5, '0') + '.ts'));
		if (entries.some(entry => !entry)) { throw new Error('Missing fixture input'); }
		const edits = entries.map(entry => new ResourceFileEdit(entry.resource, destination.resource.with({ path: destination.resource.path + '/' + entry.name })));
		const longTasks = [];
		const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(entry => ({ duration: entry.duration, startTime: entry.startTime }))));
		observer.observe({ type: 'longtask' });
		const start = performance.now();
		await this.applyBulkEdit(edits, { undoLabel: 'W3 Finite Move', progressLabel: 'Moving 32 fixture files' });
		const operationMs = performance.now() - start;
		const deadline = start + 8000;
		while (tree.refreshPromises.size || tree.subTreeRefreshPromises.size) {
			if (performance.now() >= deadline) { throw new Error('Tree did not settle within eight seconds'); }
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		const paintedMs = performance.now() - start;
		await new Promise(resolve => setTimeout(resolve, 0));
		observer.disconnect();
		let currentSource;
		let currentTarget;
		for (;;) {
			currentSource = this.roots[0].getChild('source');
			currentTarget = this.roots[0].getChild('destination');
			if (currentSource && currentTarget && arm === 'collapsed') {
				await tree.expand(currentSource);
				await tree.expand(currentTarget);
			}
			if (currentSource?.isDirectoryResolved && currentTarget?.isDirectoryResolved &&
				currentSource.children.size === (reverse ? 1024 : 992) && currentTarget.children.size === (reverse ? 0 : 32)) { break; }
			if (performance.now() >= deadline) { throw new Error('Current Explorer model did not reach expected counts'); }
			await new Promise(resolve => setTimeout(resolve, 25));
		}
		return {
			operationMs, paintedMs, exactStateMs: performance.now() - start, longTasks,
			sourceNames: [...currentSource.children.values()].map(item => item.name).sort(),
			targetNames: [...currentTarget.children.values()].map(item => item.name).sort()
		};
	}`, arm, reverse, moduleUrl);
	assert.deepStrictEqual(result.sourceNames, reverse ? names : names.slice(32));
	assert.deepStrictEqual(result.targetNames, reverse ? [] : names.slice(0, 32));
	await validateDisk(reverse);
	delete result.sourceNames;
	delete result.targetNames;
	return { ...result, exactModelAndDiskVerified: true };
}
module.exports = {
	id: 'w3-explorer-bulk-move',
	title: 'Moving 32 local files should not queue seconds of Explorer refresh work',
	workspacePath,
	stepPauseMs: 0,
	extraArgs: ['--disable-extensions', '--disable-workspace-trust'],
	userSettings: {
		'workbench.startupEditor': 'none',
		'workbench.tips.enabled': false,
		'workbench.secondarySideBar.defaultVisibility': 'hidden',
		'chat.disableAIFeatures': true,
		'security.workspace.trust.enabled': false,
		'explorer.compactFolders': false,
		'explorer.fileNesting.enabled': false,
		'explorer.autoReveal': false,
		'explorer.confirmDragAndDrop': false,
		'git.enabled': false,
		'window.title': 'W3-EXPLORER - 32-file move measurements'
	},
	steps: [
		{
			id: 'baseline',
			title: 'Baseline: drag 32 real local files and verify every resulting entry',
			async run({ page, workbench }) {
				await workbench.explorer.openExplorerView();
				await page.locator('.explorer-item .label-name').filter({ hasText: /^source$/ }).waitFor({ timeout: 20000 });
				cdp = await page.context().newCDPSession(page);
				const urls = [];
				cdp.on('Debugger.scriptParsed', event => urls.push(event.url));
				await cdp.send('Debugger.enable');
				moduleUrl = urls.find(url => /\/workbench\/contrib\/files\/browser\/explorerService\.js$/.test(url));
				assert.ok(moduleUrl, 'Production ExplorerService must be loaded');
				await cdp.send('Debugger.disable');
				const prototype = await cdp.send('Runtime.evaluate', { expression: `import(${JSON.stringify(moduleUrl)}).then(module => module.ExplorerService.prototype)`, awaitPromise: true });
				const objects = await cdp.send('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId });
				const singleton = await cdp.send('Runtime.callFunctionOn', { objectId: objects.objects.objectId, functionDeclaration: 'function() { if (this.length !== 1) { throw new Error("Expected one ExplorerService"); } return this[0]; }' });
				assert.ok(singleton.result.objectId, 'One ExplorerService instance required');
				serviceId = singleton.result.objectId;
				await cdp.send('Runtime.releaseObject', { objectId: prototype.result.objectId });
				await cdp.send('Runtime.releaseObject', { objectId: objects.objects.objectId });
				await page.locator('.explorer-item .label-name').filter({ hasText: /^source$/ }).click();
				await page.locator('.explorer-item .label-name').filter({ hasText: /^case00000\.ts$/ }).waitFor({ timeout: 20000 });
				await invoke(`function() {
					const source = this.roots[0].getChild('source');
					const selected = [...source.children.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 32);
					this.view.tree.setSelection(selected);
					this.view.tree.setFocus([selected[0]]);
					this.view.tree.reveal(selected[0]);
				}`);
				const destination = page.locator('.explorer-item .label-name').filter({ hasText: /^destination$/ });
				const before = Date.now();
				await page.locator('.explorer-item .label-name').filter({ hasText: /^case00000\.ts$/ }).dragTo(destination, { timeout: 8000 });
				const deadline = Date.now() + 8000;
				while (fs.readdirSync(targetPath).length !== 32) {
					if (Date.now() >= deadline) { throw new Error('Real Explorer drag did not move exactly 32 files'); }
					await new Promise(resolve => setTimeout(resolve, 25));
				}
				await validateDisk(false);
				metrics.uiDragMs = Date.now() - before;
				metrics.reset = await move('expanded', true);
				save();
				return `Real Explorer drag moved all 32 files (${metrics.uiDragMs} ms including automation); model and disk restored exactly.`;
			}
		},
		{
			id: 'measure',
			title: 'Measure warmup plus five 32-file moves in each visibility arm',
			async run() {
				for (const arm of ['expanded', 'collapsed']) {
					for (let iteration = 0; iteration < 6; iteration++) {
						const result = await move(arm, iteration % 2 === 1);
						metrics.samples.push({ arm, iteration, warmup: iteration === 0, ...result });
						save();
					}
				}
				return JSON.stringify(metrics.samples.map(sample => ({ arm: sample.arm, iteration: sample.iteration, operationMs: sample.operationMs, paintedMs: sample.paintedMs })));
			}
		},
		{
			id: 'profile',
			title: 'Capture production CPU stacks and refresh call counts separately',
			async run() {
				await cdp.send('Profiler.enable');
				await cdp.send('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
				await cdp.send('Profiler.start');
				metrics.profiledMove = await move('expanded', false);
				const profile = await cdp.send('Profiler.stop');
				const coverage = await cdp.send('Profiler.takePreciseCoverage');
				await cdp.send('Profiler.stopPreciseCoverage');
				fs.writeFileSync(path.join(__dirname, `bulk-${runId}.cpuprofile`), JSON.stringify(profile.profile));
				fs.writeFileSync(path.join(__dirname, `bulk-${runId}-coverage.json`), JSON.stringify(coverage, null, 2));
				save();
				return 'Saved original CPU profile and precise coverage; this instrumented move is excluded from primary samples.';
			}
		},
		{
			id: 'expected',
			title: 'Expected: an ordinary 32-file move completes within one second',
			async run() {
				const median = arm => metrics.samples.filter(sample => sample.arm === arm && !sample.warmup).map(sample => sample.operationMs).sort((a, b) => a - b)[2];
				metrics.expandedMedianMs = median('expanded');
				metrics.collapsedMedianMs = median('collapsed');
				metrics.ratio = metrics.expandedMedianMs / metrics.collapsedMedianMs;
				metrics.finishedAt = new Date().toISOString();
				save();
				await cdp.send('Runtime.releaseObject', { objectId: serviceId });
				await cdp.detach();
				assert.ok(metrics.collapsedMedianMs < 1000, `Control must establish local filesystem responsiveness: ${metrics.collapsedMedianMs} ms`);
				assert.ok(metrics.expandedMedianMs < 1000, `32-file move median ${metrics.expandedMedianMs.toFixed(1)} ms with folders expanded, versus ${metrics.collapsedMedianMs.toFixed(1)} ms collapsed (${metrics.ratio.toFixed(1)}x). Exact names and disk verified.`);
				return `32-file move median ${metrics.expandedMedianMs} ms`;
			}
		}
	]
};
