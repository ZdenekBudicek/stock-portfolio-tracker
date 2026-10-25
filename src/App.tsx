import { lazy, Suspense, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, HashRouter, Route, Routes } from "react-router-dom";
import ScrollToTop from '@/components/ScrollToTop';
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CurrencyProvider } from "@/contexts/CurrencyContext";
import { AuthProvider } from "@/contexts/AuthContext";
import ProtectedRoute from "@/components/ProtectedRoute";
import "@/i18n";
import LanguageProvider from "@/i18n/LanguageProvider";
import AppShell from "@/components/shell/AppShell";
import { AssistantChatProvider } from "@/contexts/AssistantChatContext";
import { assistantConfig } from "@/lib/assistantTransport";
import Index from "./pages/Index.tsx";
import Auth from "./pages/Auth.tsx";

// The overview and sign-in load with the app; every other page is its own chunk (audit B15: one 3 MB entry).
const NotFound = lazy(() => import("./pages/NotFound.tsx"));
const StockDetail = lazy(() => import("./pages/StockDetail.tsx"));
const ResetPassword = lazy(() => import("./pages/ResetPassword.tsx"));
const Positions = lazy(() => import("./pages/Positions.tsx"));
const Returns = lazy(() => import("./pages/Returns.tsx"));
const History = lazy(() => import("./pages/History.tsx"));
const Dividends = lazy(() => import("./pages/Dividends.tsx"));
const Taxes = lazy(() => import("./pages/Taxes.tsx"));
const Alerts = lazy(() => import("./pages/Alerts.tsx"));
const Accounts = lazy(() => import("./pages/Accounts.tsx"));
const Settings = lazy(() => import("./pages/Settings.tsx"));

import { IS_DEMO } from "@/lib/demo";
import DemoBanner from "@/demo/DemoBanner";

const queryClient = new QueryClient();

// The demo build is static files under a sub-path (no server rewrites), so it routes by hash.
const Router = IS_DEMO ? HashRouter : BrowserRouter;

// The assistant mounts unless the build sets VITE_ASSISTANT_ENABLED=false; then nothing of it does.
const assistantEnabled = assistantConfig().enabled;
const AssistantGate = ({ children }: { children: ReactNode }) =>
  assistantEnabled ? <AssistantChatProvider>{children}</AssistantChatProvider> : <>{children}</>;

const App = () => (
  <QueryClientProvider client={queryClient}>
    <Router>
      <ScrollToTop />
      <AuthProvider>
        <CurrencyProvider>
          {/* Inside Auth/Currency: a language switch remounts the UI but keeps the session, currency and chat. */}
          <AssistantGate>
          <LanguageProvider>
          <TooltipProvider>
            <Toaster />
            <Sonner />
            {IS_DEMO && <DemoBanner />}
            <Suspense fallback={null}>
            <Routes>
              <Route path="/auth" element={<Auth />} />
              <Route path="/reset-password" element={<ResetPassword />} />
              <Route element={<ProtectedRoute><AppShell /></ProtectedRoute>}>
                <Route path="/" element={<Index />} />
                <Route path="/pozice" element={<Positions />} />
                <Route path="/vynosy" element={<Returns />} />
                <Route path="/vynosy/historie" element={<History />} />
                <Route path="/dividendy" element={<Dividends />} />
                <Route path="/dane" element={<Taxes />} />
                <Route path="/upozorneni" element={<Alerts />} />
                <Route path="/ucty" element={<Accounts />} />
                <Route path="/nastaveni" element={<Settings />} />
                <Route path="/stock/:ticker" element={<StockDetail />} />
              </Route>
              <Route path="*" element={<NotFound />} />
            </Routes>
            </Suspense>
          </TooltipProvider>
          </LanguageProvider>
          </AssistantGate>
        </CurrencyProvider>
      </AuthProvider>
    </Router>
  </QueryClientProvider>
);

export default App;
