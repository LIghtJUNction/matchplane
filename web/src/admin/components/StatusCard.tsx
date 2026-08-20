type StatusCardProps = {
  title: string;
  value: string;
  description?: string;
};

export default function StatusCard({ title, value, description }: StatusCardProps) {
  return (
    <article className="status-card">
      <small>{title}</small>
      <strong>{value}</strong>
      {description && <span>{description}</span>}
    </article>
  );
}
