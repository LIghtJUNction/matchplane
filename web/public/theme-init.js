try {
  const theme = localStorage.getItem("matchplane.theme");
  if (theme === "dark") {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.classList.add("dark");
    document.documentElement.style.colorScheme = "dark";
  }
  const palette = localStorage.getItem("matchplane.palette");
  document.documentElement.dataset.palette = [
    "ink",
    "moss",
    "clay",
    "plum",
    "amber",
  ].includes(palette)
    ? palette
    : "ink";
  const textSize = localStorage.getItem("matchplane.text-size");
  document.documentElement.dataset.textSize = ["small", "default", "large"].includes(
    textSize,
  )
    ? textSize
    : "default";
  const locale = localStorage.getItem("matchplane.locale");
  if (locale === "en") document.documentElement.lang = "en";
} catch {
  // Storage may be disabled; server-rendered defaults remain usable.
}
