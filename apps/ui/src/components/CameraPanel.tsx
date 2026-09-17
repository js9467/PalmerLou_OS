import type { DashboardSummary } from "../types";

type CameraPanelProps = {
  camera: DashboardSummary["camera"];
};

export function CameraPanel({ camera }: CameraPanelProps) {
  return (
    <section className="camera-panel panel">
      <div className="panel__header">
        <div>
          <p className="panel__eyebrow">HDMI capture</p>
          <h2>Night Vision</h2>
        </div>
        <span className={camera.recording ? "status-pill status-pill--success" : "status-pill status-pill--warning"}>
          {camera.recording ? "Recording" : "Live"}
        </span>
      </div>
      <div className="camera-panel__frame">
        <img
          src="/api/camera/stream"
          className="camera-panel__live"
          alt="Live HDMI feed"
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
        />
      </div>
    </section>
  );
}
