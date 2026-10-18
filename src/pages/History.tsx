// Výnosy › Historie — the detailed history views kept from the previous layout.
import PortfolioPerformanceChart from '@/components/PortfolioPerformanceChart';
import YearlyGrowth from '@/components/YearlyGrowth';
import MonthComparison from '@/components/MonthComparison';
import ClosedPositions from '@/components/ClosedPositions';
import TransactionHistory from '@/components/TransactionHistory';
import DailyPortfolioLog from '@/components/DailyPortfolioLog';
import { useTranslation } from 'react-i18next';
import { PageTitle } from '@/components/v2/ui';

const History = () => {
  const { t } = useTranslation();
  return (
  <div>
    <PageTitle back={{ to: '/vynosy', label: t('nav.returns') }} title={t('history.title')} />
    <div className="space-y-4">
      <TransactionHistory />
      <YearlyGrowth />
      <MonthComparison />
      <PortfolioPerformanceChart />
      <ClosedPositions />
      <DailyPortfolioLog />
    </div>
  </div>
  );
};

export default History;
