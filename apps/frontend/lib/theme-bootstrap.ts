export const THEME_BOOTSTRAP_SCRIPT = String.raw`
(() => {
  const root = document.documentElement;
  let stored = null;
  try {
    stored = window.localStorage.getItem("packscout.theme");
  } catch {}
  const theme = stored === "light" || stored === "dark"
    ? stored
    : window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "dark" ? "#030b13" : "#f8f9fc");
})();
`;
