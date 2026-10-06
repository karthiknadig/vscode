/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'explorer-multiple-sources-'));
for (const folder of ['a', 'b', 'c', 'a/first-folder', 'b/second-folder']) {
	fs.mkdirSync(path.join(workspacePath, ...folder.split('/')), { recursive: true });
}
for (const file of ['a/keep-a.txt', 'b/keep-b.txt', 'c/keep-c.txt', 'a/x.txt', 'b/y.txt', 'a/first-folder/first-child.txt', 'b/second-folder/second-child.txt']) {
	fs.writeFileSync(path.join(workspacePath, ...file.split('/')), `${file}\n`);
}
let cdp;
let serviceId;
const results = [];
const resultPath = path.join(__dirname, `multi-source-${Date.now()}.json`);
const save = () => fs.writeFileSync(resultPath, JSON.stringify({ workspacePath, results }, null, 2));
save();

async function invoke(functionDeclaration, ...values) {
	const response = await cdp.send('Runtime.callFunctionOn', {
		objectId: serviceId, functionDeclaration,
		arguments: values.map(value => ({ value })),
		awaitPromise: true, returnByValue: true
	});
	if (response.exceptionDetails) {
		throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
	}
	return response.result.value;
}

async function moveAndReveal(context, names, files) {
	const label = name => context.page.locator('.explorer-item .label-name').filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });
	await label(names[0]).click();
	await label(names[1]).click({ modifiers: ['Control'] });
	assert.deepEqual(await invoke('function() { return this.view.tree.getSelection().map(item => item.name).sort(); }'), [...names].sort());
	await label(names[0]).dragTo(label('c'), { timeout: 10000 });
	await context.page.waitForFunction(names => {
		const service = globalThis.__multiSourceExplorer;
		const destination = service.roots[0].getChild('c');
		return names.every(name => destination.getChild(name)) && service.moveBatches.size === 0 &&
			service.view.tree.refreshPromises.size === 0 && service.view.tree.subTreeRefreshPromises.size === 0 &&
			!service.onFileChangesScheduler.isScheduled() && service.fileChangeEvents.length === 0;
	}, names, { timeout: 10000 });
	const mapping = await invoke(`function(names) {
		const destination = this.roots[0].getChild('c');
		return names.map(name => {
			const item = destination.getChild(name);
			return { name, present: !!item, indexed: !!item && this.view.tree.hasNode(item) };
		});
	}`, names);
	results.push({ names, mapping });
	save();
	assert.deepEqual(mapping, names.map(name => ({ name, present: true, indexed: true })));
	for (const file of files) {
		const absolute = path.join(workspacePath, 'c', ...file.split('/'));
		assert.equal(fs.existsSync(absolute), true);
		await context.workbench.quickaccess.openFile(absolute);
		await context.workbench.quickaccess.runCommand('workbench.files.action.showActiveFileInExplorer');
		const selected = await invoke(`function(parts) {
			let item = this.roots[0].getChild('c');
			for (const part of parts) { item = item.getChild(part); }
			const tree = this.view.tree;
			return { indexed: tree.hasNode(item), selected: tree.getSelection()[0] === item, focused: tree.getFocus()[0] === item };
		}`, file.split('/'));
		assert.deepEqual(selected, { indexed: true, selected: true, focused: true });
		results.push({ file, selected });
		save();
	}
	return JSON.stringify(results);
}

module.exports = {
	id: 'explorer-multi-source-review',
	title: 'Multi-source moves preserve tree identity and reveal for every moved item',
	source: 'https://github.com/microsoft/vscode/pull/339614#discussion_r4189389818',
	workspacePath,
	stepPauseMs: 0,
	extraArgs: ['--disable-extensions', '--disable-workspace-trust'],
	userSettings: {
		'workbench.startupEditor': 'none',
		'workbench.secondarySideBar.defaultVisibility': 'hidden',
		'chat.disableAIFeatures': true,
		'explorer.compactFolders': false,
		'explorer.fileNesting.enabled': false,
		'explorer.autoReveal': false,
		'explorer.confirmDragAndDrop': false,
		'git.enabled': false
	},
	steps: [
		{
			id: 'baseline',
			title: 'Resolve three expanded folders in the actual Explorer tree',
			async run({ page, workbench }) {
				await workbench.explorer.openExplorerView();
				await page.locator('.explorer-item .label-name').filter({ hasText: /^a$/ }).waitFor();
				cdp = await page.context().newCDPSession(page);
				const urls = [];
				cdp.on('Debugger.scriptParsed', event => urls.push(event.url));
				await cdp.send('Debugger.enable');
				const moduleUrl = urls.find(url => /\/workbench\/contrib\/files\/browser\/explorerService\.js$/.test(url));
				assert.ok(moduleUrl);
				await cdp.send('Debugger.disable');
				const prototype = await cdp.send('Runtime.evaluate', { expression: `import(${JSON.stringify(moduleUrl)}).then(module => module.ExplorerService.prototype)`, awaitPromise: true });
				const objects = await cdp.send('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId });
				const singleton = await cdp.send('Runtime.callFunctionOn', {
					objectId: objects.objects.objectId,
					functionDeclaration: 'function() { if (this.length !== 1) { throw new Error("Expected one ExplorerService"); } globalThis.__multiSourceExplorer = this[0]; return this[0]; }'
				});
				assert.ok(singleton.result.objectId);
				serviceId = singleton.result.objectId;
				await cdp.send('Runtime.releaseObject', { objectId: prototype.result.objectId });
				await cdp.send('Runtime.releaseObject', { objectId: objects.objects.objectId });
				const folders = await invoke(`async function() {
					const names = ['a', 'b', 'c'];
					for (const name of names) { await this.view.tree.expand(this.roots[0].getChild(name)); }
					return names.map(name => {
						const item = this.roots[0].getChild(name);
						return { name, resolved: item.isDirectoryResolved, indexed: this.view.tree.hasNode(item), expanded: !this.view.tree.isCollapsed(item) };
					});
				}`);
				assert.deepEqual(folders, ['a', 'b', 'c'].map(name => ({ name, resolved: true, indexed: true, expanded: true })));
				return JSON.stringify(folders);
			}
		},
		{
			id: 'files',
			title: 'Drag files from two source folders, then reveal each without refreshing',
			run: context => moveAndReveal(context, ['x.txt', 'y.txt'], ['x.txt', 'y.txt'])
		},
		{
			id: 'folders',
			title: 'Move folders from two sources and reveal both descendants',
			run: context => moveAndReveal(context, ['first-folder', 'second-folder'], ['first-folder/first-child.txt', 'second-folder/second-child.txt'])
		},
		{
			id: 'targeted-refresh',
			title: 'A moved folder remains addressable for subsequent child updates',
			async run(context) {
				fs.writeFileSync(path.join(workspacePath, 'c', 'second-folder', 'new-child.txt'), 'after move\n');
				await context.page.locator('.explorer-item .label-name').filter({ hasText: /^new-child\.txt$/ }).waitFor({ timeout: 10000 });
				assert.deepEqual(await invoke(`function() {
					const folder = this.roots[0].getChild('c').getChild('second-folder');
					const child = folder.getChild('new-child.txt');
					return { folder: this.view.tree.hasNode(folder), child: !!child && this.view.tree.hasNode(child) };
				}`), { folder: true, child: true });
				await cdp.send('Runtime.releaseObject', { objectId: serviceId });
				await cdp.detach();
				return 'Both moved files and folders retain tree lookup, reveal, focus, selection and subsequent child refresh.';
			}
		}
	]
};
