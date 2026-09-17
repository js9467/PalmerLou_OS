import { useState } from "react";
import type { DashboardSummary } from "../types";

type CameraPanelProps = {
  camera: DashboardSummary["camera"];
};

export function CameraPanel({ camera }: CameraPanelProps) {
  const [fullscreen, setFullscreen] = useState(false);

  if (fullscreen) {
    return (
      <div className="camera-fullscreen">
        <img src="/api/camera/stream" className="camera-fullscreen__img" alt="Live HDMI feed"
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
        <button className="camera-fullscreen__exit" type="button" onClick={() => setFullscreen(false)}
          aria-label="Exit fullscreen">
          ✕
        </button>
      </div>
    );
  }

  return (
    <section className="camera-panel panel">
      <div className="panel__header">
        <div>
          <p className="panel__eyebrow">HDMI capture</p>
          <h2>Night Vision</h2>
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <span className={camera.recording ? "status-pill status-pill--success" : "status-pill status-pill--warning"}>
            {camera.recording ? "Recording" : "Live"}
          </span>
          <button className="camera-fullscreen-btn" type="button" onClick={() => setFullscreen(true)}
            aria-label="Enter fullscreen">⛶</button>
        </div>
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
