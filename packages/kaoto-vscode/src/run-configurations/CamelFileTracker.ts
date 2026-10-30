import { Disposable, TabInputCustom, TabInputText, Uri, window } from 'vscode';

const CAMEL_FILE_PATTERN = /(\.camel\.(ya?ml|xml)|\.pipe\.ya?ml|-pipe\.ya?ml)$/;

/**
 * Remembers the last Camel file shown in a text or Kaoto editor, so that `${file}` still means that file
 * while the Run Configurations tab has the focus.
 */
export class CamelFileTracker implements Disposable {
	private lastCamelFile: Uri | undefined;
	private readonly disposables: Disposable[];

	constructor() {
		this.update();
		this.disposables = [window.tabGroups.onDidChangeTabs(() => this.update()), window.tabGroups.onDidChangeTabGroups(() => this.update())];
	}

	static isCamelFile(uri: Uri): boolean {
		return CAMEL_FILE_PATTERN.test(uri.path);
	}

	getLastCamelFile(): Uri | undefined {
		return this.lastCamelFile;
	}

	dispose(): void {
		this.disposables.forEach((disposable) => disposable.dispose());
	}

	private update(): void {
		const input = window.tabGroups.activeTabGroup.activeTab?.input;
		const uri = input instanceof TabInputText || input instanceof TabInputCustom ? input.uri : undefined;
		if (uri && CamelFileTracker.isCamelFile(uri)) {
			this.lastCamelFile = uri;
		}
	}
}
