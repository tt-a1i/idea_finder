export function MonitorPage() {
  return (
    <div>
      <header className="page-header">
        <div>
          <h1 className="page-title">Monitor</h1>
          <p className="muted">Placeholder — ongoing signal watchlists.</p>
        </div>
      </header>
      <div className="placeholder-box panel">
        <p>
          Monitor mode will schedule recurring harvest runs and surface drift in demand signals.
        </p>
        <ul>
          <li>Watchlist per brief / opportunity cluster</li>
          <li>Alert on new corroborating or disconfirming signals</li>
          <li>Run health and connector status</li>
        </ul>
      </div>
    </div>
  );
}
