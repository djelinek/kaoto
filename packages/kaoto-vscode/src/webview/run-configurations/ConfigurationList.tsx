import { VscodeBadge, VscodeIcon, VscodeTree, VscodeTreeItem } from '@vscode-elements/react-elements';
import { getAction } from '../../run-configurations/RunConfigurationModel';
import { WorkspaceFolderInfo } from '../../run-configurations/RunConfigurationProtocol';
import { ACTIONS, ConfigurationItem, isDirty } from './configurations';

interface ConfigurationListProps {
	items: ConfigurationItem[];
	folders: WorkspaceFolderInfo[];
	selectedKey?: string;
	onSelect: (key: string) => void;
}

type TreeSelectEvent = { detail: HTMLElement[] | { selectedItems: HTMLElement[] } };

/**
 * Configurations of every workspace folder, grouped by action
 */
export function ConfigurationList({ items, folders, selectedKey, onSelect }: ConfigurationListProps) {
	const folderName = (uri: string) => folders.find((folder) => folder.uri === uri)?.name;
	const onTreeSelect = (event: TreeSelectEvent) => {
		const selected = Array.isArray(event.detail) ? event.detail : event.detail.selectedItems;
		const key = selected[0]?.dataset.key;
		if (key) {
			onSelect(key);
		}
	};

	return (
		<VscodeTree indentGuides="none" onVscTreeSelect={onTreeSelect as never}>
			{ACTIONS.map((action) => {
				const group = items.filter((item) => getAction(item.draft) === action.value);
				if (group.length === 0) {
					return null;
				}
				return (
					<VscodeTreeItem key={action.value} open>
						{action.label}
						<VscodeBadge slot="decoration" variant="counter">
							{group.length}
						</VscodeBadge>
						{group.map((item) => (
							<VscodeTreeItem key={item.key} data-key={item.key} selected={item.key === selectedKey}>
								<VscodeIcon slot="icon-leaf" name={action.icon} />
								<span>{item.draft.name || 'Unnamed configuration'}</span>
								{folders.length > 1 && <span slot="description">{folderName(item.folder)}</span>}
								{item.running && <VscodeIcon slot="decoration" name="debug-start" label="Running" title="Running" className="running-icon" />}
								{isDirty(item) && (
									<span slot="decoration" className="unsaved-dot" title={item.saved ? 'Unsaved changes' : 'Not saved yet'}>
										●
									</span>
								)}
							</VscodeTreeItem>
						))}
					</VscodeTreeItem>
				);
			})}
		</VscodeTree>
	);
}
