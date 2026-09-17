import { BrandMark } from "./BrandMark";
import { LoadingIndicator } from "./LoadingIndicator";

type BootSplashProps = {
  visible: boolean;
};

export function BootSplash({ visible }: BootSplashProps) {
  if (!visible) {
    return null;
  }

  return (
    <div className="boot-splash" role="status" aria-live="polite">
      <div className="boot-splash__halo" />
      <div className="boot-splash__card">
        <BrandMark subtitle="Vessel control interface" />
        <p className="boot-splash__text">Loading vessel dashboard, camera, and local services.</p>
        <LoadingIndicator />
      </div>
    </div>
  );
}
