import { ReactNode, useState } from 'react';
import {
	VscodeButton,
	VscodeCheckbox,
	VscodeFormGroup,
	VscodeFormHelper,
	VscodeIcon,
	VscodeLabel,
	VscodeOption,
	VscodeSingleSelect,
	VscodeTextarea,
	VscodeTextfield,
} from '@vscode-elements/react-elements';
import {
	CLUSTER_TYPES,
	DEFAULT_GAV,
	formatCommandLine,
	formatEnvironment,
	getAction,
	KaotoRunConfiguration,
	LOGGING_LEVELS,
	parseCommandLine,
	parseEnvironment,
	parseList,
	RunConfigurationAction,
	RunConfigurationExecutor,
	ExportRuntime,
} from '../../run-configurations/RunConfigurationModel';
import { BrowseField, Problem, RunConfigurationsState } from '../../run-configurations/RunConfigurationProtocol';
import { ACTIONS, ConfigurationItem, EXECUTORS, getArgumentDefaults, RUNTIMES } from './configurations';

interface ConfigurationFormProps {
	state: RunConfigurationsState;
	item: ConfigurationItem;
	nameProblem?: string;
	problems: Problem[];
	onChange: (configuration: KaotoRunConfiguration) => void;
	onBrowse: (field: BrowseField) => void;
}

type TextEvent = { target: EventTarget | null };

function valueOf(event: TextEvent): string {
	return (event.target as HTMLInputElement).value;
}

function checkedOf(event: TextEvent): boolean {
	return (event.target as HTMLInputElement).checked;
}

function Field({ label, description, problems, children }: { label: string; description?: ReactNode; problems?: Problem[]; children: ReactNode }) {
	return (
		<VscodeFormGroup variant="settings-group">
			<VscodeLabel>{label}</VscodeLabel>
			{description && <VscodeFormHelper>{description}</VscodeFormHelper>}
			<div className="field-control">{children}</div>
			{problems?.map((problem) => (
				<div key={problem.message} className={`field-problem ${problem.severity}`}>
					<VscodeIcon name={problem.severity} />
					{problem.message}
				</div>
			))}
		</VscodeFormGroup>
	);
}

/**
 * A text field holding a list, a command line or variables: it keeps the typed text and reports the parsed value.
 * The text is replaced only when the value changes from outside, for example by Browse.
 */
function ParsedTextField<T>({
	value,
	format,
	parse,
	placeholder,
	multiline,
	onChange,
}: {
	value: T;
	format: (value: T) => string;
	parse: (text: string) => T;
	placeholder?: string;
	multiline?: boolean;
	onChange: (value: T) => void;
}) {
	const formatted = format(value);
	const [text, setText] = useState(formatted);
	const [lastFormatted, setLastFormatted] = useState(formatted);
	if (formatted !== lastFormatted) {
		setLastFormatted(formatted);
		if (format(parse(text)) !== formatted) {
			setText(formatted);
		}
	}
	const onInput = (event: TextEvent) => {
		setText(valueOf(event));
		onChange(parse(valueOf(event)));
	};
	return multiline ? (
		<VscodeTextarea rows={3} monospace value={text} placeholder={placeholder} onInput={onInput} />
	) : (
		<VscodeTextfield value={text} placeholder={placeholder} onInput={onInput} />
	);
}

export function ConfigurationForm({ state, item, nameProblem, problems, onChange, onBrowse }: ConfigurationFormProps) {
	const configuration = item.draft;
	const action = getAction(configuration);
	const defaults = getArgumentDefaults(state, configuration);
	const executor = configuration.executor ?? state.defaults.executor;
	const folder = state.folders.find((candidate) => candidate.uri === item.folder);
	const fieldProblems = (field: string) => problems.filter((problem) => problem.field === field);
	const update = (changes: Partial<KaotoRunConfiguration>) => onChange({ ...configuration, ...changes });

	const targets = folder?.targets ?? [];
	const targetOptions = [
		{ value: '${file}', label: 'Current Camel file (${file})' },
		...targets.map((target) => ({ value: target.value, label: target.label })),
	];
	if (configuration.target && !targetOptions.some((option) => option.value === configuration.target)) {
		targetOptions.unshift({ value: configuration.target, label: configuration.target });
	}

	return (
		<div className="form">
			<h1>{configuration.name || 'Unnamed configuration'}</h1>
			<p className="subtitle">
				{item.saved ? 'Saved in ' : 'Not saved yet. Save adds it to '}
				<code>.vscode/launch.json</code>
				{state.folders.length > 1 && folder ? ` of ${folder.name}` : ''}.{' '}
				{executor === 'kompanion'
					? 'It is listed in Run and Debug, which cannot start it yet.'
					: action === 'run' && configuration.debugRoutes
						? 'In Run and Debug, Ctrl+F5 runs it and F5 debugs its routes.'
						: 'In Run and Debug, F5 or Ctrl+F5 starts it.'}
			</p>

			<h2>General</h2>
			<Field
				label="Name"
				description="Shown in this list, in Run and Debug and as the debug session name."
				problems={nameProblem ? [{ severity: 'error', message: nameProblem }] : []}
			>
				<VscodeTextfield value={configuration.name} onInput={(event) => update({ name: valueOf(event) })} />
			</Field>
			<Field label="Action" description="Run starts the integration locally, Export creates a Maven project, Deploy runs it on Kubernetes or OpenShift.">
				<VscodeSingleSelect value={action} onChange={(event) => update({ action: valueOf(event) as RunConfigurationAction })}>
					{ACTIONS.map((candidate) => (
						<VscodeOption key={candidate.value} value={candidate.value}>
							{candidate.label}
						</VscodeOption>
					))}
				</VscodeSingleSelect>
			</Field>
			{state.folders.length > 1 && (
				<Field label="Workspace folder" description="The launch.json this configuration is saved in.">
					<VscodeSingleSelect value={item.folder} disabled={!!item.saved}>
						{state.folders.map((candidate) => (
							<VscodeOption key={candidate.uri} value={candidate.uri}>
								{candidate.name}
							</VscodeOption>
						))}
					</VscodeSingleSelect>
				</Field>
			)}
			<Field
				label="Target"
				description={action === 'deploy' ? 'The Camel file to deploy.' : 'A Camel file, or a folder to run or export all of its Camel files.'}
				problems={fieldProblems('target')}
			>
				<div className="with-button">
					<VscodeSingleSelect combobox value={configuration.target ?? '${file}'} onChange={(event) => update({ target: valueOf(event) })}>
						{targetOptions.map((option) => (
							<VscodeOption key={option.value} value={option.value}>
								{option.label}
							</VscodeOption>
						))}
					</VscodeSingleSelect>
					<VscodeButton secondary onClick={() => onBrowse('target')}>
						Browse...
					</VscodeButton>
				</div>
			</Field>

			<h2>Executor</h2>
			<Field label="Executor" description="What runs the Camel command." problems={fieldProblems('executor')}>
				<VscodeSingleSelect value={executor} onChange={(event) => update({ executor: valueOf(event) as RunConfigurationExecutor })}>
					{EXECUTORS.map((candidate) => (
						<VscodeOption key={candidate.value} value={candidate.value} description={candidate.description}>
							{candidate.label}
						</VscodeOption>
					))}
				</VscodeSingleSelect>
			</Field>
			<Field label="Catalog" description="Runtime and Camel version, from the same list as the status bar picker." problems={fieldProblems('catalog')}>
				<VscodeSingleSelect combobox value={configuration.catalog ?? ''} onChange={(event) => update({ catalog: valueOf(event) || undefined })}>
					<VscodeOption value="">{`Status bar selection${state.defaults.catalog ? ` (${state.defaults.catalog})` : ''}`}</VscodeOption>
					{state.catalogs.map((catalog) => (
						<VscodeOption key={catalog.name} value={catalog.name} description={catalog.launcherAvailable ? '' : 'Camel CLI only'}>
							{catalog.name}
						</VscodeOption>
					))}
				</VscodeSingleSelect>
			</Field>

			{action === 'run' && (
				<>
					<h2>Run options</h2>
					<Field label="Dev mode" description="Passed as --dev.">
						<VscodeCheckbox checked={configuration.dev ?? defaults.dev ?? false} onChange={(event) => update({ dev: checkedOf(event) })}>
							Reload the routes when a source file changes
						</VscodeCheckbox>
					</Field>
					<Field
						label="Route debugger"
						description="Debug and F5 add --dep=org.apache.camel:camel-debug and attach the Debug Adapter for Apache Camel. Run and Ctrl+F5 do not."
					>
						<VscodeCheckbox
							checked={configuration.debugRoutes ?? false}
							onChange={(event) => update({ debugRoutes: checkedOf(event) || undefined })}
						>
							Stop at route breakpoints when started with Debug
						</VscodeCheckbox>
					</Field>
					<Field label="Logging level" description="Passed as --logging-level.">
						<VscodeSingleSelect
							value={configuration.loggingLevel ?? defaults.loggingLevel ?? 'info'}
							onChange={(event) => update({ loggingLevel: valueOf(event) })}
						>
							{LOGGING_LEVELS.map((level) => (
								<VscodeOption key={level} value={level}>
									{level}
								</VscodeOption>
							))}
						</VscodeSingleSelect>
					</Field>
					<Field
						label="Management port"
						description="Port of the Camel console that the Deployments view reads. Leave empty to pick a free port at each launch."
					>
						<VscodeTextfield
							type="number"
							value={configuration.managementPort?.toString() ?? ''}
							placeholder="Free port"
							onInput={(event) => {
								const port = Number.parseInt(valueOf(event), 10);
								update({ managementPort: Number.isNaN(port) ? undefined : port });
							}}
						/>
					</Field>
					<Field label="Properties files" description="Comma separated, passed as --properties.">
						<div className="with-button">
							<ParsedTextField
								value={configuration.propertiesFiles ?? []}
								format={(files) => files.join(', ')}
								parse={parseList}
								placeholder="application.properties"
								onChange={(files) => update({ propertiesFiles: files.length > 0 ? files : undefined })}
							/>
							<VscodeButton secondary onClick={() => onBrowse('propertiesFiles')}>
								Browse...
							</VscodeButton>
						</div>
					</Field>
					<Field label="Dependencies" description="Comma separated Maven coordinates or Camel component names, passed as --dep.">
						<ParsedTextField
							value={configuration.dependencies ?? []}
							format={(dependencies) => dependencies.join(', ')}
							parse={parseList}
							placeholder="camel-kafka, org.acme:beans:1.0"
							onChange={(dependencies) => update({ dependencies: dependencies.length > 0 ? dependencies : undefined })}
						/>
					</Field>
				</>
			)}

			{action === 'export' && (
				<>
					<h2>Export options</h2>
					<Field label="Runtime" description="Passed as --runtime." problems={fieldProblems('runtime')}>
						<VscodeSingleSelect
							value={configuration.runtime ?? 'quarkus'}
							onChange={(event) => update({ runtime: valueOf(event) as ExportRuntime })}
						>
							{RUNTIMES.map((runtime) => (
								<VscodeOption key={runtime.value} value={runtime.value}>
									{runtime.label}
								</VscodeOption>
							))}
						</VscodeSingleSelect>
					</Field>
					<Field
						label="Maven coordinates"
						description="groupId:artifactId:version of the new project, passed as --gav."
						problems={fieldProblems('gav')}
					>
						<VscodeTextfield
							value={configuration.gav ?? ''}
							placeholder={DEFAULT_GAV}
							onInput={(event) => update({ gav: valueOf(event) || undefined })}
						/>
					</Field>
					<Field
						label="Output directory"
						description="Where the Maven project is created, passed as --directory. Empty exports into the workspace folder."
						problems={fieldProblems('outputDirectory')}
					>
						<div className="with-button">
							<VscodeTextfield
								value={configuration.outputDirectory ?? ''}
								placeholder="${workspaceFolder}"
								onInput={(event) => update({ outputDirectory: valueOf(event) || undefined })}
							/>
							<VscodeButton secondary onClick={() => onBrowse('outputDirectory')}>
								Browse...
							</VscodeButton>
						</div>
					</Field>
					<Field label="Kubernetes resources">
						<VscodeCheckbox checked={configuration.kubernetes ?? true} onChange={(event) => update({ kubernetes: checkedOf(event) })}>
							Add Kubernetes or OpenShift resources (camel kubernetes export)
						</VscodeCheckbox>
					</Field>
					<Field label="Open the project">
						<VscodeCheckbox checked={configuration.openProject ?? true} onChange={(event) => update({ openProject: checkedOf(event) })}>
							Open the exported project in a new window
						</VscodeCheckbox>
					</Field>
				</>
			)}

			{(action === 'deploy' || (action === 'export' && (configuration.kubernetes ?? true))) && (
				<>
					{action === 'deploy' && <h2>Deploy options</h2>}
					<Field label="Cluster type" description="Passed as --cluster-type.">
						<VscodeSingleSelect
							value={configuration.clusterType ?? defaults.clusterType ?? 'openshift'}
							onChange={(event) => update({ clusterType: valueOf(event) })}
						>
							{CLUSTER_TYPES.map((clusterType) => (
								<VscodeOption key={clusterType} value={clusterType}>
									{clusterType}
								</VscodeOption>
							))}
						</VscodeSingleSelect>
					</Field>
				</>
			)}
			{action === 'deploy' && (
				<Field label="Dev mode" description="Passed as --dev.">
					<VscodeCheckbox checked={configuration.dev ?? defaults.dev ?? false} onChange={(event) => update({ dev: checkedOf(event) })}>
						Redeploy when a source file changes
					</VscodeCheckbox>
				</Field>
			)}

			<h2>Advanced</h2>
			{action !== 'deploy' && (
				<Field label="Local Kamelet directories" description="Comma separated, passed as --local-kamelet-dir.">
					<ParsedTextField
						value={configuration.localKameletDirectories ?? []}
						format={(directories) => directories.join(', ')}
						parse={parseList}
						placeholder={state.defaults.localKameletDirectories.join(', ') || 'none'}
						onChange={(directories) => update({ localKameletDirectories: directories.length > 0 ? directories : undefined })}
					/>
				</Field>
			)}
			<Field
				label="Extra arguments"
				description={<>Appended to the command unchanged. The settings default is {formatCommandLine(defaults.args) || 'empty'}.</>}
			>
				<ParsedTextField
					value={configuration.args ?? defaults.args}
					format={formatCommandLine}
					parse={parseCommandLine}
					onChange={(args) => update({ args })}
				/>
			</Field>
			<Field label="Environment variables" description="One KEY=value per line, set in the terminal of the task.">
				<ParsedTextField
					multiline
					value={configuration.env ?? {}}
					format={formatEnvironment}
					parse={parseEnvironment}
					placeholder="CAMEL_KAFKA_BROKERS=localhost:9092"
					onChange={(env) => update({ env: Object.keys(env).length > 0 ? env : undefined })}
				/>
			</Field>
		</div>
	);
}
