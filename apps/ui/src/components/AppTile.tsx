import type { AppDescriptor } from "../types";

type AppTileProps = {
  app: AppDescriptor;
  active: boolean;
  onSelect: (app: AppDescriptor) => void;
};

export function AppTile({ app, active, onSelect }: AppTileProps) {
  return (
    <button className={active ? "app-tile app-tile--active" : "app-tile"} type="button" onClick={() => onSelect(app)}>
      <span className="app-tile__eyebrow">{app.launchMethod}</span>
      <span className="app-tile__name">{app.name}</span>
      <span className="app-tile__subtitle">{app.subtitle}</span>
      <span className="app-tile__footer">{app.status}</span>
    </button>
  );
}
