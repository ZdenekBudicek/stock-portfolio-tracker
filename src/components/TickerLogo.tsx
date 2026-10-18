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

const DIM: Record<LogoSize, string> = {
  xs: 'w-5 h-5 rounded-md text-[7px]',
  sm: 'w-8 h-8 rounded-lg text-[10px]',
  md: 'w-10 h-10 rounded-xl text-[11px]',
  lg: 'w-12 h-12 rounded-2xl text-xs',
  xl: 'w-16 h-16 rounded-[20px] text-sm',
};
type LogoSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

// Company logo everywhere a ticker is shown: tries free logo sources, falls back to a colored
// ticker tile. Keyed by ticker so a reused instance never keeps another ticker's failure state.
export const TickerLogo = (props: { ticker: string; size?: LogoSize; className?: string }) => (
  <TickerLogoInner key={props.ticker.toUpperCase()} {...props} />
);

const TickerLogoInner = ({ ticker, size = 'md', className = '' }: { ticker: string; size?: LogoSize; className?: string }) => {
  const t = ticker.toUpperCase();
  const sources = CRYPTO_LOGOS[t]
    ? [CRYPTO_LOGOS[t]]
    : [
        // Vector first: Parqet's SVGs are full-bleed brand squares (sharp at any size). A ticker
        // without a vector answers the SVG request with a PNG — size=256 makes that one sharp too.
        // Some tickers come back as a small PNG or 404 — then the 256 px PNG, then FMP.
        `https://assets.parqet.com/logos/symbol/${t}?format=svg&size=256`,
        `https://assets.parqet.com/logos/symbol/${t}?format=png&size=256`,
        `https://financialmodelingprep.com/image-stock/${t}.png`,
      ];
  const [idx, setIdx] = useState(0);
  const [failed, setFailed] = useState(false);
  const dim = `${DIM[size]} shrink-0 ${className}`;

  if (failed) {
    return (
      <div
        className={`${dim} flex items-center justify-center font-display font-bold text-white shadow-md ring-1 ring-white/10 transition-transform group-hover/link:scale-105`}
        style={{ background: `linear-gradient(135deg, ${tickerColor(t)}, ${tickerColor(t + 'x')})` }}
      >
        {t.slice(0, 4)}
      </div>
    );
  }

  return (
    // No background on the frame: a white frame behind a full-bleed logo leaked a white hairline
    // around the rounded corners. The white sits on the image itself (only visible through a
    // transparent PNG) and is clipped together with it.
    <div className={`${dim} overflow-hidden flex items-center justify-center transition-transform group-hover/link:scale-105`}>
      <img
        src={sources[idx]}
        alt={t}
        loading="lazy"
        decoding="async"
        draggable={false}
        className="block w-full h-full object-cover bg-white"
        onError={() => {
          if (idx + 1 < sources.length) setIdx(idx + 1);
          else setFailed(true);
        }}
      />
    </div>
  );
};
