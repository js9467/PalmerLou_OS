type OfflineStateProps = {
  message: string;
  onRetry?: () => void;
};

export function OfflineState({ message, onRetry }: OfflineStateProps) {
  return (
    <aside className="offline-state panel panel--alert" role="status">
      <div>
        <p className="panel__eyebrow">Offline mode</p>
        <h2>Local backend unavailable</h2>
        <p>{message}</p>
      </div>
      {onRetry ? (
        <button className="theme-toggle" type="button" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </aside>
  );
}
