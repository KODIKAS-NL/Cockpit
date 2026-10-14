// Small monochrome line icons for the hub's pill buttons. They take their color from the text
// (currentColor), so they follow the theme where the emoji they replace did not.
import type { ReactElement } from 'react';

export type IconName =
  | 'usage'
  | 'signOut'
  | 'signIn'
  | 'plugins'
  | 'mcp'
  | 'skills'
  | 'vault'
  | 'settings'
  | 'plus'
  | 'trash'
  | 'expand'
  | 'collapse';

const PATHS: Record<IconName, ReactElement> = {
  usage: <path d="M3 21h18M6 17v-5M11 17V6M16 17v-8M21 17v-3" />,
  signOut: <path d="M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h5M15 8l4 4-4 4M19 12H9" />,
  signIn: <path d="M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5M9 8l-4 4 4 4M5 12h10" />,
  plugins: <path d="M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0V7zM12 16v5" />,
  mcp: <path d="M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 5l-3 14" />,
  skills: <path d="M12 3l2.4 5.6L20 11l-5.6 2.4L12 19l-2.4-5.6L4 11l5.6-2.4L12 3z" />,
  vault: (
    <>
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  // Unfold / fold: two chevrons pointing away from / toward each other.
  expand: <path d="m7 15 5 5 5-5M7 9l5-5 5 5" />,
  collapse: <path d="m7 20 5-5 5 5M7 4l5 5 5-5" />,
  trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />,
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className="hub-icon"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
