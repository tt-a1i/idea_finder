import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { Layout } from "./components/Layout.js";
import { AgentConsolePage } from "./pages/AgentConsolePage.js";
import { BriefEditorPage } from "./pages/BriefEditorPage.js";
import { BriefListPage } from "./pages/BriefListPage.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { DecisionBoardPage } from "./pages/DecisionBoardPage.js";
import { MonitorPage } from "./pages/MonitorPage.js";
import { OpportunityLibraryPage } from "./pages/OpportunityLibraryPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { SignalInboxPage } from "./pages/SignalInboxPage.js";
import { ValidationPage } from "./pages/ValidationPage.js";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<DashboardPage />} />
          <Route path="briefs" element={<BriefListPage />} />
          <Route path="briefs/:slug" element={<BriefEditorPage />} />
          <Route path="inbox" element={<SignalInboxPage />} />
          <Route path="library" element={<OpportunityLibraryPage />} />
          <Route path="board" element={<DecisionBoardPage />} />
          <Route path="validation" element={<ValidationPage />} />
          <Route path="monitor" element={<MonitorPage />} />
          <Route path="agents" element={<AgentConsolePage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
