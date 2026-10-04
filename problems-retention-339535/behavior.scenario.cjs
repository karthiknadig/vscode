/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const retention = require('./problems-retention.scenario.cjs');
const observations = [];

async function checkMode(context, mode, revision) {
	await context.page.evaluate(() => window.__diagnosticsPerf.view.filterWidget.setFilterText('Diagnostic 2'));
	await context.page.waitForFunction(() => window.__diagnosticsPerf.view.getFilterStats().filtered === 500);
	await context.page.evaluate(revision => window.__diagnosticsPerf.update(revision, true), revision);
	await context.page.waitForFunction(revision => {
		const state = window.__diagnosticsPerf;
		return state.view.markersModel.getResourceMarkers(state.resources[0]).markers[0].marker.message.endsWith(`revision ${revision}.`);
	}, revision);
	await context.workbench.quickaccess.runCommand('workbench.action.togglePanel');
	await context.page.waitForFunction(() => !window.__diagnosticsPerf.view.isVisible());
	const hidden = await context.page.evaluate(() => {
		const { view } = window.__diagnosticsPerf;
		return { resources: view.getAllResourceMarkers().length, markers: view.markersModel.total, viewStates: view.markersViewModel.markersViewStates.size };
	});
	assert.deepEqual(hidden, { resources: 0, markers: 0, viewStates: 0 });
	await context.page.evaluate(revision => window.__diagnosticsPerf.update(revision, false), revision + 1);
	await context.workbench.quickaccess.runCommand('workbench.action.togglePanel');
	await context.page.waitForFunction(revision => {
		const state = window.__diagnosticsPerf;
		return state.view.isVisible() && state.view.markersModel.getResourceMarkers(state.resources[0]).markers[0].marker.message.endsWith(`revision ${revision}.`);
	}, revision + 1);

	const state = await context.page.evaluate(({ mode, revision }) => {
		const { view } = window.__diagnosticsPerf;
		return {
			mode: view.markersViewModel.viewMode,
			filter: view.filterWidget.getFilterText(),
			stats: view.getFilterStats(),
			viewStates: view.markersViewModel.markersViewStates.size,
			currentTextVisible: document.querySelector('.markers-panel').textContent.includes(`Diagnostic 2, revision ${revision}.`)
		};
	}, { mode, revision: revision + 1 });
	assert.deepEqual(state, { mode, filter: 'Diagnostic 2', stats: { total: 2000, filtered: 500 }, viewStates: 2000, currentTextVisible: true });

	await context.page.evaluate(() => window.__diagnosticsPerf.view.focus());
	await context.page.keyboard.press('Home');
	const firstId = await context.page.evaluate(() => window.__diagnosticsPerf.view.getFocusElement()?.id);
	assert.ok(firstId, 'Home must focus a Problems item');
	await context.page.keyboard.press('ArrowDown');
	await context.page.waitForFunction(previous => {
		const id = window.__diagnosticsPerf.view.getFocusElement()?.id;
		return id && id !== previous;
	}, firstId);
	const navigation = await context.page.evaluate(() => ({
		focusInProblems: document.querySelector('.markers-panel').contains(document.activeElement),
		role: document.activeElement.getAttribute('role'),
		label: document.activeElement.getAttribute('aria-label')
	}));
	assert.equal(navigation.focusInProblems, true);
	assert.ok(navigation.label, 'The focused Problems widget must have an accessible label');
	observations.push({ ...state, hidden, navigation });
	return JSON.stringify(observations.at(-1));
}

module.exports = {
	...retention,
	id: 'problems-retention-behavior',
	title: 'Problems keeps current text, filters, and keyboard navigation after cleanup',
	source: 'https://github.com/microsoft/vscode/issues/339535',
	steps: [
		retention.steps[0],
		{
			id: 'tree-behavior',
			title: 'Tree mode preserves current diagnostics, filtering, and keyboard focus',
			run: context => checkMode(context, 'tree', 310)
		},
		{
			id: 'table-behavior',
			title: 'Table mode preserves current diagnostics, filtering, and keyboard focus',
			async run(context) {
				await context.page.getByRole('button', { name: 'View as Table', exact: true }).click();
				await context.page.waitForFunction(() => window.__diagnosticsPerf.view.markersViewModel.viewMode === 'table');
				return checkMode(context, 'table', 410);
			}
		},
		{
			id: 'clear',
			title: 'Explicit clear releases all remaining state',
			async run(context) {
				await context.page.evaluate(() => {
					window.__diagnosticsPerf.service.changeAll('diagnostics-perf', []);
					window.__diagnosticsPerfRegistration.dispose();
				});
				await context.page.waitForFunction(() => window.__diagnosticsPerf.view.markersModel.total === 0);
				assert.equal(await context.page.evaluate(() => window.__diagnosticsPerf.view.markersViewModel.markersViewStates.size), 0);
				fs.writeFileSync(path.join(__dirname, 'behavior-results.json'), JSON.stringify(observations, null, 2));
				return 'Tree and table behavior passed; explicit clear retains zero marker view models.';
			}
		}
	]
};
