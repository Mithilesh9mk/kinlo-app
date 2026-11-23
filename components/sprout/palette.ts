// Sprout palette (docs/CHARACTER_PLAN.md section 4).
export const sproutPalette = {
  bodyBase: '#2F9E55',
  bodyLight: '#5CC47A',
  bodyDeep: '#166534',
  /** Faintest outline / shadow accents only. */
  outline: '#004C22',
  /** Slightly darker than base, for leaves sitting behind the front one (tree canopy). */
  bodyBack: '#278A49',
  highlight: '#FFFFFF',
  highlightOpacity: 0.4,
  eye: '#0B2A16',
  terracotta: '#D85A30',
  blossomCenter: '#FFE3C2',
  soil: '#B07A52',
  soilDark: '#8C5C3C',
  shadow: '#000000',
  shadowOpacity: 0.12,
} as const;

export type SproutPalette = typeof sproutPalette;
