import { ObsidianIcon } from '../primitives/obsidian-icon';

export function AnnotationGroupHeader({
  count,
  kind,
  title,
}: {
  readonly count: number;
  readonly kind: 'heading' | 'ink' | 'problems';
  readonly title: string;
}) {
  return (
    <h3 data-count={count} data-inkstone-group-title="">
      <ObsidianIcon
        icon={kind === 'problems' ? 'triangle-alert' : kind === 'ink' ? 'waves' : 'file-text'}
      />
      <span>{title}</span>
    </h3>
  );
}
