/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
exports.activate = context => {
	context.subscriptions.push(vscode.commands.registerCommand('markdownMappingReview.run', async () => {
		const request = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'request.json'), 'utf8'));
		try {
			const modified = vscode.Uri.file(request.modified);
			if (request.operation === 'open') {
				await vscode.commands.executeCommand('vscode.openWith', modified, 'vscode.markdown.preview.editor', { preview: false });
			} else if (request.operation === 'shift') {
				const edit = new vscode.WorkspaceEdit();
				edit.insert(modified, new vscode.Position(0, 0), '\n\n');
				if (!await vscode.workspace.applyEdit(edit)) {
					throw new Error('Source edit was rejected');
				}
				await (await vscode.workspace.openTextDocument(modified)).save();
			} else {
				throw new Error(`Unsupported operation: ${request.operation}`);
			}
			fs.writeFileSync(request.response, JSON.stringify({ ok: true }));
		} catch (error) {
			fs.writeFileSync(request.response, JSON.stringify({ ok: false, error: String(error.stack || error) }));
			throw error;
		}
	}));
};
