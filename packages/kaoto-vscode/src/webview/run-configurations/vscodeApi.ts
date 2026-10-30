import { WebviewMessage } from '../../run-configurations/RunConfigurationProtocol';

interface VsCodeApi {
	postMessage(message: WebviewMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscodeApi = acquireVsCodeApi();

export function postMessage(message: WebviewMessage): void {
	vscodeApi.postMessage(message);
}
