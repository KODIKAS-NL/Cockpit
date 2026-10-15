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
  | 'collapse'
  | 'download'
  | 'info'
  | 'remote'
  | 'reload'
  | 'edit'
  | 'terminal'
  | 'file'
  | 'globe'
  | 'search'
  | 'diamond'
  | 'plan';

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
  // A cog (gear outline with a hub), not rays.
  settings: (
    <>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  // Unfold / fold: two chevrons pointing away from / toward each other.
  expand: <path d="m7 15 5 5 5-5M7 9l5-5 5 5" />,
  collapse: <path d="m7 20 5-5 5 5M7 4l5 5 5-5" />,
  // Arrow down into a tray: save / export.
  download: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
  // Circled "i": the details of a session.
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  // A phone: remote control from your phone.
  remote: (
    <>
      <rect x="7" y="2.5" width="10" height="19" rx="2" />
      <path d="M11 18h2" />
    </>
  ),
  // Circular arrow: reload the view.
  reload: <path d="M20 12a8 8 0 1 1-2.5-5.8M20 4v5h-5" />,
  // Pencil: rename.
  edit: <path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" />,
  terminal: <path d="M4 17l6-6-6-6M12 19h8" />,
  file: <path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8l-4-5zM14 3v5h4" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9S14.5 18.3 12 21c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.2-4.2" />
    </>
  ),
  // A generic tool.
  diamond: <path d="M12 3l9 9-9 9-9-9 9-9z" />,
  // A list: a plan.
  plan: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />,
};

export function Icon({ name, size = 12 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="hub-icon"
      width={size}
      height={size}
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
