import { useState } from 'react';

// Deterministic ticker color from string hash (fallback when no logo)
export const tickerColor = (t: string) => {
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 70% 55%)`;
};

// Crypto tickers handled separately via CoinGecko
const CRYPTO_LOGOS: Record<string, string> = {
  BTC: 'https://assets.coingecko.com/coins/images/1/large/bitcoin.png',
  ETH: 'https://assets.coingecko.com/coins/images/279/large/ethereum.png',
  SOL: 'https://assets.coingecko.com/coins/images/4128/large/solana.png',
  ADA: 'https://assets.coingecko.com/coins/images/975/large/cardano.png',
  DOGE: 'https://assets.coingecko.com/coins/images/5/large/dogecoin.png',
  XRP: 'https://assets.coingecko.com/coins/images/44/large/xrp-symbol-white-128.png',
  AVAX: 'https://assets.coingecko.com/coins/images/12559/large/Avalanche_Circle_RedWhite_Trans.png',
  DOT: 'https://assets.coingecko.com/coins/images/12171/large/polkadot.png',
  LINK: 'https://assets.coingecko.com/coins/images/877/large/chainlink-new-logo.png',
  MATIC: 'https://assets.coingecko.com/coins/images/4713/large/polygon.png',
};

// Auto logo: tries multiple free sources, falls back to colored ticker tile.
// Shared by HoldingsTable and RankedPositions.
export const TickerLogo = ({ ticker, size = 'md' }: { ticker: string; size?: 'sm' | 'md' }) => {
  const t = ticker.toUpperCase();
  const sources = CRYPTO_LOGOS[t]
    ? [CRYPTO_LOGOS[t]]
    : [
        `https://assets.parqet.com/logos/symbol/${t}?format=png`,
        `https://financialmodelingprep.com/image-stock/${t}.png`,
      ];
  const [idx, setIdx] = useState(0);
  const [failed, setFailed] = useState(false);
  const dim = size === 'sm' ? 'w-8 h-8 rounded-lg' : 'w-10 h-10 rounded-xl';

  if (failed) {
    return (
      <div
        className={`${dim} flex items-center justify-center font-display font-bold text-[11px] text-white shadow-md ring-1 ring-white/10 transition-transform group-hover/link:scale-105`}
        style={{ background: `linear-gradient(135deg, ${tickerColor(t)}, ${tickerColor(t + 'x')})` }}
      >
        {t.slice(0, 4)}
      </div>
    );
  }

  return (
    <div className={`${dim} overflow-hidden flex items-center justify-center transition-transform group-hover/link:scale-105`}>
      <img
        src={sources[idx]}
        alt={t}
        loading="lazy"
        className="w-full h-full object-cover"
        onError={() => {
          if (idx + 1 < sources.length) setIdx(idx + 1);
          else setFailed(true);
        }}
      />
    </div>
  );
};
