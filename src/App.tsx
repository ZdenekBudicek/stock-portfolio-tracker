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
import Index from "./pages/Index.tsx";
import NotFound from "./pages/NotFound.tsx";
import StockDetail from "./pages/StockDetail.tsx";
import Auth from "./pages/Auth.tsx";
import ResetPassword from "./pages/ResetPassword.tsx";
import Positions from "./pages/Positions.tsx";
import Returns from "./pages/Returns.tsx";
import History from "./pages/History.tsx";
import Dividends from "./pages/Dividends.tsx";
import Taxes from "./pages/Taxes.tsx";
import Alerts from "./pages/Alerts.tsx";
import Accounts from "./pages/Accounts.tsx";
import Settings from "./pages/Settings.tsx";

import { IS_DEMO } from "@/lib/demo";
import DemoBanner from "@/demo/DemoBanner";

const queryClient = new QueryClient();
const Router = IS_DEMO ? HashRouter : BrowserRouter;

const App = () => (
  <QueryClientProvider client={queryClient}>
    <Router>
      <ScrollToTop />
      <AuthProvider>
        <CurrencyProvider>
          {/* Inside Auth/Currency: a language switch remounts the UI but keeps the session and currency. */}
          <LanguageProvider>
          <TooltipProvider>
            <Toaster />
            <Sonner />
            {IS_DEMO && <DemoBanner />}
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
          </TooltipProvider>
          </LanguageProvider>
        </CurrencyProvider>
      </AuthProvider>
    </Router>
  </QueryClientProvider>
);

export default App;
