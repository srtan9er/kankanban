export const SKINS = ['light','dark'] as const;
export type SkinId = typeof SKINS[number];
export function isSkin(value:unknown):value is SkinId { return (SKINS as readonly unknown[]).includes(value); }
