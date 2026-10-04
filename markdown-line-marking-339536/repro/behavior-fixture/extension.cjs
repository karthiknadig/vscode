/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

exports.activate = context => {
	context.subscriptions.push(vscode.commands.registerCommand('markdownLineMapSmoke.run', async () => {
		const request = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'behavior-request.json'), 'utf8'));
		try {
			const original = vscode.Uri.file(request.original);
			const modified = vscode.Uri.file(request.modified);
			let detail;
			switch (request.kind) {
				case 'preview':
					await vscode.commands.executeCommand('vscode.openWith', original, 'vscode.markdown.preview.editor', { preview: false });
					break;
				case 'synced':
					await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(original), { viewColumn: vscode.ViewColumn.One });
					await vscode.commands.executeCommand('markdown.showPreviewToSide', original);
					break;
				case 'select': {
					const editor = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === original.toString());
					assert.ok(editor, 'Source editor must remain visible');
					editor.selection = new vscode.Selection(request.line, 0, request.line, 0);
					editor.revealRange(editor.selection, vscode.TextEditorRevealType.AtTop);
					break;
				}
				case 'inspect':
					detail = vscode.window.visibleTextEditors.map(editor => ({ uri: editor.document.uri.toString(), line: editor.selection.active.line }));
					break;
				case 'diff':
					await vscode.workspace.getConfiguration('diffEditor').update('renderSideBySide', request.sideBySide, vscode.ConfigurationTarget.Global);
					await vscode.commands.executeCommand('workbench.action.closeAllEditors');
					await vscode.commands.executeCommand('_workbench.diff', original, modified, 'Generated Markdown mapping smoke', [undefined, { override: 'vscode.markdown.preview.editor', pinned: true }]);
					break;
				case 'replace': {
					const document = await vscode.workspace.openTextDocument(modified);
					const edit = new vscode.WorkspaceEdit();
					edit.replace(modified, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), request.text);
					assert.equal(await vscode.workspace.applyEdit(edit), true);
					assert.equal(await document.save(), true);
					detail = { version: document.version };
					break;
				}
				default:
					throw new Error(`Unknown smoke operation: ${request.kind}`);
			}
			fs.writeFileSync(request.response, JSON.stringify({ ok: true, detail }));
		} catch (error) {
			fs.writeFileSync(request.response, JSON.stringify({ ok: false, error: String(error.stack || error) }));
			throw error;
		}
	}));
};
