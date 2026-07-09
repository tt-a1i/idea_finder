import "../styles/app.css";

import { NavLink, Outlet } from "react-router-dom";

const nav: ReadonlyArray<{ to: string; label: string; end?: boolean }> = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/briefs", label: "Briefs" },
  { to: "/inbox", label: "Signal Inbox" },
  { to: "/library", label: "Opportunity Library" },
  { to: "/board", label: "Decision Board" },
  { to: "/validation", label: "Validation" },
  { to: "/monitor", label: "Monitor" },
  { to: "/agents", label: "Agent Console" },
  { to: "/settings", label: "Settings" },
];

export function Layout() {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <header className="brand">
          <div className="brand-title">idea_finder</div>
          <div className="brand-sub">local demand workspace</div>
        </header>
        <nav className="nav">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
