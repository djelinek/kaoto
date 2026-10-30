import {
	commands,
	debug,
	DebugAdapter,
	DebugProtocolMessage,
	DebugSession,
	Disposable,
	EventEmitter,
	extensions,
	window,
	workspace,
	WorkspaceFolder,
} from 'vscode';
import { KaotoOutputChannel } from '../extension/KaotoOutputChannel';
import { KaotoRunConfiguration } from './RunConfigurationModel';
import { CAMEL_DEBUG_ADAPTER_EXTENSION_ID, CAMEL_DEBUGGER_JMX_PORT, RunConfigurationExecution, RunConfigurationLauncher } from './RunConfigurationLauncher';

interface DebugProtocolRequest {
	seq: number;
	type: string;
	command: string;
	arguments?: { noDebug?: boolean };
}

const CAMEL_DEBUGGER_TIMEOUT_MS = 180_000;

/**
 * In-process debug adapter of the `kaoto` debug type. It answers the minimum of the Debug Adapter Protocol
 * and hands the work to a Camel task: `launch` starts the task, Stop terminates it, and the session ends with the task.
 * With F5 and `debugRoutes: true` it also attaches the Camel route debugger of the Debug Adapter for Apache Camel as a child session.
 */
export class KaotoDebugAdapter implements DebugAdapter {
	private readonly messageEmitter = new EventEmitter<DebugProtocolMessage>();
	readonly onDidSendMessage = this.messageEmitter.event;
	private readonly disposables: Disposable[] = [this.messageEmitter];
	private sequence = 1;
	private execution: RunConfigurationExecution | undefined;
	private camelDebuggerSession: DebugSession | undefined;
	private stopRequested = false;
	private ended = false;

	constructor(
		private readonly session: DebugSession,
		private readonly launcher: RunConfigurationLauncher,
	) {}

	handleMessage(message: DebugProtocolMessage): void {
		const request = message as DebugProtocolRequest;
		if (request.type !== 'request') {
			return;
		}
		switch (request.command) {
			case 'initialize':
				this.respond(request, { supportsConfigurationDoneRequest: true, supportsTerminateRequest: true });
				this.sendEvent('initialized');
				break;
			case 'launch':
				void this.launch(request);
				break;
			case 'terminate':
			case 'disconnect':
				this.stop();
				this.respond(request);
				break;
			case 'threads':
				this.respond(request, { threads: [] });
				break;
			case 'setBreakpoints':
				// route breakpoints belong to the Camel debugger session
				this.respond(request, { breakpoints: [] });
				break;
			default:
				this.respond(request);
		}
	}

	dispose(): void {
		this.stop();
		this.disposables.forEach((disposable) => disposable.dispose());
	}

	private async launch(request: DebugProtocolRequest): Promise<void> {
		const configuration = this.session.configuration as KaotoRunConfiguration;
		const noDebug = request.arguments?.noDebug === true || configuration.noDebug === true;
		try {
			const folder = this.session.workspaceFolder ?? workspace.workspaceFolders?.[0];
			if (!folder) {
				throw new Error('Open a workspace folder to start a Kaoto run configuration.');
			}
			const resolved = await this.launcher.resolve(configuration, folder);
			const debugRoutes = !noDebug && resolved.action === 'run' && configuration.debugRoutes === true && this.isCamelDebuggerAvailable();
			const execution = await this.launcher.launch(resolved, debugRoutes);
			this.respond(request);
			if (!execution) {
				this.end(undefined);
				return;
			}
			this.execution = execution;
			this.output(`${execution.label} started${execution.port ? ` with management port ${execution.port}` : ''}.\n`);
			void execution.ended.then((exitCode) => this.end(exitCode));
			if (this.stopRequested) {
				execution.terminate();
			} else if (debugRoutes) {
				void this.attachCamelDebugger(folder);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			KaotoOutputChannel.logError(`Run configuration "${configuration.name}" failed to start`, error);
			this.respondError(request, message);
		}
	}

	private isCamelDebuggerAvailable(): boolean {
		if (extensions.getExtension(CAMEL_DEBUG_ADAPTER_EXTENSION_ID)) {
			return true;
		}
		const install = 'Install';
		void window
			.showInformationMessage('Install the Debug Adapter for Apache Camel to stop at route breakpoints. Running without the route debugger.', install)
			.then((choice) => {
				if (choice === install) {
					void commands.executeCommand('workbench.extensions.installExtension', CAMEL_DEBUG_ADAPTER_EXTENSION_ID);
				}
			});
		return false;
	}

	/**
	 * Wait until camel-debug opens its JMX port, then start an `apache.camel` attach session under this one
	 */
	private async attachCamelDebugger(folder: WorkspaceFolder): Promise<void> {
		this.output(`Waiting for the Camel route debugger on JMX port ${CAMEL_DEBUGGER_JMX_PORT}...\n`);
		const reachable = await this.launcher.waitForCamelDebugger(CAMEL_DEBUGGER_TIMEOUT_MS);
		if (this.ended) {
			return;
		}
		if (!reachable) {
			this.output(`The Camel route debugger did not open JMX port ${CAMEL_DEBUGGER_JMX_PORT}. Route breakpoints are not available.\n`);
			return;
		}
		const listener = debug.onDidStartDebugSession((child) => {
			if (child.parentSession === this.session) {
				this.camelDebuggerSession = child;
				listener.dispose();
			}
		});
		this.disposables.push(listener);
		const started = await debug.startDebugging(
			folder,
			{ type: 'apache.camel', request: 'attach', name: `Camel routes - ${this.session.name}` },
			{ parentSession: this.session, lifecycleManagedByParent: true, compact: true },
		);
		if (!started) {
			this.output('The Camel route debugger could not attach.\n');
		}
	}

	private stop(): void {
		this.stopRequested = true;
		if (!this.ended) {
			this.execution?.terminate();
		}
	}

	private end(exitCode: number | undefined): void {
		if (this.ended) {
			return;
		}
		this.ended = true;
		if (exitCode !== undefined) {
			this.output(`Exited with code ${exitCode}.\n`);
		}
		if (this.camelDebuggerSession) {
			void debug.stopDebugging(this.camelDebuggerSession);
		}
		this.sendEvent('exited', { exitCode: exitCode ?? 0 });
		this.sendEvent('terminated');
	}

	private output(text: string): void {
		this.sendEvent('output', { category: 'console', output: text });
	}

	private respond(request: DebugProtocolRequest, body?: unknown): void {
		this.messageEmitter.fire({
			seq: this.sequence++,
			type: 'response',
			request_seq: request.seq,
			command: request.command,
			success: true,
			body,
		} as DebugProtocolMessage);
	}

	private respondError(request: DebugProtocolRequest, message: string): void {
		this.messageEmitter.fire({
			seq: this.sequence++,
			type: 'response',
			request_seq: request.seq,
			command: request.command,
			success: false,
			message,
			body: { error: { id: 1, format: message, showUser: true } },
		} as DebugProtocolMessage);
	}

	private sendEvent(event: string, body?: unknown): void {
		this.messageEmitter.fire({ seq: this.sequence++, type: 'event', event, body } as DebugProtocolMessage);
	}
}
