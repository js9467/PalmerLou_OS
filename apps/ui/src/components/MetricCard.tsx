import type { MetricDescriptor } from "../types";

type MetricCardProps = {
  metric: MetricDescriptor;
};

export function MetricCard({ metric }: MetricCardProps) {
  return (
    <article className={`metric-card metric-card--${metric.accent}`}>
      <span className="metric-card__label">{metric.label}</span>
      <div className="metric-card__value-row">
        <span className="metric-card__value">{metric.value}</span>
        <span className="metric-card__unit">{metric.unit}</span>
      </div>
    </article>
  );
}
