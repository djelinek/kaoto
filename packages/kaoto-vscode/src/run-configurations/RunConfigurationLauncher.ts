import * as fs from 'fs'; // NOSONAR
import * as os from 'os'; // NOSONAR
import * as path from 'path'; // NOSONAR
import { commands, RelativePattern, ShellExecution, TaskExecution, tasks, Uri, workspace, WorkspaceFolder } from 'vscode';
import { CamelCommandAPI, CamelCommandOverrides } from '../executors/api/CamelCommandAPI';
import { CommandArguments, CommandResult, ExecutorType, RuntimeType } from '../executors/types/ExecutorTypes';
import { CamelTask, CamelTaskDefinition } from '../tasks/CamelTask';
import { CamelTaskFactory } from '../tasks/CamelTaskFactory';
import { PortManager } from '../services/PortManager';
import { KaotoCatalogService } from '../services/KaotoCatalogService';
import { NewCamelProjectCommand } from '../commands/NewCamelProjectCommand';
import { confirmDestructiveActionInSelectedFolder } from '../utils/Modals';
import { arePathsEqual } from '../utils/Path';
import { KaotoOutputChannel } from '../extension/KaotoOutputChannel';
import {
	KAOTO_EXCLUDE_PATTERN,
	KAOTO_EXECUTOR_EXPORT_ARGUMENTS_SETTING_ID,
	KAOTO_EXECUTOR_KUBERNETES_RUN_ARGUMENTS_SETTING_ID,
	KAOTO_EXECUTOR_RUN_ARGUMENTS_SETTING_ID,
	KAOTO_EXECUTOR_RUN_SOURCE_DIR_ARGUMENTS_SETTING_ID,
	KAOTO_EXECUTOR_TYPE_SETTING_ID,
	KAOTO_LOCAL_KAMELET_DIRECTORIES_SETTING_ID,
} from '../constants';
import {
	ArgumentDefaults,
	DEFAULT_GAV,
	ExportRuntime,
	formatCommandLine,
	getAction,
	KaotoRunConfiguration,
	RunConfigurationAction,
	RunConfigurationExecutor,
	splitArguments,
} from './RunConfigurationModel';
import { CatalogOption, PreviewResult, Problem, RunConfigurationDefaults, TargetOption } from './RunConfigurationProtocol';
import { CamelFileTracker } from './CamelFileTracker';

export const CAMEL_DEBUG_ADAPTER_EXTENSION_ID = 'redhat.vscode-debug-adapter-apache-camel';

/** JMX port that camel-debug listens on, the default of the Debug Adapter for Apache Camel attach */
export const CAMEL_DEBUGGER_JMX_PORT = 1099;

const CAMEL_DEBUG_DEPENDENCY = '--dep=org.apache.camel:camel-debug';

/** Port passed to the preview when the configuration picks a free port at launch */
const PREVIEW_FREE_PORT = 0;

const CAMEL_TARGET_GLOB = '**/{*.camel.yaml,*.camel.yml,*.camel.xml,*.pipe.yaml,*.pipe.yml,*-pipe.yaml,*-pipe.yml}';

/**
 * A run configuration with every missing field taken from the Kaoto settings and every path made absolute
 */
export interface ResolvedRunConfiguration {
	configuration: KaotoRunConfiguration;
	folder: WorkspaceFolder;
	action: RunConfigurationAction;
	executor: RunConfigurationExecutor;
	targetPath: string;
	targetIsFolder: boolean;
	/** Folder the command runs in: the target folder, or the folder of the target file */
	cwd: string;
	overrides: CamelCommandOverrides;
	runtime: ExportRuntime;
	gav: string;
	outputDirectory: string;
	kubernetes: boolean;
	openProject: boolean;
	problems: Problem[];
}

/**
 * A started run configuration
 */
export interface RunConfigurationExecution {
	readonly label: string;
	readonly port?: number;
	/** Resolves with the exit code when the task ends */
	readonly ended: Promise<number | undefined>;
	terminate(): void;
}

/**
 * Turns run configurations into Camel commands through the unchanged CamelCommandAPI, for the preview and for launching.
 */
export class RunConfigurationLauncher {
	constructor(
		private readonly extensionUri: Uri,
		private readonly portManager: PortManager,
		private readonly camelFileTracker: CamelFileTracker,
	) {}

	async readDefaults(): Promise<RunConfigurationDefaults> {
		const settings = workspace.getConfiguration();
		const selectedCatalog = await KaotoCatalogService.getInstance().getSelectedIntegrationCatalog();
		return {
			executor: settings.get<ExecutorType>(KAOTO_EXECUTOR_TYPE_SETTING_ID, 'jbang'),
			catalog: selectedCatalog?.name,
			run: splitArguments(settings.get<string[]>(KAOTO_EXECUTOR_RUN_ARGUMENTS_SETTING_ID)),
			runFolder: splitArguments(settings.get<string[]>(KAOTO_EXECUTOR_RUN_SOURCE_DIR_ARGUMENTS_SETTING_ID)),
			export: splitArguments(settings.get<string[]>(KAOTO_EXECUTOR_EXPORT_ARGUMENTS_SETTING_ID)),
			deploy: splitArguments(settings.get<string[]>(KAOTO_EXECUTOR_KUBERNETES_RUN_ARGUMENTS_SETTING_ID)),
			localKameletDirectories: settings.get<string[]>(KAOTO_LOCAL_KAMELET_DIRECTORIES_SETTING_ID, []),
		};
	}

	getCatalogOptions(): CatalogOption[] {
		return KaotoCatalogService.getInstance()
			.getCatalogs()
			.filter((catalog) => !['citrus', 'xslt'].includes(catalog.runtime.toLowerCase()))
			.map((catalog) => ({ name: catalog.name, runtime: catalog.runtime, version: catalog.version, launcherAvailable: !!catalog.executorVersion }));
	}

	/**
	 * Camel files of a workspace folder and the folders that contain them, as run targets
	 */
	async findTargets(folder: WorkspaceFolder): Promise<TargetOption[]> {
		const files = await workspace.findFiles(new RelativePattern(folder, CAMEL_TARGET_GLOB), KAOTO_EXCLUDE_PATTERN, 500);
		const relativeFiles = files.map((file) => path.relative(folder.uri.fsPath, file.fsPath).split(path.sep).join('/')).sort((a, b) => a.localeCompare(b));
		const relativeFolders = [...new Set(relativeFiles.map((file) => path.posix.dirname(file)).filter((dir) => dir !== '.'))].sort((a, b) =>
			a.localeCompare(b),
		);
		return [
			...relativeFiles.map((file): TargetOption => ({ value: `\${workspaceFolder}/${file}`, label: file, kind: 'file' })),
			{ value: '${workspaceFolder}', label: `${folder.name} (all Camel files)`, kind: 'folder' },
			...relativeFolders.map((dir): TargetOption => ({ value: `\${workspaceFolder}/${dir}`, label: `${dir}/`, kind: 'folder' })),
		];
	}

	async resolve(configuration: KaotoRunConfiguration, folder: WorkspaceFolder): Promise<ResolvedRunConfiguration> {
		const defaults = await this.readDefaults();
		const problems: Problem[] = [];
		const action = getAction(configuration);
		const substitute = (value: string) => this.substituteVariables(value, folder);

		const target = substitute(configuration.target ?? '${file}');
		const targetPath = path.resolve(folder.uri.fsPath, target);
		const targetStat = fs.statSync(targetPath, { throwIfNoEntry: false });
		const targetIsFolder = targetStat?.isDirectory() ?? false;
		if (target.includes('${file}')) {
			problems.push({ severity: 'error', field: 'target', message: '${file} needs an open Camel file. Open one, or choose a file as the target.' });
		} else if (!targetStat) {
			problems.push({ severity: 'error', field: 'target', message: `${targetPath} does not exist.` });
		}

		const argumentDefaults = this.getArgumentDefaults(defaults, action, targetIsFolder);
		const executor = configuration.executor ?? defaults.executor;
		const catalogService = KaotoCatalogService.getInstance();
		const catalog = await catalogService.resolveIntegrationCatalog(configuration.catalog);
		if (configuration.catalog && catalog?.name !== configuration.catalog) {
			problems.push({
				severity: 'warning',
				field: 'catalog',
				message: `The catalog ${configuration.catalog} is not available. The status bar selection is used.`,
			});
		}
		if (executor === 'camel-launcher' && catalog && !catalog.executorVersion) {
			problems.push({
				severity: 'warning',
				field: 'executor',
				message: `There is no Camel Launcher for ${catalog.name}. Camel CLI (JBang) supports this catalog.`,
			});
		}

		const catalogRuntime: string | undefined = catalogService.getRuntimeForCLI(catalog);
		const runtime = configuration.runtime ?? (catalogRuntime && catalogRuntime !== RuntimeType.CITRUS ? (catalogRuntime as ExportRuntime) : 'quarkus');
		const gav = configuration.gav ?? DEFAULT_GAV;
		const outputDirectory = path.resolve(folder.uri.fsPath, substitute(configuration.outputDirectory ?? '${workspaceFolder}'));
		const kubernetes = configuration.kubernetes ?? true;
		if (action === 'export') {
			const gavProblem = new NewCamelProjectCommand().validateGAV(gav);
			if (gavProblem) {
				problems.push({ severity: 'error', field: 'gav', message: gavProblem });
			}
			if (catalogRuntime && catalogRuntime !== runtime) {
				problems.push({
					severity: 'warning',
					field: 'runtime',
					message: `The catalog ${catalog?.name} is not a ${runtime} catalog, so the ${runtime} version comes from the Camel CLI defaults.`,
				});
			}
			if (!arePathsEqual(outputDirectory, folder.uri.fsPath) && this.hasFiles(outputDirectory)) {
				problems.push({ severity: 'warning', field: 'outputDirectory', message: `The export deletes the files in ${outputDirectory} first.` });
			}
		}
		if (action === 'deploy' && targetIsFolder) {
			problems.push({ severity: 'error', field: 'target', message: 'Deploy needs a Camel file as the target.' });
		}

		return {
			configuration,
			folder,
			action,
			executor,
			targetPath,
			targetIsFolder,
			cwd: targetIsFolder ? targetPath : path.dirname(targetPath),
			overrides: {
				executorType: executor === 'kompanion' ? undefined : executor,
				catalogName: configuration.catalog,
				userArguments: this.buildUserArguments(configuration, action, kubernetes, argumentDefaults, substitute),
				localKameletDirectories: configuration.localKameletDirectories?.map(substitute),
				env: configuration.env
					? Object.fromEntries(Object.entries(configuration.env).map(([key, value]) => [key, substitute(String(value))]))
					: undefined,
			},
			runtime,
			gav,
			outputDirectory,
			kubernetes,
			openProject: configuration.openProject ?? true,
			problems,
		};
	}

	/**
	 * Command line, Kompanion request and problems of a configuration, built by the code that runs it
	 */
	async preview(configuration: KaotoRunConfiguration, folder: WorkspaceFolder, requestId: number): Promise<PreviewResult> {
		const resolved = await this.resolve(configuration, folder);
		const result: PreviewResult = { requestId, cwd: resolved.cwd, env: resolved.overrides.env, problems: resolved.problems };

		if (resolved.executor === 'kompanion') {
			result.kompanionRequest = JSON.stringify(await this.buildKompanionRequest(resolved), undefined, 2);
			result.problems.push({
				severity: 'warning',
				message: 'Kaoto Kompanion cannot launch integrations yet: its engine only logs the request. Run and Debug stay disabled.',
			});
			return result;
		}

		try {
			const port = configuration.managementPort ?? PREVIEW_FREE_PORT;
			const command = await this.buildCommand(resolved, { port, preview: true });
			result.commandLine = this.formatExecution(command.execution, configuration.managementPort === undefined);
		} catch (error) {
			result.problems.push({ severity: 'error', message: error instanceof Error ? error.message : String(error) });
		}
		return result;
	}

	/**
	 * Start the configuration as a Camel task. Returns undefined when the user cancels it.
	 * With `debugRoutes`, the run includes camel-debug and waits for the Camel route debugger to attach.
	 */
	async launch(resolved: ResolvedRunConfiguration, debugRoutes: boolean): Promise<RunConfigurationExecution | undefined> {
		const blocking = resolved.problems.find((problem) => problem.severity === 'error');
		if (blocking) {
			throw new Error(blocking.message);
		}
		if (resolved.executor === 'kompanion') {
			throw new Error('Kaoto Kompanion cannot launch integrations yet.');
		}

		switch (resolved.action) {
			case 'run':
				return this.launchRun(resolved, debugRoutes);
			case 'export':
				return this.launchExport(resolved);
			case 'deploy': {
				const result = await this.buildCommand(resolved, {});
				const task = CamelTaskFactory.create({ label: `Deploying - ${path.basename(resolved.targetPath)}` }, result);
				return this.execute(task);
			}
		}
	}

	async waitForCamelDebugger(timeoutMs: number): Promise<boolean> {
		return this.portManager.waitForPortReachable(CAMEL_DEBUGGER_JMX_PORT, timeoutMs, 500);
	}

	substituteVariables(value: string, folder: WorkspaceFolder): string {
		const file = this.camelFileTracker.getLastCamelFile()?.fsPath;
		return value.replaceAll(/\$\{([^}]+)\}/g, (match, variable: string) => {
			switch (variable) {
				case 'workspaceFolder':
					return folder.uri.fsPath;
				case 'workspaceFolderBasename':
					return folder.name;
				case 'userHome':
					return os.homedir();
				case 'pathSeparator':
					return path.sep;
				case 'file':
					return file ?? match;
				case 'fileDirname':
					return file ? path.dirname(file) : match;
			}
			if (variable.startsWith('env:')) {
				return process.env[variable.substring('env:'.length)] ?? '';
			}
			if (variable.startsWith('workspaceFolder:')) {
				const name = variable.substring('workspaceFolder:'.length);
				return workspace.workspaceFolders?.find((candidate) => candidate.name === name)?.uri.fsPath ?? match;
			}
			return match;
		});
	}

	private async launchRun(resolved: ResolvedRunConfiguration, debugRoutes: boolean): Promise<RunConfigurationExecution> {
		const allocatedPort = resolved.configuration.managementPort ?? (await this.portManager.allocatePort());
		let task: CamelTask | undefined;
		try {
			const result = await this.buildCommand(resolved, { port: allocatedPort, debugRoutes });
			// Same label as the Run button: the Deployments view finds the logs terminal by it
			task = CamelTaskFactory.createBackground(`Running - ${path.basename(resolved.targetPath)}::${result.resolvedPort}`, result);
			const actualPort = (task.definition as CamelTaskDefinition).port;
			if (actualPort !== allocatedPort) {
				this.portManager.releasePort(allocatedPort);
			}
			this.portManager.getUsedPorts().add(actualPort);
			return await this.execute(task, actualPort);
		} catch (error) {
			this.portManager.releasePort(task ? (task.definition as CamelTaskDefinition).port : allocatedPort);
			throw error;
		}
	}

	private async launchExport(resolved: ResolvedRunConfiguration): Promise<RunConfigurationExecution | undefined> {
		const exportsIntoWorkspaceFolder = arePathsEqual(resolved.outputDirectory, resolved.folder.uri.fsPath);
		if (!exportsIntoWorkspaceFolder && this.hasFiles(resolved.outputDirectory)) {
			const choice = await confirmDestructiveActionInSelectedFolder(resolved.outputDirectory);
			if (!choice) {
				return undefined;
			}
		}

		const result = await this.buildCommand(resolved, {});
		const task = CamelTaskFactory.create({ label: `Exporting - ${resolved.configuration.name}`, scope: resolved.folder }, result);
		const execution = await this.execute(task);
		void execution.ended.then(async (exitCode) => {
			if (exitCode !== 0 || !resolved.openProject || exportsIntoWorkspaceFolder) {
				return;
			}
			await this.copyProjectTemplates(resolved.runtime, resolved.outputDirectory);
			await commands.executeCommand('vscode.openFolder', Uri.file(resolved.outputDirectory), true);
		});
		return execution;
	}

	private async buildCommand(
		resolved: ResolvedRunConfiguration,
		options: { port?: number; debugRoutes?: boolean; preview?: boolean },
	): Promise<CommandResult> {
		const env = options.debugRoutes ? { ...resolved.overrides.env, CAMEL_DEBUGGER_SUSPEND: 'true' } : resolved.overrides.env;
		const overrides: CamelCommandOverrides = { ...resolved.overrides, env, preview: options.preview };
		const additionalArgs: CommandArguments = options.debugRoutes ? [CAMEL_DEBUG_DEPENDENCY] : [];

		switch (resolved.action) {
			case 'run':
				return resolved.targetIsFolder
					? CamelCommandAPI.runSourceDir(resolved.targetPath, options.port, additionalArgs, overrides)
					: CamelCommandAPI.run(resolved.targetPath, resolved.cwd, options.port, additionalArgs, overrides);
			case 'export':
				return CamelCommandAPI.export(
					resolved.targetPath,
					resolved.gav,
					resolved.runtime as RuntimeType,
					resolved.outputDirectory,
					resolved.cwd,
					resolved.kubernetes,
					[],
					overrides,
				);
			case 'deploy':
				return CamelCommandAPI.kubernetesRun(resolved.targetPath, resolved.cwd, [], overrides);
		}
	}

	private async execute(task: CamelTask, port?: number): Promise<RunConfigurationExecution> {
		let execution: TaskExecution | undefined;
		let exitCode: number | undefined;
		const isThisTask = (candidate: TaskExecution) => candidate === execution || candidate.task === task;
		const ended = new Promise<number | undefined>((resolve) => {
			const processListener = tasks.onDidEndTaskProcess((event) => {
				if (isThisTask(event.execution)) {
					exitCode = event.exitCode;
				}
			});
			const taskListener = tasks.onDidEndTask((event) => {
				if (isThisTask(event.execution)) {
					processListener.dispose();
					taskListener.dispose();
					resolve(exitCode);
				}
			});
		});
		execution = await task.execute();
		const startedExecution = execution;
		return { label: task.name, port, ended, terminate: () => startedExecution.terminate() };
	}

	private getArgumentDefaults(defaults: RunConfigurationDefaults, action: RunConfigurationAction, targetIsFolder: boolean): ArgumentDefaults {
		switch (action) {
			case 'run':
				return targetIsFolder ? defaults.runFolder : defaults.run;
			case 'export':
				return defaults.export;
			case 'deploy':
				return defaults.deploy;
		}
	}

	/**
	 * Arguments that replace the Kaoto run, export or Kubernetes run arguments setting
	 */
	private buildUserArguments(
		configuration: KaotoRunConfiguration,
		action: RunConfigurationAction,
		kubernetes: boolean,
		defaults: ArgumentDefaults,
		substitute: (value: string) => string,
	): string[] {
		const extraArgs = (configuration.args ?? defaults.args).map(substitute);
		const dev = configuration.dev ?? defaults.dev;
		const clusterType = configuration.clusterType ?? defaults.clusterType;
		switch (action) {
			case 'run': {
				const loggingLevel = configuration.loggingLevel ?? defaults.loggingLevel;
				const propertiesFiles = configuration.propertiesFiles?.map(substitute) ?? [];
				const dependencies = configuration.dependencies ?? [];
				return [
					dev ? '--dev' : '',
					loggingLevel ? `--logging-level=${loggingLevel}` : '',
					propertiesFiles.length > 0 ? `--properties=${propertiesFiles.join(',')}` : '',
					dependencies.length > 0 ? `--dep=${dependencies.join(',')}` : '',
					...extraArgs,
				].filter((arg) => arg !== '');
			}
			case 'export':
				return [kubernetes && clusterType ? `--cluster-type=${clusterType}` : '', ...extraArgs].filter((arg) => arg !== '');
			case 'deploy':
				return [clusterType ? `--cluster-type=${clusterType}` : '', ...extraArgs, dev ? '--dev' : ''].filter((arg) => arg !== '');
		}
	}

	/**
	 * Body of `POST /v1/executions` (ExecutionContext and WorkloadSpec in packages/kompanion)
	 */
	private async buildKompanionRequest(resolved: ResolvedRunConfiguration): Promise<unknown> {
		const workspaceRoot = resolved.folder.uri.fsPath;
		const sourcePaths = resolved.targetIsFolder
			? (await workspace.findFiles(new RelativePattern(Uri.file(resolved.targetPath), CAMEL_TARGET_GLOB), KAOTO_EXCLUDE_PATTERN)).map(
					(file) => file.fsPath,
				)
			: [resolved.targetPath];
		const catalogService = KaotoCatalogService.getInstance();
		const catalog = await catalogService.resolveIntegrationCatalog(resolved.configuration.catalog);
		const runtime = catalogService.getRuntimeForCLI(catalog) ?? RuntimeType.MAIN;
		const profileRuntime = runtime === RuntimeType.MAIN ? 'camel-main' : `camel-${runtime}`;
		return {
			workspaceRoot,
			workload: {
				framework: 'CAMEL',
				runtimeProfileId: `${profileRuntime}:${catalog?.version ?? ''}`,
				sources: sourcePaths.map((source) => ({
					path: path.relative(workspaceRoot, source).split(path.sep).join('/'),
					format: source.endsWith('.xml') ? 'CAMEL_XML' : 'CAMEL_YAML',
				})),
				beans: [],
				propertiesFiles: (resolved.configuration.propertiesFiles ?? []).map((file) =>
					path
						.relative(workspaceRoot, path.resolve(resolved.cwd, this.substituteVariables(file, resolved.folder)))
						.split(path.sep)
						.join('/'),
				),
				envFiles: [],
			},
		};
	}

	/**
	 * Render a ShellExecution as the line a terminal shows, with a placeholder for a port picked at launch
	 */
	private formatExecution(execution: ShellExecution, freePort: boolean): string {
		const command = typeof execution.command === 'string' ? execution.command : (execution.command?.value ?? '');
		const args = (execution.args ?? []).map((arg) => (typeof arg === 'string' ? arg : arg.value));
		const line = formatCommandLine([command, ...args]);
		return freePort ? line.replaceAll(/(--(?:management-)?port)=0(?=\s|$)/g, '$1=<free-port>') : line;
	}

	private hasFiles(directory: string): boolean {
		try {
			return fs.readdirSync(directory).length > 0;
		} catch {
			return false;
		}
	}

	/**
	 * Same tasks.json and launch.json templates as the export wizard copies into a new project
	 */
	private async copyProjectTemplates(runtime: ExportRuntime, outputDirectory: string): Promise<void> {
		for (const filename of ['tasks.json', 'launch.json']) {
			const source = Uri.joinPath(this.extensionUri, 'resources', 'maven-export', runtime, filename);
			const destination = Uri.file(path.join(outputDirectory, '.vscode', filename));
			try {
				await workspace.fs.copy(source, destination, { overwrite: false });
			} catch (error) {
				KaotoOutputChannel.logInfo(`Not copying ${filename} into the exported project: ${error instanceof Error ? error.message : error}`);
			}
		}
	}
}
