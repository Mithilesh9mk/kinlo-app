/** @type {import('tailwindcss').Config} */
module.exports = {
  // NOTE: Update this to include the paths to all of your component files.
  content: ["./app/**/*.{js,jsx,ts,tsx}", "./components/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      // Type scale, small end: 10 (micro: pills, badges, uppercase labels) and
      // 12 (caption: metadata). Everything above is Tailwind's own xs..3xl.
      // Additive: nothing reads these until screens are migrated.
      fontSize: {
        micro: '10px',
        caption: '12px',
      },
      colors: {
        "surface": "#fcf9f4",
        "secondary-container": "#caead6",
        "surface-tint": "#1f6c3a",
        "on-secondary-container": "#4e6b5a",
        "surface-bright": "#fcf9f4",
        "on-primary": "#ffffff",
        "inverse-primary": "#8bd79b",
        "outline-variant": "#bfc9bd",
        "on-surface": "#1c1c19",
        "on-tertiary": "#ffffff",
        "error-container": "#ffdad6",
        "inverse-surface": "#31302d",
        "surface-container-high": "#ebe8e3",
        "tertiary": "#074b26",
        "surface-container-low": "#f6f3ee",
        "error": "#ba1a1a",
        "on-surface-variant": "#404940",
        "on-error-container": "#93000a",
        "surface-container": "#f0ede9",
        "surface-container-highest": "#e5e2dd",
        "surface-container-lowest": "#ffffff",
        "tertiary-container": "#27633b",
        "primary-fixed-dim": "#8bd79b",
        "surface-dim": "#dcdad5",
        "on-primary-container": "#93e0a2",
        "surface-variant": "#e5e2dd",
        "primary-fixed": "#a6f4b5",
        "inverse-on-surface": "#f3f0eb",
        "on-error": "#ffffff",
        "outline": "#707a6f",
        "primary-container": "#166534",
        "background": "#fcf9f4",
        "secondary": "#486554",
        "primary": "#004c22",
        "on-tertiary-container": "#9dddab",
        "on-secondary": "#ffffff",
        "on-background": "#1c1c19"
      }
    },
  },
  plugins: [],
}
