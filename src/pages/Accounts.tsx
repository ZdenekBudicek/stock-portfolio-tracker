// Import, účty a hotovost — broker connection, statement import, cash and exports.
import BrokerConnect from '@/components/BrokerConnect';
import { lazy, Suspense } from 'react';
import CashAdjustDialog from '@/components/CashAdjustDialog';
import ExportMenu from '@/components/ExportMenu';
import QuickTradeDialog from '@/components/QuickTradeDialog';
import { useTranslation } from 'react-i18next';
import { PageTitle } from '@/components/v2/ui';

const StatementImport = lazy(() => import('@/components/StatementImport'));

const Accounts = () => {
  const { t } = useTranslation();
  return (
  <div>
    <PageTitle
      eyebrow={t('accounts.eyebrow')}
      title={t('accounts.title')}
      right={<div className="flex flex-wrap items-center gap-2"><QuickTradeDialog /><CashAdjustDialog /><ExportMenu /></div>}
    />
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <BrokerConnect />
      <Suspense fallback={<div role="status">{t('common.loading')}</div>}><StatementImport /></Suspense>
    </div>
  </div>
  );
};

export default Accounts;
