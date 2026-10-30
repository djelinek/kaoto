import { useEffect, useReducer, useRef, useState } from 'react';
import { VscodeButton, VscodeIcon, VscodeToolbarButton, VscodeToolbarContainer } from '@vscode-elements/react-elements';
import { getAction, KaotoRunConfiguration } from '../../run-configurations/RunConfigurationModel';
import {
	ExtensionMessage,
	NewConfigurationRequest,
	PreviewResult,
	Problem,
	RunConfigurationsState,
	SaveRequest,
} from '../../run-configurations/RunConfigurationProtocol';
import { ACTIONS, cleanConfiguration, ConfigurationItem, createConfiguration, isDirty, mergeItems, savedKey, uniqueName } from './configurations';
import { ConfigurationForm } from './ConfigurationForm';
import { ConfigurationList } from './ConfigurationList';
import { postMessage } from './vscodeApi';

interface AppState {
	state?: RunConfigurationsState;
	items: ConfigurationItem[];
	selectedKey?: string;
	/** Key to select as soon as the saved configuration shows up in a state */
	pendingKey?: string;
	newCounter: number;
}

type AppAction =
	| { type: 'state'; state: RunConfigurationsState }
	| { type: 'select'; key: string }
	| { type: 'create'; request: NewConfigurationRequest; source?: KaotoRunConfiguration }
	| { type: 'update'; key: string; configuration: KaotoRunConfiguration }
	| { type: 'revert'; key: string }
	| { type: 'remove'; key: string }
	| { type: 'saved'; key: string; folder: string; name: string };

function selectExisting(items: ConfigurationItem[], ...keys: (string | undefined)[]): string | undefined {
	return keys.find((key) => key && items.some((item) => item.key === key)) ?? items[0]?.key;
}

function reducer(app: AppState, action: AppAction): AppState {
	switch (action.type) {
		case 'state': {
			const items = mergeItems(action.state, app.items);
			const pendingFound = app.pendingKey && items.some((item) => item.key === app.pendingKey);
			return {
				...app,
				state: action.state,
				items,
				selectedKey: selectExisting(items, app.pendingKey, app.selectedKey),
				pendingKey: pendingFound ? undefined : app.pendingKey,
			};
		}
		case 'select':
			return { ...app, selectedKey: action.key };
		case 'create': {
			if (!app.state) {
				return app;
			}
			const takenNames = app.items.filter((item) => item.folder === action.request.folder).map((item) => item.draft.name);
			const draft = action.source
				? { ...action.source, name: uniqueName(`${action.source.name} (copy)`, takenNames) }
				: createConfiguration(app.state, action.request, takenNames);
			const key = `new:${app.newCounter}`;
			return {
				...app,
				items: [...app.items, { key, folder: action.request.folder, draft, running: false }],
				selectedKey: key,
				newCounter: app.newCounter + 1,
			};
		}
		case 'update':
			return { ...app, items: app.items.map((item) => (item.key === action.key ? { ...item, draft: action.configuration } : item)) };
		case 'revert':
			return {
				...app,
				items: app.items.flatMap((item) => {
					if (item.key !== action.key) {
						return [item];
					}
					return item.saved ? [{ ...item, draft: item.saved }] : [];
				}),
			};
		case 'remove': {
			const items = app.items.filter((item) => item.key !== action.key);
			return { ...app, items, selectedKey: selectExisting(items, app.selectedKey) };
		}
		case 'saved': {
			// a saved new configuration is now a launch.json entry: drop the draft and select the entry
			const items = app.items.filter((item) => item.key !== action.key || item.saved);
			const key = savedKey(action.folder, action.name);
			const found = items.some((item) => item.key === key);
			return { ...app, items, selectedKey: found ? key : app.selectedKey, pendingKey: found ? undefined : key };
		}
	}
}

function validateName(items: ConfigurationItem[], item: ConfigurationItem): string | undefined {
	const name = item.draft.name.trim();
	if (!name) {
		return 'Enter a name.';
	}
	if (items.some((other) => other.key !== item.key && other.folder === item.folder && other.draft.name.trim() === name)) {
		return 'Another configuration of this workspace folder has this name.';
	}
	return undefined;
}

function ProblemList({ problems }: { problems: Problem[] }) {
	if (problems.length === 0) {
		return null;
	}
	return (
		<ul className="problems">
			{problems.map((problem) => (
				<li key={problem.message} className={problem.severity}>
					<VscodeIcon name={problem.severity} />
					<span>{problem.message}</span>
				</li>
			))}
		</ul>
	);
}

export function RunConfigurationsApp() {
	const [app, dispatch] = useReducer(reducer, { items: [], newCounter: 1 });
	const [preview, setPreview] = useState<PreviewResult>();
	const [copied, setCopied] = useState(false);
	const latestRequest = useRef(0);
	const savingKey = useRef<string | undefined>(undefined);
	const { state, items } = app;
	const selected = items.find((item) => item.key === app.selectedKey);

	useEffect(() => {
		const onMessage = (event: MessageEvent<ExtensionMessage>) => {
			const message = event.data;
			switch (message.type) {
				case 'state':
					dispatch({ type: 'state', state: message.state });
					break;
				case 'select':
					dispatch({ type: 'select', key: savedKey(message.folder, message.name) });
					break;
				case 'create':
					dispatch({ type: 'create', request: message.request });
					break;
				case 'preview':
					if (message.result.requestId === latestRequest.current) {
						setPreview(message.result);
					}
					break;
				case 'browsed':
					window.dispatchEvent(new CustomEvent('kaoto-browsed', { detail: message }));
					break;
				case 'saved':
					dispatch({ type: 'saved', key: savingKey.current ?? '', folder: message.folder, name: message.name });
					break;
			}
		};
		window.addEventListener('message', onMessage);
		postMessage({ type: 'ready' });
		return () => window.removeEventListener('message', onMessage);
	}, []);

	// Recompute the command preview a moment after the last change
	const draftJson = selected ? JSON.stringify(selected.draft) : '';
	useEffect(() => {
		if (!selected) {
			setPreview(undefined);
			return;
		}
		const timer = setTimeout(() => {
			latestRequest.current += 1;
			postMessage({ type: 'preview', requestId: latestRequest.current, folder: selected.folder, configuration: cleanConfiguration(selected.draft) });
		}, 200);
		return () => clearTimeout(timer);
	}, [selected?.key, draftJson, state]);

	// Browse results land in the field of the selected configuration
	useEffect(() => {
		const onBrowsed = (event: Event) => {
			const { field, values } = (event as CustomEvent<{ field: string; values: string[] }>).detail;
			if (!selected || values.length === 0) {
				return;
			}
			const changes: Partial<KaotoRunConfiguration> =
				field === 'propertiesFiles' || field === 'localKameletDirectories'
					? { [field]: [...((selected.draft[field] as string[] | undefined) ?? []), ...values] }
					: { [field]: values[0] };
			dispatch({ type: 'update', key: selected.key, configuration: { ...selected.draft, ...changes } });
		};
		window.addEventListener('kaoto-browsed', onBrowsed);
		return () => window.removeEventListener('kaoto-browsed', onBrowsed);
	}, [selected]);

	if (!state) {
		return <div className="loading">Loading run configurations...</div>;
	}

	const firstFolder = state.folders[0];
	const addConfiguration = () => {
		if (!firstFolder) {
			return;
		}
		const folder = selected?.folder ?? firstFolder.uri;
		const targets = state.folders.find((candidate) => candidate.uri === folder)?.targets ?? [];
		const firstFile = targets.find((target) => target.kind === 'file');
		dispatch({ type: 'create', request: { folder, target: firstFile?.value ?? '${workspaceFolder}', isFolder: !firstFile } });
	};

	const toSaveRequest = (item: ConfigurationItem): SaveRequest => ({
		folder: item.folder,
		original: item.original,
		configuration: cleanConfiguration(item.draft),
	});
	const save = (item: ConfigurationItem) => {
		savingKey.current = item.key;
		postMessage({ type: 'save', ...toSaveRequest(item) });
	};
	const launch = (item: ConfigurationItem, noDebug: boolean) => {
		const dirty = isDirty(item);
		if (dirty) {
			savingKey.current = item.key;
		}
		postMessage({ type: 'launch', noDebug, save: dirty, ...toSaveRequest(item) });
	};
	const remove = (item: ConfigurationItem) => {
		if (item.saved && item.original) {
			postMessage({ type: 'delete', folder: item.folder, index: item.original.index, name: item.original.name });
		} else {
			dispatch({ type: 'remove', key: item.key });
		}
	};
	const copy = (text: string) => {
		postMessage({ type: 'copy', text });
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	};

	const nameProblem = selected ? validateName(items, selected) : undefined;
	const problems = preview && selected && preview.requestId === latestRequest.current ? preview.problems : [];
	const hasErrors = !!nameProblem || problems.some((problem) => problem.severity === 'error');
	const executor = selected?.draft.executor ?? state.defaults.executor;
	const canLaunch = !!selected && !hasErrors && executor !== 'kompanion';
	const action = ACTIONS.find((candidate) => candidate.value === (selected ? getAction(selected.draft) : 'run')) ?? ACTIONS[0];
	const debugRoutes = action.value === 'run' && selected?.draft.debugRoutes === true;
	// field problems show under their field, the footer only points at them when they block the launch
	const generalProblems: Problem[] = problems.filter((problem) => !problem.field);
	if (problems.some((problem) => problem.field && problem.severity === 'error')) {
		generalProblems.push({ severity: 'error', message: `Fix the fields marked above to ${action.verb.toLowerCase()} this configuration.` });
	}

	return (
		<div className="app">
			<aside className="sidebar">
				<div className="sidebar-header">
					<span>Run Configurations</span>
					<VscodeToolbarContainer>
						<VscodeToolbarButton icon="add" label="Add Configuration" title="Add Configuration" onClick={addConfiguration} />
						<VscodeToolbarButton
							icon="copy"
							label="Duplicate"
							title="Duplicate"
							className={selected ? undefined : 'disabled'}
							onClick={() =>
								selected &&
								dispatch({ type: 'create', request: { folder: selected.folder, target: '', isFolder: false }, source: selected.draft })
							}
						/>
						<VscodeToolbarButton
							icon="trash"
							label="Delete"
							title="Delete"
							className={selected ? undefined : 'disabled'}
							onClick={() => selected && remove(selected)}
						/>
						<VscodeToolbarButton
							icon="json"
							label="Open launch.json"
							title="Open launch.json"
							className={firstFolder ? undefined : 'disabled'}
							onClick={() => postMessage({ type: 'openLaunchJson', folder: selected?.folder ?? firstFolder.uri })}
						/>
					</VscodeToolbarContainer>
				</div>
				<div className="sidebar-list">
					{items.length > 0 ? (
						<ConfigurationList
							items={items}
							folders={state.folders}
							selectedKey={app.selectedKey}
							onSelect={(key) => dispatch({ type: 'select', key })}
						/>
					) : (
						<div className="empty">
							<p>No Kaoto run configurations yet.</p>
							<p>They are saved in .vscode/launch.json, so they also appear in Run and Debug.</p>
							<VscodeButton icon="add" onClick={addConfiguration} disabled={!firstFolder}>
								Add Configuration
							</VscodeButton>
						</div>
					)}
				</div>
			</aside>

			<main className="content">
				{selected ? (
					<>
						<ConfigurationForm
							key={selected.key}
							state={state}
							item={selected}
							nameProblem={nameProblem}
							problems={problems}
							onChange={(configuration) => dispatch({ type: 'update', key: selected.key, configuration })}
							onBrowse={(field) => postMessage({ type: 'browse', field, folder: selected.folder })}
						/>
						<footer className="footer">
							<div className="preview-header">
								<span className="preview-title">{preview?.kompanionRequest ? 'Kaoto Kompanion request: POST /v1/executions' : 'Command'}</span>
								{preview?.cwd && !preview.kompanionRequest && <span className="preview-cwd">in {preview.cwd}</span>}
								<VscodeToolbarButton
									icon={copied ? 'check' : 'copy'}
									label="Copy"
									title="Copy"
									className={preview?.commandLine || preview?.kompanionRequest ? undefined : 'disabled'}
									onClick={() => copy(preview?.kompanionRequest ?? preview?.commandLine ?? '')}
								/>
							</div>
							<pre className={`command ${preview?.kompanionRequest ? 'request' : ''}`}>
								{preview?.kompanionRequest ?? (preview?.commandLine ? `$ ${preview.commandLine}` : ' ')}
							</pre>
							{preview?.env && Object.keys(preview.env).length > 0 && (
								<div className="preview-env">
									Environment:{' '}
									{Object.entries(preview.env)
										.map(([key, value]) => `${key}=${value}`)
										.join(' ')}
								</div>
							)}
							<ProblemList problems={generalProblems} />
							<div className="actions">
								<VscodeButton icon={action.icon} disabled={!canLaunch} onClick={() => launch(selected, true)}>
									{action.verb}
								</VscodeButton>
								{debugRoutes && (
									<VscodeButton
										icon="debug-alt"
										secondary
										disabled={!canLaunch}
										title={state.camelDebuggerInstalled ? 'Run with the Camel route debugger' : 'Needs the Debug Adapter for Apache Camel'}
										onClick={() => launch(selected, false)}
									>
										Debug
									</VscodeButton>
								)}
								<span className="spacer" />
								<VscodeButton secondary disabled={!isDirty(selected) || !!nameProblem} onClick={() => save(selected)}>
									Save
								</VscodeButton>
								<VscodeButton secondary disabled={!isDirty(selected)} onClick={() => dispatch({ type: 'revert', key: selected.key })}>
									{selected.saved ? 'Revert' : 'Discard'}
								</VscodeButton>
							</div>
							{debugRoutes && !state.camelDebuggerInstalled && (
								<div className="hint">
									Debug stops at route breakpoints with the{' '}
									<a href="#" onClick={() => postMessage({ type: 'installCamelDebugger' })}>
										Debug Adapter for Apache Camel
									</a>
									.
								</div>
							)}
						</footer>
					</>
				) : (
					<div className="empty-content">Select or add a run configuration.</div>
				)}
			</main>
		</div>
	);
}
