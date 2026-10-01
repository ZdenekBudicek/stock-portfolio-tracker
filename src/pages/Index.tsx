import { useState } from 'react';
import PortfolioHeader from '@/components/PortfolioHeader';
import HoldingsTable from '@/components/HoldingsTable';
import AllocationChart from '@/components/AllocationChart';
import PerformanceChart from '@/components/PerformanceChart';
import ProfitByStock from '@/components/ProfitByStock';
import DailyChangeChart from '@/components/DailyChangeChart';
import TransactionHistory from '@/components/TransactionHistory';
import YearlyGrowth from '@/components/YearlyGrowth';
import PortfolioPerformanceChart from '@/components/PortfolioPerformanceChart';
import MarketTicker from '@/components/MarketTicker';
import TopMovers from '@/components/TopMovers';
import PortfolioMetrics from '@/components/PortfolioMetrics';
import PortfolioHeatmap from '@/components/PortfolioHeatmap';
import SectorAllocation from '@/components/SectorAllocation';
import TaxReport from '@/components/TaxReport';
import DividendTracker from '@/components/DividendTracker';
import EarningsCalendar from '@/components/EarningsCalendar';
import Watchlist from '@/components/Watchlist';
import StatementImport from '@/components/StatementImport';
import BrokerConnect from '@/components/BrokerConnect';
import PortfolioGoal from '@/components/PortfolioGoal';
import FearGreedIndex from '@/components/FearGreedIndex';
import MonthComparison from '@/components/MonthComparison';
import QuickTradeDialog from '@/components/QuickTradeDialog';
import RankedPositions from '@/components/RankedPositions';
import ClosedPositions from '@/components/ClosedPositions';
import DailyPortfolioLog from '@/components/DailyPortfolioLog';
import { usePositions } from '@/hooks/usePortfolio';
import { useAuth } from '@/contexts/AuthContext';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { TrendingUp, LogOut } from 'lucide-react';

const TABS = [
  { key: 'prehled', label: 'Přehled' },
  { key: 'pozice', label: 'Pozice' },
  { key: 'historie', label: 'Historie' },
  { key: 'dane', label: 'Daně & dividendy' },
  { key: 'import', label: 'Import & účty' },
] as const;
type TabKey = typeof TABS[number]['key'];

// Full-page skeleton while the first positions query loads — mirrors the layout
// (header block, ticker strip, chart) instead of a flash of empty cards.
const PageSkeleton = () => (
  <div className="min-h-screen bg-background">
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6">
      <Skeleton className="h-72 w-full rounded-2xl" />
      <Skeleton className="h-12 w-full rounded-xl" />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Skeleton className="lg:col-span-2 h-96 rounded-2xl" />
        <div className="space-y-6">
          <Skeleton className="h-44 rounded-2xl" />
          <Skeleton className="h-44 rounded-2xl" />
        </div>
      </div>
      <Skeleton className="h-64 w-full rounded-2xl" />
    </div>
  </div>
);

const Index = () => {
  const { data: positions = [], isLoading } = usePositions();
  const { user, signOut } = useAuth();
  const [tab, setTab] = useState<TabKey>('prehled');
  const hasData = positions.filter(p => p.ticker !== 'CASH').length > 0;

  if (isLoading) return <PageSkeleton />;

  if (!hasData) {
    return (
      <div className="min-h-screen bg-background p-4 sm:p-6">
        <div className="max-w-3xl mx-auto py-8 sm:py-12 space-y-6">
          <Card className="p-8 text-center space-y-5">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/10 text-primary mx-auto">
              <TrendingUp className="w-7 h-7" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Vítej v Portfolio Trackeru</h1>
              <p className="text-sm text-muted-foreground mt-2">
                Začni jedním ze tří způsobů: napoj Trading 212, nahraj výpis (XTB / Revolut), nebo přidej obchod ručně.
                Jakmile budeš mít data, ukáže se ti celá nástěnka.
              </p>
            </div>
            <div className="flex items-center justify-center gap-2 flex-wrap">
              <QuickTradeDialog />
              <Button variant="ghost" size="sm" onClick={signOut} className="text-muted-foreground">
                <LogOut className="w-3 h-3 mr-1.5" /> Odhlásit {user?.email}
              </Button>
            </div>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <BrokerConnect />
            <StatementImport />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6">
        <PortfolioHeader />

        <MarketTicker />

        {/* Section tabs — the page grew too long as one scroll */}
        <div className="sticky top-0 z-20 -mx-4 sm:-mx-6 px-4 sm:px-6 py-2 bg-background/85 backdrop-blur border-b border-border/60">
          <div className="flex gap-1 overflow-x-auto">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`px-4 py-2 text-sm font-semibold rounded-lg whitespace-nowrap transition-all ${
                  tab === t.key
                    ? 'bg-primary text-primary-foreground shadow-md shadow-primary/20'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent/60'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {tab === 'prehled' && (
          <div className="space-y-6">
            <PortfolioMetrics />
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2"><PerformanceChart /></div>
              <div className="space-y-6">
                <FearGreedIndex />
                <PortfolioGoal />
              </div>
            </div>
            <PortfolioHeatmap />
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <AllocationChart />
              <SectorAllocation />
            </div>
            <TopMovers />
          </div>
        )}

        {tab === 'pozice' && (
          <div className="space-y-6">
            <RankedPositions />
            <HoldingsTable />
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <ProfitByStock />
              <DailyChangeChart />
            </div>
            <Watchlist />
          </div>
        )}

        {tab === 'historie' && (
          <div className="space-y-6">
            <PortfolioPerformanceChart />
            <YearlyGrowth />
            <MonthComparison />
            <ClosedPositions />
            <TransactionHistory />
            <DailyPortfolioLog />
          </div>
        )}

        {tab === 'dane' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <DividendTracker />
              <EarningsCalendar />
            </div>
            <TaxReport />
          </div>
        )}

        {tab === 'import' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <StatementImport />
            <BrokerConnect />
          </div>
        )}
      </div>
    </div>
  );
};

export default Index;
