try {
  const theme = localStorage.getItem("matchplane.theme");
  if (theme === "dark") {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.classList.add("dark");
    document.documentElement.style.colorScheme = "dark";
  }
  const locale = localStorage.getItem("matchplane.locale");
  if (locale === "en") document.documentElement.lang = "en";
} catch {
  // Storage may be disabled; server-rendered defaults remain usable.
}
