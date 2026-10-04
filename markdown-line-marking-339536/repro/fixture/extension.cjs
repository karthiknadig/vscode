/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

exports.activate = context => {
	const requestPath = path.join(__dirname, '..', 'request.json');
	for (const kind of ['openPreview', 'openDiff', 'render']) {
		context.subscriptions.push(vscode.commands.registerCommand(`markdownHunt.${kind}`, async () => {
			const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
			try {
				const started = performance.now();
				let detail;
				if (kind === 'openPreview') {
					await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(request.modified), 'vscode.markdown.preview.editor', { preview: false });
				} else if (kind === 'openDiff') {
					await vscode.commands.executeCommand('_workbench.diff', vscode.Uri.file(request.original), vscode.Uri.file(request.modified), request.title, [undefined, { override: 'vscode.markdown.preview.editor', pinned: true }]);
				} else {
					const input = fs.readFileSync(request.modified, 'utf8');
					const html = await vscode.commands.executeCommand('markdown.api.render', input);
					detail = { inputBytes: Buffer.byteLength(input), htmlBytes: Buffer.byteLength(html), html };
				}
				fs.writeFileSync(request.response, JSON.stringify({ ok: true, commandMs: performance.now() - started, detail }));
			} catch (error) {
				fs.writeFileSync(request.response, JSON.stringify({ ok: false, error: String(error.stack || error) }));
				throw error;
			}
		}));
	}
};
