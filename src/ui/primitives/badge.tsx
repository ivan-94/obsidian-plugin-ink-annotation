export function Badge({
  label,
  tone = 'default',
  value,
}: {
  readonly label: string;
  readonly tone?: 'default' | 'warning';
  readonly value: number | string;
}) {
  return (
    <span
      aria-label={`${String(value)} ${label}`}
      className={`inkstone-badge inkstone-badge--${tone}`}
    >
      {value}
    </span>
  );
}
