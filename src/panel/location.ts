// Where a conversation is shown. A conversation lives in exactly one place, the side bar chat or
// an editor tab, never both (the official extension does not mirror one either, and showing it
// twice would double the streaming and replay work). Pure so the rule can be tested on its own.

export type Surface = 'sidebar' | 'editor';

export interface LocationInput {
  /** The `cockpitDaemon.preferredLocation` setting: where a conversation with no place yet goes. */
  preferred: Surface;
  /** An explicit request ("open in editor tab", "move to side bar") overrides everything. */
  explicit?: Surface;
  inEditor: boolean;
  inSidebar: boolean;
}

export function chooseLocation(i: LocationInput): Surface {
  if (i.explicit) return i.explicit;
  if (i.inEditor) return 'editor';
  if (i.inSidebar) return 'sidebar';
  return i.preferred;
}
