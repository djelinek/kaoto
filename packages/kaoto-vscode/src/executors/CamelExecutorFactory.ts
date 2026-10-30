import * as vscode from 'vscode';
import { ICamelExecutor } from './ICamelExecutor';
import { JBangExecutor } from './JBangExecutor';
import { CamelLauncherExecutor } from './CamelLauncherExecutor';
import { CamelLauncherDownloader } from '../services/CamelLauncherDownloader';
import { AnyExecutorConfig, CamelLauncherExecutorConfig } from './types/ExecutorConfig';
import { ExecutorType } from './types/ExecutorTypes';
import { KaotoOutputChannel } from '../extension/KaotoOutputChannel';
import { KaotoCatalogService } from '../services/KaotoCatalogService';
import { DEFAULT_CAMEL_VERSION_FALLBACK, KAOTO_EXECUTOR_TYPE_SETTING_ID } from '../constants';

/**
 * Values of a run configuration that replace the executor settings
 */
export interface ExecutorOverrides {
	readonly type?: ExecutorType;
	readonly catalogName?: string;
}

/**
 * Factory for creating executor instances
 * Type-safe and extensible
 */
export class CamelExecutorFactory {
	private static executorInstance: ICamelExecutor | undefined;
	private static currentConfig: AnyExecutorConfig | undefined;
	private static downloader: CamelLauncherDownloader;
	private static extensionContext: vscode.ExtensionContext | undefined;

	/**
	 * Initialize the factory with extension context
	 * Should be called during extension activation
	 */
	static initialize(context: vscode.ExtensionContext): void {
		this.extensionContext = context;
	}

	/**
	 * Create executor based on configuration
	 */
	static async createExecutor(overrides: ExecutorOverrides = {}): Promise<ICamelExecutor> {
		const config = await this.loadConfiguration(overrides);

		// Reset cache if configuration changed
		if (this.hasConfigChanged(config)) {
			this.resetExecutor();
		}

		// Return cached instance
		if (this.executorInstance) {
			return this.executorInstance;
		}

		// Create new executor
		this.currentConfig = config;
		this.executorInstance = await this.createExecutorForType(config);

		KaotoOutputChannel.logInfo(`Executor initialized: ${config.type} (version: ${config.version})`);

		return this.executorInstance;
	}

	/**
	 * Create an executor that only builds commands, for the run configuration preview.
	 * It is not cached and never downloads the Camel Launcher.
	 */
	static async createPreviewExecutor(overrides: ExecutorOverrides = {}): Promise<ICamelExecutor> {
		const config = await this.loadConfiguration(overrides);
		if (config.type === 'camel-launcher') {
			return new CamelLauncherExecutor(config, this.getDownloader().getLauncherJarPath(config.version));
		}
		return new JBangExecutor(config);
	}

	/**
	 * Load configuration from VS Code settings
	 * Version is determined from catalog selection
	 */
	private static async loadConfiguration(overrides: ExecutorOverrides): Promise<AnyExecutorConfig> {
		const vscodeConfig = vscode.workspace.getConfiguration();
		const executorType = overrides.type ?? vscodeConfig.get<ExecutorType>(KAOTO_EXECUTOR_TYPE_SETTING_ID, 'jbang');

		// Get version from catalog service - use selected catalog, not default
		const catalogService = KaotoCatalogService.getInstance();
		const catalog = await catalogService.resolveIntegrationCatalog(overrides.catalogName);
		const version = catalogService.getCamelVersionForCLI(catalog, executorType) || DEFAULT_CAMEL_VERSION_FALLBACK;

		switch (executorType) {
			case 'jbang':
				return {
					type: 'jbang',
					version: version,
				};

			case 'camel-launcher':
				return {
					type: 'camel-launcher',
					version: version,
				};

			default:
				throw new Error(`Unknown executor type: ${executorType}`);
		}
	}

	/**
	 * Create executor for specific type
	 */
	private static async createExecutorForType(config: AnyExecutorConfig): Promise<ICamelExecutor> {
		switch (config.type) {
			case 'jbang':
				return new JBangExecutor(config);

			case 'camel-launcher':
				return await this.createCamelLauncherExecutor(config);

			default: {
				const exhaustiveCheck: never = config;
				throw new Error(`Unknown executor type: ${(exhaustiveCheck as AnyExecutorConfig).type}`);
			}
		}
	}

	/**
	 * Create Camel Launcher executor, downloading the JAR if needed
	 */
	private static async createCamelLauncherExecutor(config: CamelLauncherExecutorConfig): Promise<ICamelExecutor> {
		const jarPath = await this.getDownloader().ensureLauncher(config.version);
		KaotoOutputChannel.logInfo(`Using Camel Launcher ${config.version}: ${jarPath}`);

		return new CamelLauncherExecutor(config, jarPath);
	}

	private static getDownloader(): CamelLauncherDownloader {
		if (!this.downloader) {
			this.downloader = new CamelLauncherDownloader(this.extensionContext);
		}
		return this.downloader;
	}

	/**
	 * Check if configuration changed
	 */
	private static hasConfigChanged(newConfig: AnyExecutorConfig): boolean {
		if (!this.currentConfig) {
			return true;
		}

		return this.currentConfig.type !== newConfig.type || this.currentConfig.version !== newConfig.version;
	}

	/**
	 * Reset cached executor
	 */
	static resetExecutor(): void {
		this.executorInstance = undefined;
		this.currentConfig = undefined;
	}
}
