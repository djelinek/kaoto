/**
 * Generic Camel executor interface
 */

import { CamelCommand, CommandArguments, CommandContext, CommandResult } from './types/ExecutorTypes';
import { ExecutorConfig } from './types/ExecutorConfig';

/**
 * Generic Camel executor interface
 * All executors implement this simple, generic API
 */
export interface ICamelExecutor {
	/**
	 * Get executor configuration
	 */
	getConfig(): ExecutorConfig;

	/**
	 * Execute a Camel command with arguments
	 * @param command - Camel command to execute
	 * @param args - Command arguments
	 * @param context - Execution context (cwd, env, etc.)
	 * @returns Command execution result
	 */
	execute(command: CamelCommand, args: CommandArguments, context?: CommandContext): Promise<CommandResult>;

	/**
	 * Build a Camel command without checking that the executor is available
	 * (used to preview the command of a run configuration)
	 * @param command - Camel command to build
	 * @param args - Command arguments
	 * @param context - Execution context (cwd, env, etc.)
	 * @returns Command execution result
	 */
	buildCommand(command: CamelCommand, args: CommandArguments, context?: CommandContext): Promise<CommandResult>;

	/**
	 * Check if executor is available and properly configured
	 */
	isAvailable(): Promise<boolean>;

	/**
	 * Get executor version
	 */
	getVersion(): string;
}
