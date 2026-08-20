export const designTokens = {
  radius: {
    card: "1rem",
    button: "0.75rem",
  },
  spacing: {
    page: "2rem",
    section: "1.5rem",
  },
  typography: {
    title: "text-3xl font-semibold tracking-tight",
    subtitle: "text-sm text-muted-foreground",
  },
} as const;

export type DesignTokens = typeof designTokens;
