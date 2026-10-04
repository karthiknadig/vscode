/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const original = require('./bulk-move-scenario.cjs');
const names = Array.from({ length: 1024 }, (_, index) => `case${String(index).padStart(5, '0')}.ts`);
const output = path.join(__dirname, `supplementary-${Date.now()}.json`);
const results = { workspacePath: original.workspacePath, samples: [], compatibility: [] };
const save = () => fs.writeFileSync(output, JSON.stringify(results, null, 2));
const step = {
	id: 'tree-completion',
	title: 'Verify actual tree, paint, quiescent work, keyboard undo/redo and visible entries',
	async run({ page }) {
		const cdp = await page.context().newCDPSession(page);
		let serviceId;
		try {
			const urls = [];
			cdp.on('Debugger.scriptParsed', event => urls.push(event.url));
			await cdp.send('Debugger.enable');
			const moduleUrl = urls.find(url => /\/workbench\/contrib\/files\/browser\/explorerService\.js$/.test(url));
			assert.ok(moduleUrl);
			await cdp.send('Debugger.disable');
			const prototype = await cdp.send('Runtime.evaluate', { expression: `import(${JSON.stringify(moduleUrl)}).then(module => module.ExplorerService.prototype)`, awaitPromise: true });
			const objects = await cdp.send('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId });
			const instance = await cdp.send('Runtime.callFunctionOn', { objectId: objects.objects.objectId, functionDeclaration: 'function() { return this.find(service => service.view?.tree); }' });
			serviceId = instance.result.objectId;
			await cdp.send('Runtime.releaseObject', { objectId: prototype.result.objectId });
			await cdp.send('Runtime.releaseObject', { objectId: objects.objects.objectId });
			const invoke = async (functionDeclaration, ...values) => {
				const response = await cdp.send('Runtime.callFunctionOn', {
					objectId: serviceId, functionDeclaration,
					arguments: values.map(value => ({ value })), awaitPromise: true, returnByValue: true
				});
				if (response.exceptionDetails) {
					throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
				}
				return response.result.value;
			};
			const checkDisk = reverse => {
				assert.deepStrictEqual(fs.readdirSync(path.join(original.workspacePath, 'source')).sort(), reverse ? names : names.slice(32));
				assert.deepStrictEqual(fs.readdirSync(path.join(original.workspacePath, 'destination')).sort(), reverse ? [] : names.slice(0, 32));
			};
			const completion = `async function(reverse, perform, moduleUrl) {
				const tree = this.view.tree;
				const names = Array.from({ length: 1024 }, (_, i) => 'case' + String(i).padStart(5, '0') + '.ts');
				const sourceNames = reverse ? names : names.slice(32);
				const targetNames = reverse ? [] : names.slice(0, 32);
				const equal = (actual, expected) => actual.length === expected.length && actual.every((name, i) => name === expected[i]);
				const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
				const treeNames = parent => tree.getNode(parent).children.map(node => node.element.name).sort();
				let source = this.roots[0].getChild('source');
				let target = this.roots[0].getChild('destination');
				if (perform) {
					await tree.expand(source);
					await tree.expand(target);
					const sentinel = source.getChild('case00500.ts');
					tree.setSelection([sentinel]);
					tree.setFocus([sentinel]);
					tree.reveal(sentinel);
				}
				await frame();
				const start = performance.now();
				if (perform) {
					const { ResourceFileEdit } = await import(moduleUrl.replace('/workbench/contrib/files/browser/explorerService.js', '/editor/browser/services/bulkEditService.js'));
					const from = reverse ? target : source;
					const to = reverse ? source : target;
					const edits = names.slice(0, 32).map(name => new ResourceFileEdit(from.getChild(name).resource, to.resource.with({ path: to.resource.path + '/' + name })));
					await this.applyBulkEdit(edits, { undoLabel: 'W4 exact-state move', progressLabel: 'Move 32 files' });
				}
				const operationMs = performance.now() - start;
				let paintedExactMs;
				let quietSince;
				for (;;) {
					source = this.roots[0].getChild('source');
					target = this.roots[0].getChild('destination');
					const exact = source && target && tree.hasNode(source) && tree.hasNode(target) &&
						equal([...source.children.values()].map(item => item.name).sort(), sourceNames) &&
						equal([...target.children.values()].map(item => item.name).sort(), targetNames) &&
						equal(treeNames(source), sourceNames) && equal(treeNames(target), targetNames);
					const ready = exact && tree.refreshPromises.size === 0 && tree.subTreeRefreshPromises.size === 0;
					if (ready && paintedExactMs === undefined) {
						await frame();
						paintedExactMs = performance.now() - start;
					}
					const quiet = ready && !this.onFileChangesScheduler.isScheduled() && this.fileChangeEvents.length === 0;
					if (!quiet) { quietSince = undefined; }
					else if (quietSince === undefined) { quietSince = performance.now(); }
					else if (performance.now() - quietSince >= 600) { break; }
					if (performance.now() - start > 8000) { throw new Error('Exact painted tree and file events failed to settle'); }
					await new Promise(resolve => setTimeout(resolve, 20));
				}
				const quiescentMs = performance.now() - start;
				const expanded = !tree.isCollapsed(source) && !tree.isCollapsed(target);
				if (!expanded) { throw new Error('A parent collapsed during the operation'); }
				if (perform && (tree.getFocus()[0]?.name !== 'case00500.ts' || tree.getSelection()[0]?.name !== 'case00500.ts')) {
					throw new Error('Unmoved selection/focus was not preserved');
				}
				const visibleChecks = [];
				for (const parent of [source, target]) {
					const children = [...parent.children.values()].sort((a, b) => a.name.localeCompare(b.name));
					for (const item of [children[0], children.at(-1)].filter(Boolean)) {
						tree.reveal(item);
						await frame();
						if (![...document.querySelectorAll('.explorer-item .label-name')].some(node => node.textContent === item.name)) {
							throw new Error('Current tree entry is absent from rendered viewport: ' + item.name);
						}
						visibleChecks.push(item.name);
					}
				}
				return { operationMs, paintedExactMs, quiescentMs, expanded, visibleChecks,
					sourceTreeCount: treeNames(source).length, targetTreeCount: treeNames(target).length,
					focus: tree.getFocus().map(item => item.name), selection: tree.getSelection().map(item => item.name) };
			}`;
			for (let iteration = 0; iteration < 6; iteration++) {
				const reverse = iteration % 2 === 0;
				const result = await invoke(completion, reverse, true, moduleUrl);
				checkDisk(reverse);
				results.samples.push({ iteration, warmup: iteration === 0, ...result });
				save();
			}
			await cdp.send('Profiler.enable');
			await cdp.send('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
			results.instrumented = await invoke(completion, true, true, moduleUrl);
			const coverage = await cdp.send('Profiler.takePreciseCoverage');
			await cdp.send('Profiler.stopPreciseCoverage');
			const count = (file, name) => coverage.result.filter(script => script.url.endsWith(file)).flatMap(script => script.functions)
				.filter(fn => fn.functionName === name).reduce((sum, fn) => sum + fn.ranges[0].count, 0);
			results.instrumented.refreshCallsThroughQuiescence = count('/views/explorerView.js', 'refresh');
			results.instrumented.renderCallsThroughQuiescence = count('/ui/tree/asyncDataTree.js', 'render');
			const treeScript = coverage.result.find(script => script.url.endsWith('/ui/tree/asyncDataTree.js'));
			await cdp.send('Debugger.enable');
			const { scriptSource } = await cdp.send('Debugger.getScriptSource', { scriptId: treeScript.scriptId });
			await cdp.send('Debugger.disable');
			results.instrumented.renderMethods = treeScript.functions.filter(fn => fn.functionName === 'render').map(fn => ({
				className: [...scriptSource.slice(0, fn.ranges[0].startOffset).matchAll(/class (?<name>\w+)/g)].at(-1)?.groups.name,
				count: fn.ranges[0].count
			}));
			checkDisk(true);
			save();

			await invoke(`async function() {
				const source = this.roots[0].getChild('source');
				const target = this.roots[0].getChild('destination');
				await this.view.tree.expand(source);
				await this.view.tree.expand(target);
				const selected = [...source.children.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 32);
				this.view.tree.setSelection(selected);
				this.view.tree.setFocus([selected[0]]);
				this.view.tree.reveal(selected[0]);
				this.view.tree.scrollTop = 0;
				this.view.tree.domFocus();
			}`);
			const dragStart = Date.now();
			await page.locator('.explorer-item .label-name').filter({ hasText: /^case00000\.ts$/ })
				.dragTo(page.locator('.explorer-item .label-name').filter({ hasText: /^destination$/ }), { timeout: 8000 });
			const dragDispatchMs = Date.now() - dragStart;
			const drag = await invoke(completion, false, false, moduleUrl);
			checkDisk(false);
			results.compatibility.push({ action: 'real 32-file drag', dispatchMs: dragDispatchMs, paintedIncludingAutomationMs: dragDispatchMs + drag.paintedExactMs, totalThroughQuiescenceMs: Date.now() - dragStart, ...drag });
			save();
			for (const [action, key, reverse] of [['undo', 'Control+z', true], ['redo', 'Control+y', false]]) {
				await invoke('function() { this.view.tree.domFocus(); }');
				const start = Date.now();
				await page.keyboard.press(key);
				const dispatchMs = Date.now() - start;
				const state = await invoke(completion, reverse, false, moduleUrl);
				checkDisk(reverse);
				results.compatibility.push({ action, dispatchMs, paintedIncludingAutomationMs: dispatchMs + state.paintedExactMs, totalThroughQuiescenceMs: Date.now() - start, ...state });
				save();
			}
			await invoke(`function() {
				const target = this.roots[0].getChild('destination');
				this.view.tree.setSelection([...target.children.values()]);
				this.view.tree.setFocus([[...target.children.values()][0]]);
				this.view.tree.domFocus();
			}`);
			await page.keyboard.press('Control+x');
			await invoke(`async function() {
				if ((await this.clipboardService.readResources()).length !== 32) { throw new Error('Cut did not put 32 files on the clipboard'); }
				const source = this.roots[0].getChild('source');
				this.view.tree.setSelection([source]);
				this.view.tree.setFocus([source]);
				this.view.tree.domFocus();
			}`);
			const pasteStart = Date.now();
			await page.keyboard.press('Control+v');
			const pasteDispatchMs = Date.now() - pasteStart;
			const pasted = await invoke(completion, true, false, moduleUrl);
			checkDisk(true);
			results.compatibility.push({ action: 'keyboard cut/paste 32 files', paintedIncludingAutomationMs: pasteDispatchMs + pasted.paintedExactMs, totalThroughQuiescenceMs: Date.now() - pasteStart, ...pasted });
			results.exactModelTreeDiskAndVisibleEntries = true;
			results.paintedMedianMs = results.samples.filter(sample => !sample.warmup).map(sample => sample.paintedExactMs).sort((a, b) => a - b)[2];
			save();
			assert.ok(results.paintedMedianMs < 1000, `Exact painted expanded tree median ${results.paintedMedianMs.toFixed(1)} ms must be below 1000 ms`);
			return JSON.stringify(results);
		} finally {
			if (serviceId) { await cdp.send('Runtime.releaseObject', { objectId: serviceId }); }
			await cdp.detach();
		}
	}
};
module.exports = {
	...original,
	id: 'w4-explorer-exact-completion',
	userSettings: { ...original.userSettings, 'explorer.confirmUndo': 'never' },
	steps: [...original.steps.slice(0, -1), step, original.steps.at(-1)]
};
