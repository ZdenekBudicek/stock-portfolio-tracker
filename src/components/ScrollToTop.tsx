// A new page opens at the top. React Router keeps the window's scroll position across route
// changes, so opening a company from a scrolled list showed its detail half-way down.
// Back/forward (POP) is left alone so the browser can return to where the user was.
import { useLayoutEffect } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

export default function ScrollToTop() {
  const { pathname } = useLocation();
  const nav = useNavigationType();
  useLayoutEffect(() => {
    if (nav !== 'POP') window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
  }, [pathname, nav]);
  return null;
}
