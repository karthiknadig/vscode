/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'markdown-mapping-review-'));
const original = path.join(workspacePath, 'original.md');
const modified = path.join(workspacePath, 'modified.md');
fs.writeFileSync(original, '');
fs.writeFileSync(modified, 'Alpha\n\nBeta\n');
const resultPath = path.join(__dirname, `mapping-${Date.now()}.json`);
const result = { workspacePath };
let preview;
async function command(context, operation) {
	const response = path.join(__dirname, 'response.json');
	fs.rmSync(response, { force: true });
	fs.writeFileSync(path.join(__dirname, 'request.json'), JSON.stringify({ operation, original, modified, response }));
	await context.workbench.quickaccess.runCommand('markdownMappingReview.run');
	const deadline = Date.now() + 15000;
	while (!fs.existsSync(response)) {
		if (Date.now() > deadline) {
			throw new Error(`Timed out: ${operation}`);
		}
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	const value = JSON.parse(fs.readFileSync(response, 'utf8'));
	assert.equal(value.ok, true, value.error);
}
module.exports = {
	id: 'markdown-shifted-decoration-review',
	title: 'Moved decorated paragraphs retain incoming source-line mappings',
	source: 'https://github.com/microsoft/vscode/pull/339545#discussion_r4191163744',
	workspacePath,
	stepPauseMs: 0,
	extraArgs: [`--extensionDevelopmentPath=${path.join(__dirname, 'fixture')}`, '--disable-workspace-trust'],
	userSettings: { 'workbench.startupEditor': 'none', 'chat.disableAIFeatures': true, 'git.enabled': false, 'diffEditor.renderSideBySide': true },
	steps: [
		{
			id: 'baseline',
			title: 'Open real Markdown and apply valid added-line metadata to Alpha and Beta',
			async run(context) {
				await command(context, 'open');
				const deadline = Date.now() + 20000;
				while (!preview) {
					for (const frame of context.page.frames()) {
						if (!frame.isDetached() && await frame.locator('.markdown-body > p').filter({ hasText: /^Alpha$/ }).count()) {
							preview = frame;
							break;
						}
					}
					if (Date.now() > deadline) {
						throw new Error('Modified Markdown preview did not load');
					}
					if (!preview) {
						await new Promise(resolve => setTimeout(resolve, 100));
					}
				}
				await preview.evaluate(() => {
					const settings = JSON.parse(document.getElementById('vscode-markdown-preview-data').getAttribute('data-settings'));
					window.dispatchEvent(new MessageEvent('message', { data: {
						type: 'updateContent', source: settings.source, content: document.querySelector('.markdown-body').outerHTML,
						lineChanges: { added: [0, 1, 2, 3] }
					} }));
				});
				await preview.waitForFunction(() => document.querySelectorAll('.markdown-body > p.code-line-diff-added').length === 2);
				result.before = await preview.locator('.markdown-body > p').evaluateAll(elements => elements.map(element => ({ text: element.textContent, line: element.getAttribute('data-line') })));
				assert.deepEqual(result.before, [{ text: 'Alpha', line: '0' }, { text: 'Beta', line: '2' }]);
				await preview.evaluate(() => {
					window.addEventListener('message', event => {
						if (event.data.type === 'updateContent') {
							const incoming = new DOMParser().parseFromString(event.data.content, 'text/html');
							const paragraphs = [...incoming.querySelectorAll('.markdown-body > p')];
							if (paragraphs[0]?.textContent === 'Alpha' && paragraphs[0].getAttribute('data-line') === '2') {
								window.reviewShiftArrived = true;
							}
						}
					});
				});
				return JSON.stringify(result.before);
			}
		},
		{
			id: 'shift',
			title: 'Insert two real source lines and verify incoming positions after morphdom reconciliation',
			async run(context) {
				await command(context, 'shift');
				await preview.waitForFunction(() => window.reviewShiftArrived === true);
				await preview.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
				assert.equal(fs.readFileSync(modified, 'utf8'), '\n\nAlpha\n\nBeta\n');
				result.after = await preview.locator('.markdown-body > p').evaluateAll(elements => elements.map(element => ({ text: element.textContent, line: element.getAttribute('data-line') })));
				fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
				assert.deepEqual(result.after, [{ text: 'Alpha', line: '2' }, { text: 'Beta', line: '4' }]);
				return JSON.stringify(result.after);
			}
		}
	]
};
