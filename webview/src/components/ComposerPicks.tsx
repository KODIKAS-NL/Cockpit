// Model, effort and permission mode in the prompt box, like the official panel: the choice is
// for the conversation being typed in (it is the one the chat shows), not a global dashboard
// setting. The lists and the host messages are the ones the dashboard controls already use.
import type { Translator } from '../i18n';
import type { SessionConfig } from '../../../shared/protocol';
import { EffortSelect, ModelSelect, permLabel } from './Controls';

interface Props {
  t: Translator;
  config?: SessionConfig;
  activeModel?: string;
  onModel: (model: string) => void;
  onRemoveModel: (model: string) => void;
  onEffort: (effort: string) => void;
  onPermission: (mode: string) => void;
}

export function ComposerPicks({ t, config, activeModel, onModel, onRemoveModel, onEffort, onPermission }: Props) {
  if (!config) return null;
  return (
    <div className="composer-picks">
      <ModelSelect
        t={t}
        compact
        value={config.model}
        models={config.models}
        meta={config.modelMeta}
        known={config.models.includes(config.model)}
        currentModel={config.model}
        defaultFor={config.defaultModel ?? activeModel}
        onSelect={onModel}
        onRemove={onRemoveModel}
      />
      <EffortSelect
        t={t}
        value={config.effort}
        efforts={config.efforts}
        defaultEffort={config.defaultEffort}
        onSelect={onEffort}
      />
      <select
        className="composer-pick-mode"
        title={t('controls.permission')}
        aria-label={t('controls.permission')}
        value={config.permissionMode}
        onChange={(e) => onPermission(e.target.value)}
      >
        {config.permissionModes.map((pm) => (
          <option key={pm} value={pm}>
            {permLabel(pm, t)}
          </option>
        ))}
      </select>
    </div>
  );
}
