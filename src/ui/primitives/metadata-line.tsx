import type { MetadataToken } from '../models/annotation-list-item-model';

export function MetadataLine({
  className,
  tokens,
}: {
  readonly className?: string;
  readonly tokens: readonly MetadataToken[];
}) {
  const label = tokens.map((token) => token.label).join(' · ');
  return (
    <span
      aria-label={label}
      className={`inkstone-metadata-line${className === undefined ? '' : ` ${className}`}`}
      title={label}
    >
      {tokens.map((token, index) => (
        <span
          aria-hidden="true"
          className={[
            'inkstone-metadata-line__token',
            token.tone === 'warning' ? 'inkstone-metadata-line__token--warning' : '',
          ]
            .filter((className) => className.length > 0)
            .join(' ')}
          key={`${token.kind}:${token.label}:${index}`}
        >
          {token.label}
        </span>
      ))}
    </span>
  );
}
