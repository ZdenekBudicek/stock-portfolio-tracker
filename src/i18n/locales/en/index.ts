// en dictionary — areas merged into one namespace. legacy.ts belongs to the older components.
import core from "./core";
import pages from "./pages";
import legacy from "./legacy";
import residence from "./residence";

export default { ...core, ...pages, ...residence, legacy };
