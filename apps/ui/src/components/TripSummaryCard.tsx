import type { TripDescriptor } from "../types";

type TripSummaryCardProps = {
  trip: TripDescriptor;
  selected?: boolean;
  onSelect?: (tripId: string) => void;
};

export function TripSummaryCard({ trip, selected = false, onSelect }: TripSummaryCardProps) {
  const breadcrumbCount = trip.breadcrumbs?.length ?? 0;

  return (
    <article
      className={selected ? "trip-card panel trip-card--selected" : "trip-card panel"}
      onClick={() => onSelect?.(trip.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect?.(trip.id);
        }
      }}
      role="button"
      tabIndex={0}
      style={{ cursor: onSelect ? "pointer" : "default" }}
    >
      <p className="panel__eyebrow">Trip summary</p>
      <h3>{trip.title}</h3>
      <p>{trip.detail}</p>
      <div className="trip-card__meta">
        <span>{trip.distanceNm.toFixed(2)} NM</span>
        <span>{breadcrumbCount} breadcrumbs</span>
      </div>
      {trip.breadcrumbs && trip.breadcrumbs.length > 0 ? (
        <div className="trip-card__breadcrumbs" aria-label="Breadcrumb preview">
          {trip.breadcrumbs.slice(0, 8).map((breadcrumb) => (
            <span
              key={`${trip.id}-${breadcrumb.time}`}
              className="trip-card__breadcrumb-dot"
              title={`${breadcrumb.latitude.toFixed(4)}, ${breadcrumb.longitude.toFixed(4)} | ${breadcrumb.speedKnots?.toFixed(1) ?? "--"} kt | ${breadcrumb.engineRpmTotal?.toFixed(0) ?? "--"} RPM`}
            />
          ))}
        </div>
      ) : null}
      <span className="trip-card__tag">{trip.tag}</span>
    </article>
  );
}
