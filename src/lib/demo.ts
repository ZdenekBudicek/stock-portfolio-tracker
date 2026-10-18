/** True only in the static demo build (`npm run build:demo` → vite --mode demo). */
export const IS_DEMO = import.meta.env.MODE === "demo";
