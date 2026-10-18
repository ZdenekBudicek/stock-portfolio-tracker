import { useState } from "react";
import { FlaskConical, X } from "lucide-react";
import { useTranslation } from "react-i18next";

/** Slim strip on top of the demo build: says the numbers are invented. */
const DemoBanner = () => {
  const [open, setOpen] = useState(true);
  const en = useTranslation().i18n.language === "en";
  if (!open) return null;
  return (
    <div className="relative z-30 border-b border-primary/20 bg-primary/10 text-[11px] sm:text-xs text-muted-foreground">
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-1.5 flex items-center gap-2">
        <FlaskConical className="w-3.5 h-3.5 text-primary shrink-0" />
        <span className="font-bold tracking-wide text-primary whitespace-nowrap">{en ? "DEMO · sample data" : "DEMO · smyšlená data"}</span>
        <span className="hidden sm:inline truncate">
          {en
            ? "— the real app syncs Trading 212 via its API and imports XTB and Revolut statements."
            : "— ostrá aplikace synchronizuje Trading 212 přes API a importuje výpisy z XTB a Revolutu."}
        </span>
        <button
          onClick={() => setOpen(false)}
          className="ml-auto p-0.5 rounded hover:bg-primary/15 hover:text-foreground transition-colors"
          aria-label={en ? "Hide bar" : "Skrýt lištu"}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};

export default DemoBanner;
