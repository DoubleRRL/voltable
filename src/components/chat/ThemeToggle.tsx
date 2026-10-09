"use client";

import { useCallback, useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";

const STORAGE_KEY = "esr-theme";
type Theme = "light" | "dark";

/**
 * The theme lives in the DOM: the `.dark` class the library's dark palette
 * hangs off, set before first paint by the inline script in the root layout.
 * Reading it through `useSyncExternalStore` keeps the toggle honest with the
 * DOM — including a change made by another tab or by the OS setting — without
 * a mount effect that would render one theme and then correct it.
 */
const subscribe = (onChange: () => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style"],
  });
  return () => observer.disconnect();
};

const readTheme = (): Theme =>
  document.documentElement.classList.contains("dark") ? "dark" : "light";

/** Server render and the pre-hydration client render both see light. */
const readServerTheme = (): Theme => "light";

const applyTheme = (theme: Theme) => {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // A private-mode storage refusal is not worth failing the toggle over.
  }
};

export function ThemeToggle({ className }: { className?: string }) {
  const theme = useSyncExternalStore(subscribe, readTheme, readServerTheme);

  const toggle = useCallback(() => {
    applyTheme(readTheme() === "dark" ? "light" : "dark");
  }, []);

  const label = theme === "dark" ? "Switch to light" : "Switch to dark";

  return (
    <Tooltip content={label} side="bottom">
      <Button
        size="icon"
        variant="tertiary"
        type="button"
        onClick={toggle}
        aria-label={label}
        aria-pressed={theme === "dark"}
        className={className}
      >
        {theme === "dark" ? (
          <Sun size={16} strokeWidth={1.5} aria-hidden />
        ) : (
          <Moon size={16} strokeWidth={1.5} aria-hidden />
        )}
      </Button>
    </Tooltip>
  );
}

/** Applies the stored theme before first paint. Rendered inline in <head>. */
export const themeScript = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  STORAGE_KEY
)});if(!t){t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}if(t==="dark"){document.documentElement.classList.add("dark");}document.documentElement.style.colorScheme=t;}catch(e){}})();`;
