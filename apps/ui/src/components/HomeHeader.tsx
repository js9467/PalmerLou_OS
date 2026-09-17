type HomeHeaderProps = {
  online: boolean;
  nowLabel: string;
  remoteMode?: boolean;
  qrImageSrc?: string;
  onKillApps?: () => void;
  killingApps?: boolean;
  killTargetName?: string;
  killTargetLogoPath?: string;
};

export function HomeHeader({ online, nowLabel, remoteMode, qrImageSrc, onKillApps, killingApps = false, killTargetName = "", killTargetLogoPath }: HomeHeaderProps) {
  const hasKillTarget = killTargetName.trim().length > 0 && Boolean(killTargetLogoPath);
  const showKill = hasKillTarget && Boolean(onKillApps);

  return (
    <header className="home-header">
      <div className="home-header__status">
        <span className={`home-header__dot ${online ? "home-header__dot--online" : "home-header__dot--offline"}`} aria-label={online ? "NMEA online" : "NMEA offline"} />
        <span className="home-header__time">{nowLabel}</span>
      </div>

      {showKill ? (
        <button
          className="kill-app-button kill-app-button--inline"
          type="button"
          onClick={onKillApps}
          disabled={killingApps}
          aria-label={killingApps ? `Killing ${killTargetName}` : `Close ${killTargetName}`}
        >
          <span className="kill-app-button__logo-wrap" aria-hidden="true">
            <img className="kill-app-button__logo" src={killTargetLogoPath} alt="" />
            <span className="kill-app-button__x" />
          </span>
          <span className="kill-app-button__name">{killTargetName}</span>
        </button>
      ) : null}

      {!remoteMode && qrImageSrc ? (
        <div className="header-qr" aria-label="Scan to open remote" role="img">
          <img src={qrImageSrc} alt="QR code for Palmer Lou remote" />
          <span className="header-qr__label">Remote</span>
        </div>
      ) : null}
    </header>
  );
}
